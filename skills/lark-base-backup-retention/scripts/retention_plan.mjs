#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { isMainModule } from "../../_shared/is-main.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BACKUP_CLASSES = new Set(["daily", "pre-change", "post-change", "drill-source"]);
const ARTIFACT_KINDS = new Set(["full-base-export", "logical-data-snapshot"]);
const ACQUISITION_ROUTES = new Set(["api-full-base-export", "browser-full-base-export", "api-logical-snapshot"]);
const RESTORE_SCOPES = new Set(["full-base", "logical-data"]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredText(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} is required`);
  return value.trim();
}

function nonnegativeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer`);
  return value;
}

function positiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function timestamp(value, label) {
  const normalized = requiredText(value, label);
  assert(Number.isFinite(Date.parse(normalized)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized), `${label} must be an RFC3339 timestamp`);
  return normalized;
}

function calendarDate(value, label) {
  const normalized = requiredText(value, label);
  const match = ISO_DATE.exec(normalized);
  assert(match, `${label} must use YYYY-MM-DD`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  assert(
    date.getUTCFullYear() === Number(year)
      && date.getUTCMonth() === Number(month) - 1
      && date.getUTCDate() === Number(day),
    `${label} is not a valid calendar date`,
  );
  return normalized;
}

function localCalendarDate(timestampValue, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestampValue));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new TypeError("timezone must be a valid IANA timezone");
  }
}

function dateOrdinal(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / (24 * 60 * 60 * 1000));
}

function monthOrdinal(date) {
  const [year, month] = date.split("-").map(Number);
  return year * 12 + month - 1;
}

function backupReceiptCore(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "verified pair receipt must be an object");
  assert(value.version === 1, "backup receipt version must be 1");
  assert(value.status === "verified", "backup receipt status must be verified");
  const baseAlias = requiredText(value.base_alias, "receipt.base_alias");
  const schemaSha256 = requiredText(value.schema_sha256, "receipt.schema_sha256");
  assert(SHA256.test(schemaSha256), "receipt.schema_sha256 is invalid");
  const backupClass = requiredText(value.backup_class, "receipt.backup_class");
  assert(BACKUP_CLASSES.has(backupClass), "receipt.backup_class is invalid");
  const periodKey = calendarDate(value.period_key, "receipt.period_key");
  const artifactKind = requiredText(value.artifact_kind, "receipt.artifact_kind");
  assert(ARTIFACT_KINDS.has(artifactKind), "receipt.artifact_kind is invalid");
  const acquisitionRoute = requiredText(value.acquisition_route, "receipt.acquisition_route");
  assert(ACQUISITION_ROUTES.has(acquisitionRoute), "receipt.acquisition_route is invalid");
  const restoreScope = requiredText(value.restore_scope, "receipt.restore_scope");
  assert(RESTORE_SCOPES.has(restoreScope), "receipt.restore_scope is invalid");
  assert(
    (artifactKind === "full-base-export") === (restoreScope === "full-base"),
    "receipt artifact_kind and restore_scope are inconsistent",
  );
  const artifactBytes = positiveInteger(value.artifact_bytes, "receipt.artifact_bytes");
  const artifactSha256 = requiredText(value.artifact_sha256, "receipt.artifact_sha256");
  assert(SHA256.test(artifactSha256), "receipt.artifact_sha256 is invalid");
  const completedAt = timestamp(value.completed_at, "receipt.completed_at");
  const verifiedAt = timestamp(value.verified_at, "receipt.verified_at");
  assert(Date.parse(verifiedAt) >= Date.parse(completedAt), "receipt.verified_at cannot precede completed_at");
  return {
    version: 1,
    status: "verified",
    base_alias: baseAlias,
    schema_sha256: schemaSha256,
    backup_class: backupClass,
    period_key: periodKey,
    artifact_kind: artifactKind,
    acquisition_route: acquisitionRoute,
    restore_scope: restoreScope,
    artifact_bytes: artifactBytes,
    artifact_sha256: artifactSha256,
    completed_at: completedAt,
    verified_at: verifiedAt,
  };
}

export function calculateBackupReceiptSha256(value) {
  return sha256(stableStringify(backupReceiptCore(value)));
}

function normalizeVerifiedReceipt(value, baseAlias) {
  const core = backupReceiptCore(value);
  assert(core.base_alias === baseAlias, "verified pair receipt belongs to another Base alias");
  const receiptSha256 = requiredText(value.receipt_sha256, "receipt.receipt_sha256");
  assert(SHA256.test(receiptSha256), "receipt.receipt_sha256 is invalid");
  assert(calculateBackupReceiptSha256(core) === receiptSha256, "receipt SHA-256 does not match receipt content");
  return { ...core, receipt_sha256: receiptSha256 };
}

