#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { createLarkBaseClient } from "../../_shared/lark-base-client.mjs";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FUTURE_CLOCK_MARGIN_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;
const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;

export const RETENTION_POLICY = Object.freeze({
  timezone: "Asia/Tokyo",
  rolling_days: 30,
  keep_full_boundary_day: true,
  always_keep_oldest: true,
  always_keep_latest: true,
  protect_data_quality_warnings: true,
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function withoutHash(value, key) {
  const { [key]: ignored, ...rest } = value;
  return rest;
}

export function calculateLiveCompactionPlanSha256(plan) {
  return sha256(stableStringify(withoutHash(plan, "plan_sha256")));
}

export function calculateRestoreArchiveSha256(archive) {
  return sha256(stableStringify(withoutHash(archive, "archive_sha256")));
}

export function calculateArchiveReceiptSha256(receipt) {
  return sha256(stableStringify(withoutHash(receipt, "receipt_sha256")));
}

function compactFormula(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function isRecordId(value) {
  return /^rec[A-Za-z0-9]{7,}$/.test(String(value ?? ""));
}

function linkedRecordIds(value) {
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

function configurationIdentity(config) {
  return {
    app_token: config.appToken,
    creator_table_id: config.creatorTableId,
    live_history_table_id: config.tableId,
    field_ids: config.fieldIds,
    schema_expectations: config.schemaExpectations,
    archive_destination: config.archiveDestination,
  };
}

export function configurationSha256(config) {
  return sha256(stableStringify(configurationIdentity(config)));
}

export async function loadConfig(filePath) {
  assert(filePath, "--config is required");
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of ["appToken", "creatorTableId", "tableId"]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const fieldKeys = ["start", "end", "creator", "likes"];
  assert(raw.fieldIds && typeof raw.fieldIds === "object", "configuration fieldIds is required");
  const values = fieldKeys.map((key) => {
    const value = raw.fieldIds[key];
    assert(typeof value === "string" && value.trim(), `configuration fieldIds.${key} is required`);
    return value.trim();
  });
  assert(new Set(values).size === values.length, "configuration field IDs must be distinct");
  const expectations = raw.schemaExpectations ?? [];
  assert(Array.isArray(expectations), "configuration schemaExpectations must be an array");
  const expectationIds = new Set();
  const schemaExpectations = expectations.map((item, index) => {
    assert(item && typeof item === "object", `schemaExpectations[${index}] is invalid`);
    assert(typeof item.fieldId === "string" && item.fieldId.trim(), `schemaExpectations[${index}].fieldId is required`);
    assert(!expectationIds.has(item.fieldId), `schema expectation field is duplicated: ${item.fieldId}`);
    expectationIds.add(item.fieldId);
    assert(Number.isSafeInteger(item.type), `schemaExpectations[${index}].type is required`);
    if (item.formulaExpression !== undefined) {
      assert(typeof item.formulaExpression === "string" && item.formulaExpression.trim(), `schemaExpectations[${index}].formulaExpression is invalid`);
    }
    return {
      fieldId: item.fieldId.trim(),
      type: item.type,
      ...(item.formulaExpression === undefined ? {} : { formulaExpression: item.formulaExpression }),
    };
  });
  const destination = raw.archiveDestination;
  assert(destination && typeof destination === "object", "configuration archiveDestination is required");
  for (const key of ["sharedDriveId", "folderId"]) {
    assert(typeof destination[key] === "string" && destination[key].trim(), `archiveDestination.${key} is required`);
  }
  return {
    appToken: raw.appToken.trim(),
    creatorTableId: raw.creatorTableId.trim(),
    tableId: raw.tableId.trim(),
    fieldIds: Object.fromEntries(fieldKeys.map((key, index) => [key, values[index]])),
    schemaExpectations,
    archiveDestination: {
      sharedDriveId: destination.sharedDriveId.trim(),
      folderId: destination.folderId.trim(),
      mimeType: typeof destination.mimeType === "string" && destination.mimeType.trim()
        ? destination.mimeType.trim()
        : "application/gzip",
    },
    credentials: typeof raw.credentials?.larkKeychainService === "string" && raw.credentials.larkKeychainService.trim()
      ? { larkKeychainService: raw.credentials.larkKeychainService.trim() }
      : {},
    apiOrigin: typeof raw.apiOrigin === "string" && raw.apiOrigin.trim()
      ? raw.apiOrigin.trim()
      : "https://open.larksuite.com",
  };
}

export function resolveSchema(fields, config) {
  const byId = new Map();
  for (const field of fields) {
    if (typeof field?.field_id !== "string") continue;
    const matches = byId.get(field.field_id) ?? [];
    matches.push(field);
    byId.set(field.field_id, matches);
  }
  const field = (id) => {
    const matches = byId.get(id) ?? [];
    assert(matches.length === 1, matches.length ? `field ID is duplicated: ${id}` : `field ID is missing: ${id}`);
    assert(typeof matches[0].field_name === "string" && matches[0].field_name, `field name is unavailable for ID: ${id}`);
    return matches[0];
  };
  const bindings = Object.fromEntries(
    Object.entries(config.fieldIds).map(([key, id]) => {
      const current = field(id);
      return [key, { id, name: current.field_name, type: Number(current.type), property: current.property ?? null }];
    }),
  );
  assert(new Set(Object.values(bindings).map((value) => value.name)).size === 4, "resolved field names must be distinct");
  assert(bindings.likes.type === 2, `likes field is not numeric: ${bindings.likes.id}`);
  assert(bindings.creator.property?.table_id === config.creatorTableId, "creator relation target does not match configuration");
  assert(bindings.creator.property?.multiple === false, "creator relation must be single-value");

  const signature = Object.values(bindings).map((value) => ({
    field_id: value.id,
    type: value.type,
    property: value.property,
  }));
  for (const expected of config.schemaExpectations) {
    const current = field(expected.fieldId);
    assert(Number(current.type) === expected.type, `schema field type changed: ${expected.fieldId}`);
    if (expected.formulaExpression !== undefined) {
      assert(
        compactFormula(current.property?.formula_expression) === compactFormula(expected.formulaExpression),
        `schema field formula changed: ${expected.fieldId}`,
      );
    }
    signature.push({ field_id: current.field_id, type: Number(current.type), property: current.property ?? null });
  }
  const uniqueSignature = [...new Map(signature.map((item) => [item.field_id, item])).values()]
    .sort((left, right) => left.field_id.localeCompare(right.field_id));
  return { bindings, schemaSha256: sha256(stableStringify(uniqueSignature)) };
}

export function retentionCutoffs(nowMs) {
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  const exactCutoffMs = nowMs - RETENTION_POLICY.rolling_days * DAY_MS;
  const shifted = new Date(exactCutoffMs + JST_OFFSET_MS);
  const safeBoundaryMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - JST_OFFSET_MS;
  return { exact_cutoff_ms: exactCutoffMs, safe_boundary_ms: safeBoundaryMs };
}

function countIsPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function parseCount(value) {
  if (!countIsPresent(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeLiveRecord(record, bindings, nowMs) {
  const blockingReasons = [];
  const warnings = [];
  if (!isRecordId(record?.record_id)) blockingReasons.push("invalid_record_id");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.creator.name]);
  if (creatorIds.length !== 1) blockingReasons.push("creator_link_not_unique");
  const startMs = Number(fields[bindings.start.name]);
  if (!Number.isFinite(startMs)) blockingReasons.push("invalid_start");
  else if (startMs > nowMs + FUTURE_CLOCK_MARGIN_MS) blockingReasons.push("future_start");
  const endMs = Number(fields[bindings.end.name]);
  if (!Number.isFinite(endMs)) warnings.push("invalid_end");
  else if (Number.isFinite(startMs) && endMs < startMs) warnings.push("end_before_start");
  const rawLikes = fields[bindings.likes.name];
  const likeCount = parseCount(rawLikes);
  if (countIsPresent(rawLikes) && likeCount === null) warnings.push("invalid_like_count");
  if (blockingReasons.length) {
    return { classifiable: false, record_id: String(record?.record_id ?? ""), reasons: [...new Set(blockingReasons)].sort() };
  }
  return {
    classifiable: true,
    record_id: record.record_id,
    creator_record_id: creatorIds[0],
    start_ms: startMs,
    end_ms: Number.isFinite(endMs) ? endMs : null,
    like_count: likeCount,
    data_quality_warnings: [...new Set(warnings)].sort(),
  };
}

function compareRecords(left, right) {
  return left.start_ms - right.start_ms || left.record_id.localeCompare(right.record_id);
}

function mark(keepReasons, record, reason) {
  const reasons = keepReasons.get(record.record_id) ?? new Set();
  reasons.add(reason);
  keepReasons.set(record.record_id, reasons);
}

function jstDayKey(milliseconds) {
  return new Date(milliseconds + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function metricPreservationViolations(items, exactCutoffMs) {
  const recentCreatorDays = new Set();
  for (const item of items) {
    for (const record of item.records) {
      if (record.start_ms > exactCutoffMs) recentCreatorDays.add(`${item.creator_record_id}|${jstDayKey(record.start_ms)}`);
    }
  }
  const violations = [];
  for (const item of items) {
    for (const record of item.records) {
      const creatorDay = `${item.creator_record_id}|${jstDayKey(record.start_ms)}`;
      if (record.decision === "delete" && (record.start_ms > exactCutoffMs || recentCreatorDays.has(creatorDay))) {
        violations.push(record.record_id);
      }
    }
  }
  return violations.sort();
}

function planSource(config, schemaSha256) {
  return { configuration_sha256: configurationSha256(config), live_schema_sha256: schemaSha256 };
}

export function buildLiveCompactionPlan(liveRecords, bindings, source, nowMs = Date.now()) {
  assert(Array.isArray(liveRecords), "liveRecords must be an array");
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  assert(/^[0-9a-f]{64}$/.test(String(source?.configuration_sha256 ?? "")), "source configuration SHA is invalid");
  assert(/^[0-9a-f]{64}$/.test(String(source?.live_schema_sha256 ?? "")), "source schema SHA is invalid");
  const cutoffs = retentionCutoffs(nowMs);
  const seenRecordIds = new Set();
  const blockingMalformed = [];
  const byCreator = new Map();
  for (const record of liveRecords) {
    const recordId = String(record?.record_id ?? "");
    assert(!seenRecordIds.has(recordId), `record_id is duplicated: ${recordId}`);
    seenRecordIds.add(recordId);
    const normalized = normalizeLiveRecord(record, bindings, nowMs);
    if (!normalized.classifiable) {
      blockingMalformed.push({ ...normalized, decision: "keep" });
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
    for (const record of records) {
      if (record.start_ms >= cutoffs.safe_boundary_ms) mark(keepReasons, record, "rolling_window_boundary_day");
      if (record.data_quality_warnings.length) mark(keepReasons, record, "data_quality_warning");
    }
    items.push({
      creator_record_id: creatorRecordId,
      records: records.map((record) => {
        const reasons = [...(keepReasons.get(record.record_id) ?? [])].sort();
        return { ...record, decision: reasons.length ? "keep" : "delete", keep_reasons: reasons };
      }),
    });
  }

  const metricViolations = metricPreservationViolations(items, cutoffs.exact_cutoff_ms);
  const records = items.flatMap((item) => item.records);
  const unsigned = {
    version: 1,
    built_at: new Date(nowMs).toISOString(),
    built_at_ms: nowMs,
    source,
    policy: RETENTION_POLICY,
    cutoffs,
    summary: {
      live_record_count: liveRecords.length,
      classifiable_record_count: records.length,
      creator_count: items.length,
      keep_count: blockingMalformed.length + records.filter((record) => record.decision === "keep").length,
      delete_candidate_count: records.filter((record) => record.decision === "delete").length,
      affected_creator_count: items.filter((item) => item.records.some((record) => record.decision === "delete")).length,
      data_quality_warning_count: records.filter((record) => record.data_quality_warnings.length).length,
      blocking_malformed_count: blockingMalformed.length,
      metric_preservation_violation_count: metricViolations.length,
    },
    items,
    blocking_malformed: blockingMalformed.sort((left, right) => left.record_id.localeCompare(right.record_id)),
    metric_preservation_violations: metricViolations,
  };
  return { ...unsigned, plan_sha256: calculateLiveCompactionPlanSha256(unsigned) };
}

export function validatePlan(plan, config) {
  assert(plan?.version === 1, "plan.version is invalid");
  assert(plan.source?.configuration_sha256 === configurationSha256(config), "plan configuration does not match");
  assert(/^[0-9a-f]{64}$/.test(String(plan.source?.live_schema_sha256 ?? "")), "plan schema SHA is invalid");
  assert(stableStringify(plan.policy) === stableStringify(RETENTION_POLICY), "plan retention policy does not match");
  assert(Array.isArray(plan.items) && Array.isArray(plan.blocking_malformed), "plan record lists are invalid");
  assert(Array.isArray(plan.metric_preservation_violations), "plan metric verification is invalid");
  assert(calculateLiveCompactionPlanSha256(plan) === plan.plan_sha256, "plan SHA does not match content");
  const records = plan.items.flatMap((item) => item.records);
  assert(plan.summary.live_record_count === records.length + plan.blocking_malformed.length, "plan total count does not match");
  assert(plan.summary.keep_count === records.filter((record) => record.decision === "keep").length + plan.blocking_malformed.length, "plan keep count does not match");
  assert(plan.summary.delete_candidate_count === records.filter((record) => record.decision === "delete").length, "plan delete count does not match");
  assert(plan.summary.metric_preservation_violation_count === plan.metric_preservation_violations.length, "plan metric violation count does not match");
}

function planIsBlocked(plan) {
  return plan.summary.blocking_malformed_count > 0 || plan.summary.metric_preservation_violation_count > 0;
}

function archiveFileName(archivedAtMs, planSha256) {
  const date = new Date(archivedAtMs + JST_OFFSET_MS).toISOString().slice(0, 10);
  return `live-history-archive_${date}_${planSha256}.json.gz`;
}

export function buildRestoreArchive(plan, config, archivedAtMs = Date.now()) {
  validatePlan(plan, config);
  assert(Number.isSafeInteger(archivedAtMs), "archivedAtMs is invalid");
  assert(!planIsBlocked(plan), "a blocked plan cannot be archived");
  const records = plan.items.flatMap((item) => item.records
    .filter((record) => record.decision === "delete")
    .map((record) => ({
      original_record_id: record.record_id,
      restore_key: `${record.creator_record_id}:${record.start_ms}:${record.end_ms}`,
      values: {
        creator_record_id: record.creator_record_id,
        start_ms: record.start_ms,
        end_ms: record.end_ms,
        like_count: record.like_count,
      },
    })))
    .sort((left, right) => left.original_record_id.localeCompare(right.original_record_id));
  const unsigned = {
    version: 1,
    archive_type: "creator-live-history-compaction-restore",
    archived_at: new Date(archivedAtMs).toISOString(),
    archived_at_ms: archivedAtMs,
    file_name: archiveFileName(archivedAtMs, plan.plan_sha256),
    plan_sha256: plan.plan_sha256,
    source: plan.source,
    policy: plan.policy,
    drive_destination: config.archiveDestination,
    summary: { archived_record_count: records.length },
    records,
  };
  return { ...unsigned, archive_sha256: calculateRestoreArchiveSha256(unsigned) };
}

export function validateRestoreArchive(archive, config) {
  assert(archive?.version === 1 && archive.archive_type === "creator-live-history-compaction-restore", "archive type is invalid");
  assert(Number.isSafeInteger(archive.archived_at_ms), "archive timestamp is invalid");
  assert(new Date(archive.archived_at_ms).toISOString() === archive.archived_at, "archive timestamps do not match");
  assert(/^live-history-archive_\d{4}-\d{2}-\d{2}_[0-9a-f]{64}\.json\.gz$/.test(String(archive.file_name ?? "")), "archive file name is invalid");
  assert(archive.source?.configuration_sha256 === configurationSha256(config), "archive configuration does not match");
  assert(stableStringify(archive.policy) === stableStringify(RETENTION_POLICY), "archive policy does not match");
  assert(stableStringify(archive.drive_destination) === stableStringify(config.archiveDestination), "archive destination does not match");
  assert(Array.isArray(archive.records), "archive.records must be an array");
  assert(archive.summary?.archived_record_count === archive.records.length, "archive count does not match");
  const originalIds = new Set();
  const restoreKeys = new Set();
  for (const [index, record] of archive.records.entries()) {
    const label = `archive.records[${index}]`;
    assert(isRecordId(record.original_record_id) && !originalIds.has(record.original_record_id), `${label}.original_record_id is invalid or duplicated`);
    originalIds.add(record.original_record_id);
    const values = record.values ?? {};
    assert(isRecordId(values.creator_record_id), `${label}.creator_record_id is invalid`);
    assert(Number.isFinite(values.start_ms) && Number.isFinite(values.end_ms) && values.end_ms >= values.start_ms, `${label} timestamps are invalid`);
    assert(values.like_count === null || (Number.isSafeInteger(values.like_count) && values.like_count >= 0), `${label}.like_count is invalid`);
    const expected = `${values.creator_record_id}:${values.start_ms}:${values.end_ms}`;
    assert(record.restore_key === expected && !restoreKeys.has(expected), `${label}.restore_key is invalid or duplicated`);
    restoreKeys.add(expected);
  }
  assert(calculateRestoreArchiveSha256(archive) === archive.archive_sha256, "archive SHA does not match content");
}

export function buildArchiveReceipt(archive, config, fileMetadata, verifiedAtMs = Date.now()) {
  validateRestoreArchive(archive, config);
  assert(Number.isSafeInteger(verifiedAtMs), "verifiedAtMs is invalid");
  assert(/^[A-Za-z0-9_-]{10,}$/.test(String(fileMetadata?.file_id ?? "")), "archive file ID is invalid");
  assert(fileMetadata.folder_id === config.archiveDestination.folderId, "archive folder ID does not match");
  assert(fileMetadata.file_name === archive.file_name, "archive file name does not match");
  const url = new URL(String(fileMetadata.file_url ?? ""));
  assert(url.protocol === "https:", "archive file URL must use HTTPS");
  assert(/^[0-9a-f]{64}$/.test(String(fileMetadata.file_sha256 ?? "")), "archive readback SHA is invalid");
  const unsigned = {
    version: 1,
    receipt_type: "creator-live-history-compaction-drive-archive",
    verified_at: new Date(verifiedAtMs).toISOString(),
    verified_at_ms: verifiedAtMs,
    plan_sha256: archive.plan_sha256,
    archive_sha256: archive.archive_sha256,
    archive_file_sha256: fileMetadata.file_sha256,
    archived_record_count: archive.summary.archived_record_count,
    drive: {
      shared_drive_id: config.archiveDestination.sharedDriveId,
      folder_id: config.archiveDestination.folderId,
      file_id: fileMetadata.file_id,
      file_name: fileMetadata.file_name,
      file_url: fileMetadata.file_url,
      mime_type: config.archiveDestination.mimeType,
      readback_verified: true,
    },
  };
  return { ...unsigned, receipt_sha256: calculateArchiveReceiptSha256(unsigned) };
}

export function validateArchiveReceipt(receipt, plan, config, archiveFileSha256 = null) {
  assert(receipt?.version === 1 && receipt.receipt_type === "creator-live-history-compaction-drive-archive", "archive receipt is invalid");
  assert(receipt.plan_sha256 === plan.plan_sha256, "receipt plan SHA does not match");
  assert(receipt.archived_record_count === plan.summary.delete_candidate_count, "receipt count does not match plan");
  assert(receipt.drive?.shared_drive_id === config.archiveDestination.sharedDriveId, "receipt shared drive does not match");
  assert(receipt.drive?.folder_id === config.archiveDestination.folderId, "receipt folder does not match");
  assert(receipt.drive?.mime_type === config.archiveDestination.mimeType, "receipt MIME type does not match");
  assert(receipt.drive?.readback_verified === true, "archive receipt is not readback-verified");
  if (archiveFileSha256 !== null) assert(receipt.archive_file_sha256 === archiveFileSha256, "receipt file SHA does not match local archive");
  assert(calculateArchiveReceiptSha256(receipt) === receipt.receipt_sha256, "receipt SHA does not match content");
}

async function writePrivateGzipJson(filename, value) {
  const resolved = path.resolve(filename);
  const directory = path.dirname(resolved);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const compressed = gzipSync(Buffer.from(`${stableStringify(value)}\n`, "utf8"), { level: 9 });
  assert(compressed.length <= ARCHIVE_MAX_BYTES, "archive exceeds size limit");
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(compressed);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, resolved);
    await fs.chmod(resolved, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return { output: resolved, file_sha256: sha256(compressed), file_size_bytes: compressed.length };
}

async function readPrivateGzipJson(filename) {
  const resolved = path.resolve(filename);
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1, "archive must be one regular file");
    if (typeof process.getuid === "function") assert(stat.uid === process.getuid(), "archive owner is invalid");
    assert((stat.mode & 0o777) === 0o600, "archive permissions must be 0600");
    assert(stat.size > 0 && stat.size <= ARCHIVE_MAX_BYTES, "archive size is invalid");
    const compressed = await handle.readFile();
    const decoded = gunzipSync(compressed, { maxOutputLength: ARCHIVE_MAX_BYTES });
    return { archive: JSON.parse(decoded.toString("utf8")), file_sha256: sha256(compressed) };
  } finally {
    await handle.close();
  }
}

async function currentRuntime(config, client) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin, keychainService: config.credentials?.larkKeychainService });
  const fields = await activeClient.listFields(config.appToken, config.tableId);
  const schema = resolveSchema(fields, config);
  const records = await activeClient.listRecords(config.appToken, config.tableId);
  return { client: activeClient, ...schema, records };
}

export async function createPlan({ config, output, client, nowMs = Date.now() }) {
  assert(output, "plan requires --output");
  const current = await currentRuntime(config, client);
  const plan = buildLiveCompactionPlan(
    current.records,
    current.bindings,
    planSource(config, current.schemaSha256),
    nowMs,
  );
  await writePrivateJson(path.resolve(output), plan);
  return {
    status: planIsBlocked(plan) ? "blocked" : plan.summary.delete_candidate_count ? "success" : "unchanged",
    mode: "live-history-compaction-plan",
    output: path.resolve(output),
    plan_sha256: plan.plan_sha256,
    ...plan.summary,
  };
}

export async function inspectPlan({ plan, config, client }) {
  validatePlan(plan, config);
  const current = await currentRuntime(config, client);
  const rebuilt = buildLiveCompactionPlan(
    current.records,
    current.bindings,
    planSource(config, current.schemaSha256),
    plan.built_at_ms,
  );
  const stale = rebuilt.plan_sha256 !== plan.plan_sha256;
  return {
    status: stale || planIsBlocked(plan) ? "blocked" : plan.summary.delete_candidate_count ? "ready" : "unchanged",
    mode: "live-history-compaction-apply",
    dry_run: true,
    plan_sha256: plan.plan_sha256,
    live_record_count: plan.summary.live_record_count,
    keep_count: plan.summary.keep_count,
    delete_count: plan.summary.delete_candidate_count,
    affected_creator_count: plan.summary.affected_creator_count,
    data_quality_warning_count: plan.summary.data_quality_warning_count,
    blocking_malformed_count: plan.summary.blocking_malformed_count,
    metric_preservation_violation_count: plan.summary.metric_preservation_violation_count,
    stale_count: stale ? 1 : 0,
  };
}

export async function createArchive({ plan, config, outputDir, client, archivedAtMs = Date.now() }) {
  assert(outputDir, "archive requires --output-dir");
  const dryRun = await inspectPlan({ plan, config, client });
  assert(dryRun.status !== "blocked", "a blocked or stale plan cannot be archived");
  if (dryRun.delete_count === 0) return { status: "unchanged", mode: "live-history-compaction-archive", archived_record_count: 0 };
  const archive = buildRestoreArchive(plan, config, archivedAtMs);
  const written = await writePrivateGzipJson(path.join(path.resolve(outputDir), archive.file_name), archive);
  return {
    status: "success",
    mode: "live-history-compaction-archive",
    plan_sha256: plan.plan_sha256,
    archive_sha256: archive.archive_sha256,
    archived_record_count: archive.summary.archived_record_count,
    file_name: archive.file_name,
    ...written,
  };
}

export async function createReceipt({ plan, archivePath, config, output, fileMetadata }) {
  assert(output, "receipt requires --output");
  validatePlan(plan, config);
  const archiveRead = await readPrivateGzipJson(archivePath);
  validateRestoreArchive(archiveRead.archive, config);
  assert(archiveRead.archive.plan_sha256 === plan.plan_sha256, "archive plan SHA does not match plan");
  assert(fileMetadata.file_sha256 === archiveRead.file_sha256, "Drive readback SHA does not match local archive");
  const receipt = buildArchiveReceipt(archiveRead.archive, config, fileMetadata);
  await writePrivateJson(path.resolve(output), receipt);
  return {
    status: "success",
    mode: "live-history-compaction-archive-receipt",
    output: path.resolve(output),
    plan_sha256: receipt.plan_sha256,
    archive_sha256: receipt.archive_sha256,
    archive_file_sha256: receipt.archive_file_sha256,
    receipt_sha256: receipt.receipt_sha256,
    archived_record_count: receipt.archived_record_count,
  };
}

export async function applyPlan({ plan, receipt, config, apply = false, expectSha256, confirmDelete, client }) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin, keychainService: config.credentials?.larkKeychainService });
  const dryRun = await inspectPlan({ plan, config, client: activeClient });
  if (!apply) return dryRun;
  assert(dryRun.status !== "blocked", "a blocked or stale plan cannot be applied");
  assert(expectSha256 === plan.plan_sha256, "--expect-sha256 does not match plan");
  assert(Number(confirmDelete) === dryRun.delete_count, "--confirm-delete does not match current dry-run count");
  if (dryRun.delete_count === 0) return { ...dryRun, dry_run: false, status: "unchanged", deleted_count: 0, verified: true };
  assert(receipt, "deletion requires an archive receipt");
  validateArchiveReceipt(receipt, plan, config);

  const deleteIds = plan.items.flatMap((item) => item.records.filter((record) => record.decision === "delete").map((record) => record.record_id));
  const keepIds = new Set(plan.items.flatMap((item) => item.records.filter((record) => record.decision === "keep").map((record) => record.record_id)));
  let writeError = null;
  try {
    for (let index = 0; index < deleteIds.length; index += BATCH_SIZE) {
      await activeClient.batchDelete(config.appToken, config.tableId, deleteIds.slice(index, index + BATCH_SIZE));
    }
  } catch (error) {
    writeError = error;
  }
  const current = await currentRuntime(config, activeClient);
  const remainingIds = new Set(current.records.map((record) => record.record_id));
  const undeleted = deleteIds.filter((recordId) => remainingIds.has(recordId));
  const missingKeep = [...keepIds].filter((recordId) => !remainingIds.has(recordId));
  if (undeleted.length || missingKeep.length) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-delete verification failed";
    throw new Error(`${reason}; undeleted=${undeleted.length}; missing_keep=${missingKeep.length}; automatic retry is disabled`);
  }
  const verification = buildLiveCompactionPlan(
    current.records,
    current.bindings,
    planSource(config, current.schemaSha256),
    plan.built_at_ms,
  );
  assert(verification.summary.delete_candidate_count === 0, "post-delete plan still has deletion candidates");
  assert(verification.summary.metric_preservation_violation_count === 0, "post-delete metric preservation failed");
  return {
    status: "success",
    mode: "live-history-compaction-apply",
    dry_run: false,
    plan_sha256: plan.plan_sha256,
    deleted_count: deleteIds.length,
    kept_count: current.records.length,
    verified: true,
    recovered_from_ambiguous_response: Boolean(writeError),
    archive_receipt_sha256: receipt.receipt_sha256,
  };
}

