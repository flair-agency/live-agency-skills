#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import crypto from "node:crypto";
import path from "node:path";

import { createLarkBaseClient } from "../../_shared/lark-base-client.mjs";
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
    "followerCount",
    "recentPostCount30d",
    "latestPostAt",
    "nickname",
    "avatar",
    "featureObservationData",
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
    credentials: typeof raw.credentials?.larkKeychainService === "string" && raw.credentials.larkKeychainService.trim()
      ? { larkKeychainService: raw.credentials.larkKeychainService.trim() }
      : {},
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
    "followerCount",
    "recentPostCount30d",
    "latestPostAt",
    "nickname",
    "avatar",
    "featureObservationData",
  ]) {
    const id = fieldIds[key];
    const matches = byId.get(id) ?? [];
    assert(matches.length === 1, matches.length ? `field ID is duplicated: ${id}` : `field ID is missing: ${id}`);
    const field = matches[0];
    assert(typeof field.field_name === "string" && field.field_name, `field name is unavailable for ID: ${id}`);
    bindings[key] = { id, name: field.field_name, type: Number(field.type), uiType: String(field.ui_type ?? ""), property: field.property ?? null };
  }
  assert(new Set(Object.values(bindings).map((field) => field.name)).size === 8, "resolved field names must be distinct");
  assert(typeMatches(bindings.timestamp, ["DateTime", "CreatedTime"], [5, 1005]), "timestamp field is not date-time");
  assert(typeMatches(bindings.creator, ["DuplexLink"], [21]), "creator field is not a relation");
  if (creatorTableId) {
    assert(bindings.creator.property?.table_id === creatorTableId, "creator relation target changed");
    assert(bindings.creator.property?.multiple === false, "creator relation must be single-value");
  }
  for (const key of ["followerCount", "recentPostCount30d"]) {
    assert(typeMatches(bindings[key], ["Number"], [2]), `metric field is not numeric: ${bindings[key].id}`);
  }
  assert(typeMatches(bindings.latestPostAt, ["DateTime"], [5]), "latest-post field is not date-time");
  for (const key of ["nickname", "featureObservationData"]) {
    assert(typeMatches(bindings[key], ["Text"], [1]), `text field has changed type: ${bindings[key].id}`);
  }
  assert(typeMatches(bindings.avatar, ["Attachment"], [17]), "avatar field is not an attachment");
  return bindings;
}

function parseCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function countIsPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(number) ? number : null;
}

function parseText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return undefined;
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

