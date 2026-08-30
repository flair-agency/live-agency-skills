#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LarkBaseClient } from "@live-agency-skills/lark-base-client";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FUTURE_CLOCK_MARGIN_MS = 5 * 60 * 1000;
const DELETE_BATCH_SIZE = 500;

export const RETENTION_POLICY = Object.freeze({
  timezone: "Asia/Tokyo",
  recent_days: 7,
  weekly_until_days: 30,
  monthly_until_days: 365,
  always_keep_oldest: true,
  always_keep_latest: true,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

export function calculateCompactionPlanSha256(plan) {
  return crypto.createHash("sha256").update(stableStringify(unsignedPlan(plan))).digest("hex");
}

export function isRecordId(value) {
  return /^rec[A-Za-z0-9]{7,}$/.test(String(value ?? ""));
}

export function linkedRecordIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry === "string" && isRecordId(entry)) ids.push(entry);
    if (entry && typeof entry === "object") {
      if (isRecordId(entry.record_id)) ids.push(entry.record_id);
      if (Array.isArray(entry.record_ids)) {
        for (const recordId of entry.record_ids) if (isRecordId(recordId)) ids.push(recordId);
      }
    }
  }
  return [...new Set(ids)];
}

export async function loadConfig(filePath) {
  assert(filePath, "--config is required");
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of ["appToken", "creatorTableId", "tableId"]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const fieldKeys = [
    "timestamp",
    "creator",
    "fanClub",
    "latestLiveAt",
    "liveDays30d",
    "liveHours30d",
    "likes30d",
  ];
  assert(raw.fieldIds && typeof raw.fieldIds === "object", "configuration fieldIds is required");
  const values = fieldKeys.map((key) => {
    const value = raw.fieldIds[key];
    assert(typeof value === "string" && value.trim(), `configuration fieldIds.${key} is required`);
    return value.trim();
  });
  assert(new Set(values).size === values.length, "configuration field IDs must be distinct");
  return {
    appToken: raw.appToken.trim(),
    creatorTableId: raw.creatorTableId.trim(),
    tableId: raw.tableId.trim(),
    fieldIds: Object.fromEntries(fieldKeys.map((key, index) => [key, values[index]])),
    apiOrigin: typeof raw.apiOrigin === "string" && raw.apiOrigin.trim()
      ? raw.apiOrigin.trim()
      : "https://open.larksuite.com",
  };
}

function typeMatches(field, names, numbers) {
  return names.includes(String(field.uiType ?? field.ui_type ?? "")) || numbers.includes(Number(field.type));
}

export function resolveFields(fields, fieldIds, creatorTableId) {
  const byId = new Map();
  for (const field of fields) {
    if (typeof field?.field_id !== "string") continue;
    const entries = byId.get(field.field_id) ?? [];
    entries.push(field);
    byId.set(field.field_id, entries);
  }
  const bindings = {};
  for (const key of [
    "timestamp",
    "creator",
    "fanClub",
    "latestLiveAt",
    "liveDays30d",
    "liveHours30d",
    "likes30d",
  ]) {
    const id = fieldIds[key];
    const matches = byId.get(id) ?? [];
    assert(matches.length === 1, matches.length ? `field ID is duplicated: ${id}` : `field ID is missing: ${id}`);
    const field = matches[0];
    assert(typeof field.field_name === "string" && field.field_name, `field name is unavailable for ID: ${id}`);
    bindings[key] = {
      id,
      name: field.field_name,
      type: Number(field.type),
      uiType: String(field.ui_type ?? ""),
      property: field.property ?? null,
    };
  }
  assert(new Set(Object.values(bindings).map((field) => field.name)).size === 7, "resolved field names must be distinct");
  assert(typeMatches(bindings.timestamp, ["DateTime"], [5]), "timestamp field is not date-time");
  assert(typeMatches(bindings.creator, ["DuplexLink"], [21]), "creator field is not a relation");
  assert(bindings.creator.property?.table_id === creatorTableId, "creator relation target changed");
  assert(bindings.creator.property?.multiple === false, "creator relation must be single-value");
  assert(typeMatches(bindings.latestLiveAt, ["DateTime"], [5]), "latest-LIVE field is not date-time");
  for (const key of ["fanClub", "liveDays30d", "liveHours30d", "likes30d"]) {
    assert(typeMatches(bindings[key], ["Number"], [2]), `metric field is not numeric: ${bindings[key].id}`);
  }
  return bindings;
}

function present(value) {
  return value !== null && value !== undefined && value !== "";
}

