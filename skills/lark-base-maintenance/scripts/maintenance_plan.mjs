#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { isMainModule } from "../../_shared/is-main.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FUTURE_MARGIN_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;

export const COMPACTION_SKILLS = Object.freeze([
  "creator-profile-compaction",
  "creator-live-history-compaction",
  "creator-live-metrics-compaction",
  "creator-invitation-status-compaction",
]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value));
}

function unsignedPlan(plan) {
  const { plan_sha256: ignored, ...rest } = plan;
  return rest;
}

export function calculateMaintenancePlanSha256(plan) {
  return crypto.createHash("sha256").update(stableStringify(unsignedPlan(plan))).digest("hex");
}

function text(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} is required`);
  return value.trim();
}

function nonnegativeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer`);
  return value;
}

function positiveNumber(value, label) {
  assert(Number.isFinite(value) && value > 0, `${label} must be positive`);
  return value;
}

function timestampMs(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  assert(typeof value === "string" && value.trim(), `${label} must be an RFC3339 timestamp`);
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${label} must be an RFC3339 timestamp`);
  return parsed;
}

function due(lastAtMs, intervalMs, observedAtMs) {
  return lastAtMs === null || observedAtMs - lastAtMs >= intervalMs;
}

function calendarDate(timestamp, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new TypeError("timezone must be a valid IANA timezone");
  }
}

function normalizePolicy(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "policy is required");
  const warningRatio = positiveNumber(value.warning_ratio, "policy.warning_ratio");
  const criticalRatio = positiveNumber(value.critical_ratio, "policy.critical_ratio");
  assert(warningRatio < criticalRatio && criticalRatio <= 1, "capacity ratios must satisfy warning < critical <= 1");
  return {
    backup_max_age_hours: positiveNumber(value.backup_max_age_hours, "policy.backup_max_age_hours"),
    compaction_interval_days: positiveNumber(value.compaction_interval_days, "policy.compaction_interval_days"),
    retention_interval_days: positiveNumber(value.retention_interval_days, "policy.retention_interval_days"),
    recovery_drill_interval_days: positiveNumber(value.recovery_drill_interval_days, "policy.recovery_drill_interval_days"),
    warning_ratio: warningRatio,
    critical_ratio: criticalRatio,
  };
}

function receiptEvidence(receipt, base, observedAtMs) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  if (receipt.status !== "verified" || receipt.version !== 1) return null;
  if (receipt.base_alias !== base.alias || receipt.schema_sha256 !== base.schema_sha256) return null;
  if (!SHA256.test(String(receipt.artifact_sha256 ?? "")) || !SHA256.test(String(receipt.receipt_sha256 ?? ""))) return null;
  if (!Number.isSafeInteger(receipt.artifact_bytes) || receipt.artifact_bytes < 1) return null;
  const completedAtMs = Date.parse(receipt.completed_at);
  const verifiedAtMs = Date.parse(receipt.verified_at);
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(verifiedAtMs)) return null;
  if (completedAtMs > observedAtMs + FUTURE_MARGIN_MS || verifiedAtMs > observedAtMs + FUTURE_MARGIN_MS) return null;
  if (verifiedAtMs < completedAtMs) return null;
  return {
    backup_class: String(receipt.backup_class ?? ""),
    period_key: String(receipt.period_key ?? ""),
    artifact_kind: String(receipt.artifact_kind ?? ""),
    restore_scope: String(receipt.restore_scope ?? ""),
    artifact_bytes: receipt.artifact_bytes,
    artifact_sha256: receipt.artifact_sha256,
    receipt_sha256: receipt.receipt_sha256,
    completed_at: new Date(completedAtMs).toISOString(),
    completed_at_ms: completedAtMs,
    verified_at: new Date(verifiedAtMs).toISOString(),
  };
}

function latestBackup(receipts, base, observedAtMs, maxAgeMs, timezone) {
  const evidence = receipts.map((receipt) => receiptEvidence(receipt, base, observedAtMs)).filter(Boolean);
  evidence.sort((left, right) => right.completed_at_ms - left.completed_at_ms || left.receipt_sha256.localeCompare(right.receipt_sha256));
  const latest = evidence[0] ?? null;
  const periodKey = calendarDate(observedAtMs, timezone);
  const daily = evidence.find((item) => item.backup_class === "daily" && item.period_key === periodKey) ?? null;
  const latestFull = evidence.find((item) => item.restore_scope === "full-base") ?? null;
  const fresh = Boolean(daily && observedAtMs - daily.completed_at_ms <= maxAgeMs);
  const equivalentCount = daily
    ? evidence.filter((item) => item.backup_class === "daily"
      && item.period_key === daily.period_key
      && item.artifact_kind === daily.artifact_kind
      && item.restore_scope === daily.restore_scope
      && item.artifact_sha256 === daily.artifact_sha256).length
    : 0;
  return {
    latest,
    daily,
    latest_full: latestFull,
    period_key: periodKey,
    fresh,
    valid_count: evidence.length,
    invalid_count: receipts.length - evidence.length,
    equivalent_count: equivalentCount,
  };
}

function normalizeCompaction(value, tableAlias, observedAtMs) {
  if (value === null) {
    return {
      skill: null,
      status: "not-configured",
      last_dry_run_at: null,
      last_dry_run_at_ms: null,
    };
  }
  assert(value && typeof value === "object" && !Array.isArray(value), `tables.${tableAlias}.compaction is required`);
  const skill = text(value.skill, `tables.${tableAlias}.compaction.skill`);
  assert(COMPACTION_SKILLS.includes(skill), `tables.${tableAlias}.compaction.skill is unsupported`);
  const status = text(value.status, `tables.${tableAlias}.compaction.status`);
  assert(["not-run", "unchanged", "ready", "blocked"].includes(status), `tables.${tableAlias}.compaction.status is invalid`);
  const lastDryRunAtMs = timestampMs(value.last_dry_run_at, `tables.${tableAlias}.compaction.last_dry_run_at`, { nullable: true });
  if (lastDryRunAtMs !== null) assert(lastDryRunAtMs <= observedAtMs + FUTURE_MARGIN_MS, `tables.${tableAlias}.compaction.last_dry_run_at is in the future`);
  const normalized = {
    skill,
    status,
    last_dry_run_at: lastDryRunAtMs === null ? null : new Date(lastDryRunAtMs).toISOString(),
    last_dry_run_at_ms: lastDryRunAtMs,
  };
  if (status === "ready") {
    const builtAtMs = timestampMs(value.built_at, `tables.${tableAlias}.compaction.built_at`);
    assert(builtAtMs <= observedAtMs + FUTURE_MARGIN_MS, `tables.${tableAlias}.compaction.built_at is in the future`);
    assert(SHA256.test(String(value.plan_sha256 ?? "")), `tables.${tableAlias}.compaction.plan_sha256 is invalid`);
    const deleteCount = nonnegativeInteger(value.delete_candidate_count, `tables.${tableAlias}.compaction.delete_candidate_count`);
    assert(deleteCount > 0, `tables.${tableAlias}.compaction.delete_candidate_count must be positive when ready`);
    const blockingCount = nonnegativeInteger(value.blocking_count, `tables.${tableAlias}.compaction.blocking_count`);
    assert(blockingCount === 0, `tables.${tableAlias}.compaction.blocking_count must be zero when ready`);
    normalized.built_at = new Date(builtAtMs).toISOString();
    normalized.built_at_ms = builtAtMs;
    normalized.plan_sha256 = value.plan_sha256;
    normalized.delete_candidate_count = deleteCount;
    normalized.projected_record_count = nonnegativeInteger(value.projected_record_count, `tables.${tableAlias}.compaction.projected_record_count`);
    normalized.blocking_count = blockingCount;
  } else if (status === "blocked") {
    const blockingCount = nonnegativeInteger(value.blocking_count, `tables.${tableAlias}.compaction.blocking_count`);
    assert(blockingCount > 0, `tables.${tableAlias}.compaction.blocking_count must be positive when blocked`);
    normalized.blocking_count = blockingCount;
  }
  return normalized;
}

export function buildMaintenancePlan(state) {
  assert(state && typeof state === "object" && !Array.isArray(state), "maintenance state must be an object");
  assert(state.version === 1, "maintenance state version is invalid");
  const observedAtMs = timestampMs(state.observed_at, "observed_at");
  const timezone = text(state.timezone, "timezone");
  calendarDate(observedAtMs, timezone);
  const base = {
    alias: text(state.base?.alias, "base.alias"),
    schema_sha256: text(state.base?.schema_sha256, "base.schema_sha256"),
  };
  assert(SHA256.test(base.schema_sha256), "base.schema_sha256 is invalid");
  const policy = normalizePolicy(state.policy);
  assert(Array.isArray(state.backup_receipts), "backup_receipts must be an array");
  assert(Array.isArray(state.tables) && state.tables.length > 0, "tables must be a non-empty array");

  const backup = latestBackup(state.backup_receipts, base, observedAtMs, policy.backup_max_age_hours * HOUR_MS, timezone);
  const actions = [];
  if (!backup.fresh) {
    actions.push({ stage: 1, action: "check-or-create-backup", skill: "lark-base-backup", priority: "high" });
  }

  const aliases = new Set();
  const tablePlans = state.tables.map((table, index) => {
    const alias = text(table?.alias, `tables.${index}.alias`);
    assert(!aliases.has(alias), `table alias is duplicated: ${alias}`);
    aliases.add(alias);
    const recordCount = nonnegativeInteger(table.record_count, `tables.${alias}.record_count`);
    const recordLimit = nonnegativeInteger(table.record_limit, `tables.${alias}.record_limit`);
    assert(recordLimit > 0, `tables.${alias}.record_limit must be positive`);
    const compaction = normalizeCompaction(table.compaction, alias, observedAtMs);
    const utilizationRatio = recordCount / recordLimit;
    const capacityStatus = utilizationRatio >= 1
      ? "exhausted"
      : utilizationRatio >= policy.critical_ratio
        ? "critical"
        : utilizationRatio >= policy.warning_ratio
          ? "warning"
          : "healthy";
    const compactionDue = compaction.skill !== null
      && due(compaction.last_dry_run_at_ms, policy.compaction_interval_days * DAY_MS, observedAtMs);
    if (compaction.skill !== null && (compactionDue || capacityStatus !== "healthy")) {
      actions.push({
        stage: 2,
        action: "run-compaction-dry-run",
        skill: compaction.skill,
        table_alias: alias,
        priority: ["critical", "exhausted"].includes(capacityStatus) ? "high" : "normal",
      });
    } else if (compaction.skill === null && capacityStatus !== "healthy") {
      actions.push({
        stage: 2,
        action: "review-capacity-without-compaction",
        skill: null,
        table_alias: alias,
        priority: ["critical", "exhausted"].includes(capacityStatus) ? "high" : "normal",
      });
    }
    const reviewReady = compaction.status === "ready"
      && backup.latest_full
      && backup.latest_full.completed_at_ms >= compaction.built_at_ms;
    return {
      alias,
      record_count: recordCount,
      record_limit: recordLimit,
      utilization_ratio: Number(utilizationRatio.toFixed(6)),
      capacity_status: capacityStatus,
      compaction: {
        skill: compaction.skill,
        status: compaction.status,
        plan_sha256: compaction.plan_sha256 ?? null,
        delete_candidate_count: compaction.delete_candidate_count ?? 0,
        projected_record_count: compaction.projected_record_count ?? recordCount,
        blocking_count: compaction.blocking_count ?? 0,
        review_ready: reviewReady,
        requires_explicit_approval: compaction.status === "ready",
      },
    };
  });

  const retentionAtMs = timestampMs(state.retention?.last_planned_at ?? null, "retention.last_planned_at", { nullable: true });
  if (retentionAtMs !== null) assert(retentionAtMs <= observedAtMs + FUTURE_MARGIN_MS, "retention.last_planned_at is in the future");
  const retentionDue = due(retentionAtMs, policy.retention_interval_days * DAY_MS, observedAtMs);
  if (retentionDue) actions.push({ stage: 3, action: "run-retention-dry-run", skill: "lark-base-backup-retention", priority: "normal" });

  const drillAtMs = timestampMs(state.recovery_drill?.last_successful_at ?? null, "recovery_drill.last_successful_at", { nullable: true });
  if (drillAtMs !== null) assert(drillAtMs <= observedAtMs + FUTURE_MARGIN_MS, "recovery_drill.last_successful_at is in the future");
  const drillDue = due(drillAtMs, policy.recovery_drill_interval_days * DAY_MS, observedAtMs);
  if (drillDue) actions.push({ stage: 4, action: "run-recovery-drill-preflight", skill: "lark-base-disaster-recovery-drill", priority: "normal" });

  actions.sort((left, right) => left.stage - right.stage || left.action.localeCompare(right.action) || String(left.table_alias ?? "").localeCompare(String(right.table_alias ?? "")));
  const unsigned = {
    version: 1,
    plan_type: "lark-base-maintenance",
    observed_at: new Date(observedAtMs).toISOString(),
    timezone,
    base,
    policy,
    backup: {
      fresh: backup.fresh,
      valid_receipt_count: backup.valid_count,
      invalid_receipt_count: backup.invalid_count,
      equivalent_latest_count: backup.equivalent_count,
      required_daily_period_key: backup.period_key,
      current_daily_receipt_sha256: backup.daily?.receipt_sha256 ?? null,
      latest: backup.latest ? {
        backup_class: backup.latest.backup_class,
        period_key: backup.latest.period_key,
        artifact_kind: backup.latest.artifact_kind,
        restore_scope: backup.latest.restore_scope,
        artifact_bytes: backup.latest.artifact_bytes,
        artifact_sha256: backup.latest.artifact_sha256,
        receipt_sha256: backup.latest.receipt_sha256,
        completed_at: backup.latest.completed_at,
        verified_at: backup.latest.verified_at,
      } : null,
    },
    tables: tablePlans,
    retention: { due: retentionDue, last_planned_at: retentionAtMs === null ? null : new Date(retentionAtMs).toISOString() },
    recovery_drill: { due: drillDue, last_successful_at: drillAtMs === null ? null : new Date(drillAtMs).toISOString() },
    summary: {
      table_count: tablePlans.length,
      warning_table_count: tablePlans.filter((table) => table.capacity_status === "warning").length,
      critical_table_count: tablePlans.filter((table) => ["critical", "exhausted"].includes(table.capacity_status)).length,
      blocked_compaction_count: tablePlans.filter((table) => table.compaction.status === "blocked").length,
      unconfigured_compaction_table_count: tablePlans.filter((table) => table.compaction.status === "not-configured").length,
      capacity_without_compaction_count: tablePlans.filter((table) =>
        table.compaction.status === "not-configured" && table.capacity_status !== "healthy").length,
      compaction_review_count: tablePlans.filter((table) => table.compaction.review_ready).length,
      unattended_mutation_count: 0,
      action_count: actions.length,
    },
    actions,
  };
  return { ...unsigned, plan_sha256: calculateMaintenancePlanSha256(unsigned) };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const result = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert(key?.startsWith("--") && value !== undefined, `invalid argument: ${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

async function main(argv) {
  const args = parseArgs(argv);
  assert(args.command === "plan", "command must be plan");
  assert(args.input, "--input is required");
  assert(args.output, "--output is required");
  const state = await readPrivateJson(path.resolve(args.input));
  const plan = buildMaintenancePlan(state);
  await writePrivateJson(path.resolve(args.output), plan);
  process.stdout.write(`${JSON.stringify({
    status: "success",
    mode: "lark-base-maintenance-plan",
    plan_sha256: plan.plan_sha256,
    ...plan.summary,
    backup_fresh: plan.backup.fresh,
    retention_due: plan.retention.due,
    recovery_drill_due: plan.recovery_drill.due,
  })}\n`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