function storedRestoreKey(record, bindings) {
  const fields = record.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.creator.name]);
  const startMs = Number(fields[bindings.start.name]);
  const endMs = Number(fields[bindings.end.name]);
  return creatorIds.length === 1 && Number.isFinite(startMs) && Number.isFinite(endMs)
    ? `${creatorIds[0]}:${startMs}:${endMs}`
    : null;
}

async function inspectArchive({ archive, config, client }) {
  validateRestoreArchive(archive, config);
  const current = await currentRuntime(config, client);
  const creators = await current.client.listRecords(config.appToken, config.creatorTableId);
  const creatorIds = new Set(creators.map((record) => record.record_id));
  const byKey = new Map();
  for (const record of current.records) {
    const key = storedRestoreKey(record, current.bindings);
    if (!key) continue;
    const matches = byKey.get(key) ?? [];
    matches.push(record);
    byKey.set(key, matches);
  }
  const pending = [];
  const alreadyRestored = [];
  const conflicts = [];
  for (const archived of archive.records) {
    const values = archived.values;
    if (!creatorIds.has(values.creator_record_id)) {
      conflicts.push({ restore_key: archived.restore_key, reason: "creator_record_missing" });
      continue;
    }
    const matches = byKey.get(archived.restore_key) ?? [];
    if (matches.length > 1) {
      conflicts.push({ restore_key: archived.restore_key, reason: "duplicate_existing_live_records" });
      continue;
    }
    if (matches.length === 1) {
      const rawLikes = matches[0].fields?.[current.bindings.likes.name];
      const storedLikes = parseCount(rawLikes);
      if ((countIsPresent(rawLikes) && storedLikes === null) || storedLikes !== values.like_count) {
        conflicts.push({ restore_key: archived.restore_key, reason: "existing_like_count_differs" });
      } else {
        alreadyRestored.push({ restore_key: archived.restore_key, record_id: matches[0].record_id });
      }
      continue;
    }
    pending.push(archived);
  }
  return {
    status: conflicts.length ? "blocked" : pending.length ? "ready" : "unchanged",
    mode: "live-history-compaction-restore",
    dry_run: true,
    archive_sha256: archive.archive_sha256,
    archived_record_count: archive.records.length,
    create_count: pending.length,
    already_restored_count: alreadyRestored.length,
    conflict_count: conflicts.length,
    pending,
    already_restored: alreadyRestored,
    conflicts,
    client: current.client,
    bindings: current.bindings,
  };
}