function parseInteger(value) {
  if (!present(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseNumber(value) {
  if (!present(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseDate(value) {
  if (!present(value)) return null;
  const number = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(number) ? number : null;
}

function jstDate(milliseconds) {
  return new Date(milliseconds + JST_OFFSET_MS);
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekKey(milliseconds) {
  const date = jstDate(milliseconds);
  const weekdayFromMonday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - weekdayFromMonday * DAY_MS);
  return dateKey(monday);
}

function monthKey(milliseconds) {
  const date = jstDate(milliseconds);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function yearKey(milliseconds) {
  return String(jstDate(milliseconds).getUTCFullYear());
}

export function retentionBucket(timestampMs, nowMs) {
  const ageMs = Math.max(0, nowMs - timestampMs);
  if (ageMs < RETENTION_POLICY.recent_days * DAY_MS) return { tier: "recent", key: null };
  if (ageMs < RETENTION_POLICY.weekly_until_days * DAY_MS) return { tier: "weekly", key: weekKey(timestampMs) };
  if (ageMs < RETENTION_POLICY.monthly_until_days * DAY_MS) return { tier: "monthly", key: monthKey(timestampMs) };
  return { tier: "yearly", key: yearKey(timestampMs) };
}

function normalizeMetricRecord(record, bindings, nowMs) {
  const reasons = [];
  const recordId = String(record?.record_id ?? "");
  if (!isRecordId(recordId)) reasons.push("invalid_record_id");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.creator.name]);
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  const timestampMs = Number(fields[bindings.timestamp.name]);
  if (!Number.isFinite(timestampMs)) reasons.push("invalid_timestamp");
  else if (timestampMs > nowMs + FUTURE_CLOCK_MARGIN_MS) reasons.push("future_timestamp");

  const raw = {
    fanClub: fields[bindings.fanClub.name],
    latestLiveAt: fields[bindings.latestLiveAt.name],
    liveDays30d: fields[bindings.liveDays30d.name],
    liveHours30d: fields[bindings.liveHours30d.name],
    likes30d: fields[bindings.likes30d.name],
  };
  const values = {
    fan_club: parseInteger(raw.fanClub),
    latest_live_at_ms: parseDate(raw.latestLiveAt),
    live_days_30d: parseInteger(raw.liveDays30d),
    live_hours_30d: parseNumber(raw.liveHours30d),
    likes_30d: parseInteger(raw.likes30d),
  };
  if (present(raw.fanClub) && values.fan_club === null) reasons.push("invalid_fan_club");
  if (present(raw.latestLiveAt) && values.latest_live_at_ms === null) reasons.push("invalid_latest_live_at");
  if (present(raw.liveDays30d) && values.live_days_30d === null) reasons.push("invalid_live_days_30d");
  if (present(raw.liveHours30d) && values.live_hours_30d === null) reasons.push("invalid_live_hours_30d");
  if (present(raw.likes30d) && values.likes_30d === null) reasons.push("invalid_likes_30d");
  if (reasons.length) return { valid: false, record_id: recordId, reasons: [...new Set(reasons)].sort() };
  return {
    valid: true,
    record_id: recordId,
    creator_record_id: creatorIds[0],
    timestamp_ms: timestampMs,
    ...values,
  };
}

function compareRecords(left, right) {
  return left.timestamp_ms - right.timestamp_ms || left.record_id.localeCompare(right.record_id);
}

function mark(keepReasons, record, reason) {
  const reasons = keepReasons.get(record.record_id) ?? new Set();
  reasons.add(reason);
  keepReasons.set(record.record_id, reasons);
}

function markRepresentative(keepReasons, bucketLabel, records) {
  const ordered = [...records].sort(compareRecords);
  mark(keepReasons, ordered.at(-1), `${bucketLabel}:latest`);
  for (const [name, key] of [
    ["fan-club", "fan_club"],
    ["latest-live", "latest_live_at_ms"],
    ["live-days", "live_days_30d"],
    ["live-hours", "live_hours_30d"],
    ["likes", "likes_30d"],
  ]) {
    const latest = ordered.filter((record) => record[key] !== null).at(-1);
    if (latest) mark(keepReasons, latest, `${bucketLabel}:${name}`);
  }
}

export function buildCompactionPlan(metricRecords, bindings, source, nowMs = Date.now()) {
  assert(Array.isArray(metricRecords), "metricRecords must be an array");
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  const seenRecordIds = new Set();
  const malformed = [];
  const byCreator = new Map();
  for (const record of metricRecords) {
    const recordId = String(record?.record_id ?? "");
    assert(!seenRecordIds.has(recordId), `record_id is duplicated: ${recordId}`);
    seenRecordIds.add(recordId);
    const normalized = normalizeMetricRecord(record, bindings, nowMs);
    if (!normalized.valid) {
      malformed.push({ ...normalized, decision: "keep" });
      continue;
    }
    const records = byCreator.get(normalized.creator_record_id) ?? [];
    records.push(normalized);
    byCreator.set(normalized.creator_record_id, records);
  }

  const items = [];
  for (const creatorRecordId of [...byCreator.keys()].sort()) {
    const records = byCreator.get(creatorRecordId).sort(compareRecords);
    const keepReasons = new Map();
    mark(keepReasons, records[0], "oldest");
    mark(keepReasons, records.at(-1), "latest");
    const buckets = new Map();
    for (const record of records) {
      const bucket = retentionBucket(record.timestamp_ms, nowMs);
      if (bucket.tier === "recent") {
        mark(keepReasons, record, "recent");
        continue;
      }
      const label = `${bucket.tier}:${bucket.key}`;
      const rows = buckets.get(label) ?? [];
      rows.push(record);
      buckets.set(label, rows);
    }
    for (const [label, rows] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      markRepresentative(keepReasons, label, rows);
    }
    items.push({
      creator_record_id: creatorRecordId,
      records: records.map((record) => {
        const reasons = [...(keepReasons.get(record.record_id) ?? [])].sort();
        return { ...record, decision: reasons.length ? "keep" : "delete", keep_reasons: reasons };
      }),
    });
  }

  const validRecordCount = items.reduce((sum, item) => sum + item.records.length, 0);
  const keepCount = malformed.length + items.reduce((sum, item) => sum + item.records.filter((record) => record.decision === "keep").length, 0);
  const deleteCount = items.reduce((sum, item) => sum + item.records.filter((record) => record.decision === "delete").length, 0);
  const affectedCreatorCount = items.filter((item) => item.records.some((record) => record.decision === "delete")).length;
  const unsigned = {
    version: 1,
    built_at: new Date(nowMs).toISOString(),
    built_at_ms: nowMs,
    source,
    policy: RETENTION_POLICY,
    summary: {
      metric_record_count: metricRecords.length,
      valid_record_count: validRecordCount,
      creator_count: items.length,
      keep_count: keepCount,
      delete_candidate_count: deleteCount,
      affected_creator_count: affectedCreatorCount,
      malformed_count: malformed.length,
    },
    items,
    malformed: malformed.sort((left, right) => left.record_id.localeCompare(right.record_id)),
  };
  return { ...unsigned, plan_sha256: calculateCompactionPlanSha256(unsigned) };
}

function sourceFromConfig(config) {
  return {
    app_token: config.appToken,
    creator_table_id: config.creatorTableId,
    table_id: config.tableId,
    field_ids: config.fieldIds,
  };
}

export function validatePlan(plan, config) {
  assert(plan?.version === 1, "plan.version is invalid");
  assert(stableStringify(plan.source) === stableStringify(sourceFromConfig(config)), "plan destination does not match configuration");
  assert(stableStringify(plan.policy) === stableStringify(RETENTION_POLICY), "plan retention policy does not match");
  assert(Array.isArray(plan.items) && Array.isArray(plan.malformed), "plan record lists are invalid");
  assert(/^[0-9a-f]{64}$/.test(String(plan.plan_sha256 ?? "")), "plan_sha256 is invalid");
  assert(calculateCompactionPlanSha256(plan) === plan.plan_sha256, "plan_sha256 does not match plan content");
  const records = plan.items.flatMap((item) => item.records);
  assert(plan.summary.metric_record_count === records.length + plan.malformed.length, "plan total count does not match");
  assert(plan.summary.keep_count === records.filter((record) => record.decision === "keep").length + plan.malformed.length, "plan keep count does not match");
  assert(plan.summary.delete_candidate_count === records.filter((record) => record.decision === "delete").length, "plan delete count does not match");
}

async function runtime(config, client) {
  const activeClient = client ?? await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
  const fields = await activeClient.listFields(config.appToken, config.tableId);
  const bindings = resolveFields(fields, config.fieldIds, config.creatorTableId);
  const records = await activeClient.listRecords(config.appToken, config.tableId);
  return { client: activeClient, bindings, records };
}

export async function createPlan({ config, output, client, nowMs = Date.now() }) {
  assert(output, "plan requires --output");
  const current = await runtime(config, client);
  const plan = buildCompactionPlan(current.records, current.bindings, sourceFromConfig(config), nowMs);
  await writePrivateJson(path.resolve(output), plan);
  return {
    status: plan.summary.malformed_count ? "blocked" : plan.summary.delete_candidate_count ? "success" : "unchanged",
    mode: "live-metrics-compaction-plan",
    output: path.resolve(output),
    plan_sha256: plan.plan_sha256,
    ...plan.summary,
  };
}

export async function inspectPlan({ plan, config, client }) {
  validatePlan(plan, config);
  const current = await runtime(config, client);
  const rebuilt = buildCompactionPlan(current.records, current.bindings, sourceFromConfig(config), plan.built_at_ms);
  const stale = rebuilt.plan_sha256 !== plan.plan_sha256;
  const malformed = plan.summary.malformed_count > 0;
  return {
    status: stale || malformed ? "blocked" : plan.summary.delete_candidate_count ? "ready" : "unchanged",
    mode: "live-metrics-compaction-apply",
    dry_run: true,
    plan_sha256: plan.plan_sha256,
    metric_record_count: plan.summary.metric_record_count,
    keep_count: plan.summary.keep_count,
    delete_count: plan.summary.delete_candidate_count,
    affected_creator_count: plan.summary.affected_creator_count,
    malformed_count: plan.summary.malformed_count,
    stale_count: stale ? 1 : 0,
  };
}

export async function applyPlan({ plan, config, apply = false, expectSha256, confirmDelete, client }) {
  const activeClient = client ?? await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
  const dryRun = await inspectPlan({ plan, config, client: activeClient });
  if (!apply) return dryRun;
  assert(dryRun.status !== "blocked", "malformed or stale records block deletion");
  assert(expectSha256 === plan.plan_sha256, "--expect-sha256 does not match the plan");
  const confirmedDelete = Number(confirmDelete);
  assert(Number.isSafeInteger(confirmedDelete) && confirmedDelete === dryRun.delete_count, "--confirm-delete does not match the current dry-run count");
  if (dryRun.delete_count === 0) {
    return { ...dryRun, dry_run: false, status: "unchanged", deleted_count: 0, verified: true };
  }

  const deleteIds = plan.items.flatMap((item) => item.records.filter((record) => record.decision === "delete").map((record) => record.record_id));
  const keepIds = new Set(plan.items.flatMap((item) => item.records.filter((record) => record.decision === "keep").map((record) => record.record_id)));
  let deleteError = null;
  try {
    for (let index = 0; index < deleteIds.length; index += DELETE_BATCH_SIZE) {
      await activeClient.batchDelete(config.appToken, config.tableId, deleteIds.slice(index, index + DELETE_BATCH_SIZE));
    }
  } catch (error) {
    deleteError = error;
  }

  const remaining = await activeClient.listRecords(config.appToken, config.tableId);
  const remainingIds = new Set(remaining.map((record) => record.record_id));
  const undeletedIds = deleteIds.filter((recordId) => remainingIds.has(recordId));
  const missingKeepIds = [...keepIds].filter((recordId) => !remainingIds.has(recordId));
  if (undeletedIds.length || missingKeepIds.length) {
    const detail = deleteError ? `write result is uncertain: ${deleteError.message}` : "post-delete verification failed";
    throw new Error(`${detail}; undeleted=${undeletedIds.length}; missing_keep=${missingKeepIds.length}; automatic retry is disabled`);
  }
  return {
    status: "success",
    mode: "live-metrics-compaction-apply",
    dry_run: false,
    plan_sha256: plan.plan_sha256,
    deleted_count: deleteIds.length,
    kept_count: keepIds.size + plan.malformed.length,
    affected_creator_count: plan.summary.affected_creator_count,
    verified: true,
    recovered_from_ambiguous_response: Boolean(deleteError),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    assert(argument.startsWith("--"), `unknown argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (key === "apply") {
      options.apply = true;
      continue;
    }
    const value = rest[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function usage() {
  return [
    "Usage:",
    "  node lark_live_metrics_compact.mjs plan --config CONFIG.json --output PLAN.json",
    "  node lark_live_metrics_compact.mjs apply --config CONFIG.json --plan PLAN.json",
    "  node lark_live_metrics_compact.mjs apply --config CONFIG.json --plan PLAN.json --apply --expect-sha256 HASH --confirm-delete COUNT",
  ].join("\n");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const config = await loadConfig(options.config);
  let result;
  if (command === "plan") {
    result = await createPlan({ config, output: options.output });
  } else if (command === "apply") {
    assert(options.plan, "apply requires --plan");
    const plan = await readPrivateJson(path.resolve(options.plan));
    result = await applyPlan({
      plan,
      config,
      apply: options.apply,
      expectSha256: options.expectSha256,
      confirmDelete: options.confirmDelete,
    });
  } else {
    throw new Error(`unknown command: ${command}\n${usage()}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