function normalizeProfileRecord(record, bindings, nowMs) {
  const reasons = [];
  if (!isRecordId(record?.record_id)) reasons.push("invalid_record_id");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.creator.name]);
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  const timestampMs = Number(fields[bindings.timestamp.name]);
  if (!Number.isFinite(timestampMs)) reasons.push("invalid_timestamp");
  else if (timestampMs > nowMs + FUTURE_CLOCK_MARGIN_MS) reasons.push("future_timestamp");
  const rawFollower = fields[bindings.followerCount.name];
  const rawRecentPosts = fields[bindings.recentPostCount30d.name];
  const rawLatestPost = fields[bindings.latestPostAt.name];
  const rawNickname = fields[bindings.nickname.name];
  const rawAvatar = fields[bindings.avatar.name];
  const rawFeatureData = fields[bindings.featureObservationData.name];
  const followerCount = parseCount(rawFollower);
  const recentPostCount30d = parseCount(rawRecentPosts);
  const latestPostAtMs = parseDate(rawLatestPost);
  const nickname = parseText(rawNickname);
  const featureObservationText = parseText(rawFeatureData);
  let featureObservationPresent = false;
  if (featureObservationText !== null && featureObservationText !== undefined) {
    try {
      const parsed = JSON.parse(featureObservationText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      featureObservationPresent = true;
    } catch {
      reasons.push("invalid_feature_observation_json");
    }
  }
  let avatarPresent = false;
  if (rawAvatar !== null && rawAvatar !== undefined && rawAvatar !== "") {
    if (!Array.isArray(rawAvatar)) reasons.push("invalid_avatar");
    else avatarPresent = rawAvatar.length > 0;
  }
  if (countIsPresent(rawFollower) && followerCount === null) reasons.push("invalid_follower_count");
  if (countIsPresent(rawRecentPosts) && recentPostCount30d === null) reasons.push("invalid_recent_post_count");
  if (countIsPresent(rawLatestPost) && latestPostAtMs === null) reasons.push("invalid_latest_post_at");
  if (countIsPresent(rawNickname) && nickname === undefined) reasons.push("invalid_nickname");
  if (countIsPresent(rawFeatureData) && featureObservationText === undefined) reasons.push("invalid_feature_observation_text");
  if (reasons.length) {
    return { valid: false, record_id: String(record?.record_id ?? ""), reasons: [...new Set(reasons)].sort() };
  }
  return {
    valid: true,
    record_id: record.record_id,
    creator_record_id: creatorIds[0],
    timestamp_ms: timestampMs,
    follower_count: followerCount,
    recent_post_count_30d: recentPostCount30d,
    latest_post_at_ms: latestPostAtMs,
    nickname_present: nickname !== null && nickname !== undefined,
    avatar_present: avatarPresent,
    feature_observation_present: featureObservationPresent,
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
  const metrics = [
    ["follower", (record) => record.follower_count !== null],
    ["recent-posts", (record) => record.recent_post_count_30d !== null],
    ["latest-post", (record) => record.latest_post_at_ms !== null],
    ["nickname", (record) => record.nickname_present],
    ["avatar", (record) => record.avatar_present],
    ["feature-observation", (record) => record.feature_observation_present],
  ];
  for (const [name, present] of metrics) {
    const latest = ordered.filter(present).at(-1);
    if (latest) mark(keepReasons, latest, `${bucketLabel}:${name}`);
  }
}

export function buildCompactionPlan(profileRecords, bindings, source, nowMs = Date.now()) {
  assert(Array.isArray(profileRecords), "profileRecords must be an array");
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  const seenRecordIds = new Set();
  const malformed = [];
  const byCreator = new Map();
  for (const record of profileRecords) {
    const recordId = String(record?.record_id ?? "");
    assert(!seenRecordIds.has(recordId), `record_id is duplicated: ${recordId}`);
    seenRecordIds.add(recordId);
    const normalized = normalizeProfileRecord(record, bindings, nowMs);
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
      const bucketRecords = buckets.get(label) ?? [];
      bucketRecords.push(record);
      buckets.set(label, bucketRecords);
    }
    for (const [label, bucketRecords] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      markRepresentative(keepReasons, label, bucketRecords);
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
      profile_record_count: profileRecords.length,
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
  assert(plan.summary.profile_record_count === records.length + plan.malformed.length, "plan total count does not match");
  assert(plan.summary.keep_count === records.filter((record) => record.decision === "keep").length + plan.malformed.length, "plan keep count does not match");
  assert(plan.summary.delete_candidate_count === records.filter((record) => record.decision === "delete").length, "plan delete count does not match");
}

async function runtime(config, client) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin, keychainService: config.credentials?.larkKeychainService });
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
    mode: "compaction-plan",
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
    mode: "compaction-apply",
    dry_run: true,
    plan_sha256: plan.plan_sha256,
    profile_record_count: plan.summary.profile_record_count,
    keep_count: plan.summary.keep_count,
    delete_count: plan.summary.delete_candidate_count,
    affected_creator_count: plan.summary.affected_creator_count,
    malformed_count: plan.summary.malformed_count,
    stale_count: stale ? 1 : 0,
  };
}

export async function applyPlan({ plan, config, apply = false, expectSha256, confirmDelete, client }) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin, keychainService: config.credentials?.larkKeychainService });
  const dryRun = await inspectPlan({ plan, config, client: activeClient });
  if (!apply) return dryRun;
  assert(dryRun.status !== "blocked", "malformed or stale records block deletion");
  assert(expectSha256 === plan.plan_sha256, "--expect-sha256 does not match the plan");
  const confirmedDelete = Number(confirmDelete);
  assert(Number.isSafeInteger(confirmedDelete) && confirmedDelete === dryRun.delete_count, "--confirm-delete does not match the current dry-run count");
  if (dryRun.delete_count === 0) return { ...dryRun, dry_run: false, status: "unchanged", deleted_count: 0, verified: true };

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
    mode: "compaction-apply",
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
    "  node lark_profile_compact.mjs plan --config CONFIG.json --output PLAN.json",
    "  node lark_profile_compact.mjs apply --config CONFIG.json --plan PLAN.json",
    "  node lark_profile_compact.mjs apply --config CONFIG.json --plan PLAN.json --apply --expect-sha256 HASH --confirm-delete COUNT",
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

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