function restorePayload(item, bindings) {
  const fields = {
    [bindings.start.name]: item.values.start_ms,
    [bindings.end.name]: item.values.end_ms,
    [bindings.creator.name]: [item.values.creator_record_id],
  };
  if (item.values.like_count !== null) fields[bindings.likes.name] = item.values.like_count;
  return { fields };
}

export async function restoreArchive({ archive, config, apply = false, expectArchiveSha256, confirmRestore, client }) {
  const dryRun = await inspectArchive({ archive, config, client });
  if (!apply) {
    const { pending, already_restored, conflicts, client: ignoredClient, bindings: ignoredBindings, ...report } = dryRun;
    return report;
  }
  assert(dryRun.status !== "blocked", "archive conflicts block restore");
  assert(expectArchiveSha256 === archive.archive_sha256, "--expect-archive-sha256 does not match archive");
  assert(Number(confirmRestore) === dryRun.create_count, "--confirm-restore does not match current dry-run count");
  if (dryRun.create_count === 0) return { status: "unchanged", dry_run: false, created_count: 0, verified: true };
  let writeError = null;
  try {
    for (let index = 0; index < dryRun.pending.length; index += BATCH_SIZE) {
      const records = dryRun.pending.slice(index, index + BATCH_SIZE).map((item) => restorePayload(item, dryRun.bindings));
      await dryRun.client.batchCreate(config.appToken, config.tableId, records);
    }
  } catch (error) {
    writeError = error;
  }
  let verification;
  for (const delayMs of [0, 500, 1500, 3000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    verification = await inspectArchive({ archive, config, client: dryRun.client });
    if (verification.create_count === 0 && verification.conflict_count === 0) break;
  }
  if (verification.create_count || verification.conflict_count) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-restore verification failed";
    throw new Error(`${reason}; missing=${verification.create_count}; conflicts=${verification.conflict_count}; automatic retry is disabled`);
  }
  return {
    status: "success",
    mode: "live-history-compaction-restore",
    dry_run: false,
    archive_sha256: archive.archive_sha256,
    requested_create_count: dryRun.create_count,
    created_count: dryRun.create_count,
    verified_restored_count: verification.already_restored_count,
    verified: true,
    recovered_from_ambiguous_response: Boolean(writeError),
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
    "  node lark_live_history_compact.mjs plan --config CONFIG.json --output PLAN.json",
    "  node lark_live_history_compact.mjs archive --config CONFIG.json --plan PLAN.json --output-dir PRIVATE_DIR",
    "  node lark_live_history_compact.mjs receipt --config CONFIG.json --plan PLAN.json --archive ARCHIVE.json.gz --output RECEIPT.json --drive-file-id ID --drive-file-url URL --drive-file-name NAME --verified-file-sha256 HASH",
    "  node lark_live_history_compact.mjs apply --config CONFIG.json --plan PLAN.json [--archive-receipt RECEIPT.json --apply --expect-sha256 HASH --confirm-delete COUNT]",
    "  node lark_live_history_compact.mjs restore --config CONFIG.json --archive ARCHIVE.json.gz [--apply --expect-archive-sha256 HASH --confirm-restore COUNT]",
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
  } else if (command === "archive") {
    const plan = await readPrivateJson(path.resolve(options.plan));
    result = await createArchive({ plan, config, outputDir: options.outputDir });
  } else if (command === "receipt") {
    const plan = await readPrivateJson(path.resolve(options.plan));
    result = await createReceipt({
      plan,
      archivePath: options.archive,
      config,
      output: options.output,
      fileMetadata: {
        file_id: options.driveFileId,
        folder_id: config.archiveDestination.folderId,
        file_name: options.driveFileName,
        file_url: options.driveFileUrl,
        file_sha256: options.verifiedFileSha256,
      },
    });
  } else if (command === "apply") {
    const plan = await readPrivateJson(path.resolve(options.plan));
    const receipt = options.archiveReceipt ? await readPrivateJson(path.resolve(options.archiveReceipt)) : null;
    result = await applyPlan({ plan, receipt, config, apply: options.apply, expectSha256: options.expectSha256, confirmDelete: options.confirmDelete });
  } else if (command === "restore") {
    const archiveRead = await readPrivateGzipJson(options.archive);
    validateRestoreArchive(archiveRead.archive, config);
    result = await restoreArchive({ archive: archiveRead.archive, config, apply: options.apply, expectArchiveSha256: options.expectArchiveSha256, confirmRestore: options.confirmRestore });
    result.archive_file_sha256 = archiveRead.file_sha256;
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