function normalizePolicy(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "policy is required");
  assert(value.protect_pre_change_until_released === true, "policy must protect unreleased pre-change backups");
  assert(value.protect_last_verified === true, "policy must protect the last verified backup");
  assert(value.protect_successful_drill_sources === true, "policy must protect successful recovery-drill sources");
  return {
    daily_days: positiveInteger(value.daily_days, "policy.daily_days"),
    monthly_months: positiveInteger(value.monthly_months, "policy.monthly_months"),
    protect_pre_change_until_released: true,
    protect_last_verified: true,
    protect_successful_drill_sources: true,
  };
}

function addUniqueObjectRef(refs, value, label) {
  const objectRef = requiredText(value, label);
  assert(!refs.has(objectRef), `storage object reference is duplicated: ${label}`);
  refs.add(objectRef);
  return objectRef;
}

function normalizeVerifiedPair(value, index, baseAlias, refs) {
  assert(value && typeof value === "object" && !Array.isArray(value), `verified_pairs.${index} must be an object`);
  assert(typeof value.pre_change_released === "boolean", `verified_pairs.${index}.pre_change_released must be boolean`);
  assert(typeof value.successful_drill_referenced === "boolean", `verified_pairs.${index}.successful_drill_referenced must be boolean`);
  const artifactObjectRef = addUniqueObjectRef(refs, value.artifact_object_ref, `verified_pairs.${index}.artifact_object_ref`);
  const receiptObjectRef = addUniqueObjectRef(refs, value.receipt_object_ref, `verified_pairs.${index}.receipt_object_ref`);
  const receipt = normalizeVerifiedReceipt(value.receipt, baseAlias);
  const artifactBytes = positiveInteger(value.artifact_bytes, `verified_pairs.${index}.artifact_bytes`);
  assert(artifactBytes === receipt.artifact_bytes, `verified_pairs.${index}.artifact_bytes does not match receipt`);
  return {
    artifact_object_ref: artifactObjectRef,
    receipt_object_ref: receiptObjectRef,
    artifact_bytes: artifactBytes,
    receipt_bytes: positiveInteger(value.receipt_bytes, `verified_pairs.${index}.receipt_bytes`),
    pre_change_released: value.pre_change_released,
    successful_drill_referenced: value.successful_drill_referenced,
    receipt,
  };
}

function normalizeUnresolvedObject(value, index, group, refs) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${group}.${index} must be an object`);
  return {
    object_ref: addUniqueObjectRef(refs, value.object_ref, `${group}.${index}.object_ref`),
    bytes: nonnegativeInteger(value.bytes, `${group}.${index}.bytes`),
    kind: requiredText(value.kind, `${group}.${index}.kind`),
  };
}

function unsignedPlan(value) {
  const { plan_sha256: ignored, ...rest } = value;
  return rest;
}

export function calculateRetentionPlanSha256(value) {
  return sha256(stableStringify(unsignedPlan(value)));
}

function pairSummary(pair, reasons = undefined) {
  return {
    artifact_object_ref: pair.artifact_object_ref,
    receipt_object_ref: pair.receipt_object_ref,
    artifact_bytes: pair.artifact_bytes,
    receipt_bytes: pair.receipt_bytes,
    receipt_sha256: pair.receipt.receipt_sha256,
    backup_class: pair.receipt.backup_class,
    period_key: pair.receipt.period_key,
    verified_at: pair.receipt.verified_at,
    ...(reasons ? { reasons } : {}),
  };
}

export function buildRetentionPlan(state) {
  assert(state && typeof state === "object" && !Array.isArray(state), "retention state must be an object");
  assert(state.version === 1, "retention state version must be 1");
  const observedAt = timestamp(state.observed_at, "observed_at");
  const observedAtMs = Date.parse(observedAt);
  const timezone = requiredText(state.timezone, "timezone");
  const currentDate = localCalendarDate(observedAt, timezone);
  const currentDateOrdinal = dateOrdinal(currentDate);
  const currentMonthOrdinal = monthOrdinal(currentDate);
  const baseAlias = requiredText(state.base_alias, "base_alias");
  const policy = normalizePolicy(state.policy);
  assert(state.successful_drill_references_complete === true, "successful recovery-drill reference coverage must be complete");
  assert(Array.isArray(state.verified_pairs), "verified_pairs must be an array");
  assert(Array.isArray(state.orphans), "orphans must be an array");
  assert(Array.isArray(state.invalid_receipts), "invalid_receipts must be an array");

  const refs = new Set();
  const verifiedPairs = state.verified_pairs.map((value, index) => normalizeVerifiedPair(value, index, baseAlias, refs));
  const orphans = state.orphans.map((value, index) => normalizeUnresolvedObject(value, index, "orphans", refs));
  const invalidReceipts = state.invalid_receipts.map((value, index) => normalizeUnresolvedObject(value, index, "invalid_receipts", refs));

  for (const [index, pair] of verifiedPairs.entries()) {
    assert(Date.parse(pair.receipt.verified_at) <= observedAtMs, `verified_pairs.${index}.receipt.verified_at is in the future`);
    assert(dateOrdinal(pair.receipt.period_key) <= currentDateOrdinal, `verified_pairs.${index}.receipt.period_key is in the future`);
  }

  const orderedPairs = [...verifiedPairs].sort((left, right) =>
    Date.parse(right.receipt.verified_at) - Date.parse(left.receipt.verified_at)
      || left.receipt.receipt_sha256.localeCompare(right.receipt.receipt_sha256));
  const keepReasons = new Map(orderedPairs.map((pair) => [pair, new Set()]));
  const addReason = (pair, reason) => keepReasons.get(pair).add(reason);

  if (orderedPairs[0]) addReason(orderedPairs[0], "last-verified");

  for (const pair of orderedPairs) {
    const dayAge = currentDateOrdinal - dateOrdinal(pair.receipt.period_key);
    if (pair.receipt.backup_class === "daily" && dayAge < policy.daily_days) {
      addReason(pair, "recent-daily");
    }
    if (pair.receipt.backup_class === "pre-change" && !pair.pre_change_released) {
      addReason(pair, "protected-pre-change");
    }
    if (pair.successful_drill_referenced) {
      addReason(pair, "successful-drill-source");
    }
  }

  const monthlyRepresentatives = new Map();
  for (const pair of orderedPairs) {
    if (pair.receipt.backup_class !== "daily") continue;
    const monthsOld = currentMonthOrdinal - monthOrdinal(pair.receipt.period_key);
    if (monthsOld < 0 || monthsOld >= policy.monthly_months) continue;
    const monthKey = pair.receipt.period_key.slice(0, 7);
    const selected = monthlyRepresentatives.get(monthKey);
    const isLaterPeriod = !selected || pair.receipt.period_key > selected.receipt.period_key;
    const isLaterVerification = selected
      && pair.receipt.period_key === selected.receipt.period_key
      && Date.parse(pair.receipt.verified_at) > Date.parse(selected.receipt.verified_at);
    const isDeterministicTieBreak = selected
      && pair.receipt.period_key === selected.receipt.period_key
      && pair.receipt.verified_at === selected.receipt.verified_at
      && pair.receipt.receipt_sha256 < selected.receipt.receipt_sha256;
    if (isLaterPeriod || isLaterVerification || isDeterministicTieBreak) monthlyRepresentatives.set(monthKey, pair);
  }
  for (const pair of monthlyRepresentatives.values()) addReason(pair, "monthly-representative");

  const keep = [];
  const deleteCandidates = [];
  for (const pair of orderedPairs) {
    const reasons = [...keepReasons.get(pair)].sort();
    if (reasons.length > 0) keep.push(pairSummary(pair, reasons));
    else deleteCandidates.push({ ...pairSummary(pair), reason: "expired-by-reviewed-policy" });
  }

  assert(verifiedPairs.length === 0 || keep.length > 0, "retention plan would leave no verified backup");
  const blockingIssues = [
    ...(verifiedPairs.length === 0 ? [{ code: "no-verified-backup", kind: "backup-set", bytes: 0 }] : []),
    ...orphans.map((item) => ({ code: "orphan-object", ...item })),
    ...invalidReceipts.map((item) => ({ code: "invalid-receipt", ...item })),
  ];
  const bytesProposed = deleteCandidates.reduce((sum, pair) => sum + pair.artifact_bytes + pair.receipt_bytes, 0);
  const protectedPairCount = keep.filter((pair) => pair.reasons.includes("protected-pre-change")).length;
  const drillReferencedCount = keep.filter((pair) => pair.reasons.includes("successful-drill-source")).length;
  const readyForReview = deleteCandidates.length > 0 && blockingIssues.length === 0;

  const unsigned = {
    version: 1,
    plan_type: "lark-base-backup-retention",
    observed_at: new Date(observedAtMs).toISOString(),
    timezone,
    base_alias: baseAlias,
    policy,
    successful_drill_references_complete: true,
    keep,
    delete_candidates: deleteCandidates,
    blocking_issues: blockingIssues,
    summary: {
      verified_pair_count: verifiedPairs.length,
      orphan_count: orphans.length,
      invalid_receipt_count: invalidReceipts.length,
      protected_pair_count: protectedPairCount,
      drill_referenced_count: drillReferencedCount,
      keep_pair_count: keep.length,
      delete_pair_count: deleteCandidates.length,
      delete_object_count: deleteCandidates.length * 2,
      bytes_proposed: bytesProposed,
      blocking_count: blockingIssues.length,
      ready_for_review: readyForReview,
      unattended_delete_count: 0,
    },
  };
  return { ...unsigned, plan_sha256: calculateRetentionPlanSha256(unsigned) };
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
  const plan = buildRetentionPlan(state);
  await writePrivateJson(path.resolve(args.output), plan);
  process.stdout.write(`${JSON.stringify({
    status: "success",
    mode: "lark-base-backup-retention-plan",
    plan_sha256: plan.plan_sha256,
    ...plan.summary,
  })}\n`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
