import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  LIVE_HISTORY_TARGET_INPUT_KIND,
  buildLiveHistorySyncPlan,
  isRecordId,
  linkedRecordIds,
  livePlanIsBlocked,
  normalizeAccountKey,
  recalculateLivePlanSha256,
  sha256Json,
  validateLiveHistorySyncPlan,
  validateLiveTargetManifest,
} from "./live_history_sync_core.mjs";

const KNOWN_EVENT_LIMIT = 20;
const LIVE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const CREATOR_SUMMARY_SETTLE_MS = 3000;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export { writePrivateJson };

export async function loadLiveHistoryConfig(filePath) {
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of [
    "appToken",
    "creatorTableId",
    "liveTableId",
    "metricTableId",
    "dueViewId",
  ]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const keys = [
    "creatorAccount",
    "creatorLatestLiveAt",
    "creatorLiveDays30d",
    "creatorLiveHours30d",
    "creatorLikes30d",
    "liveStart",
    "liveEnd",
    "liveCreator",
    "liveLikes",
    "metricTimestamp",
    "metricCreator",
    "metricFanClub",
    "metricLatestLiveAt",
    "metricLiveDays30d",
    "metricLiveHours30d",
    "metricLikes30d",
  ];
  assert(raw.fieldIds && typeof raw.fieldIds === "object", "configuration fieldIds is required");
  const values = keys.map((key) => {
    const value = raw.fieldIds[key];
    assert(typeof value === "string" && value.trim(), `configuration fieldIds.${key} is required`);
    return value.trim();
  });
  assert(new Set(values).size === values.length, "configuration field IDs must be distinct");
  return {
    appToken: raw.appToken.trim(),
    creatorTableId: raw.creatorTableId.trim(),
    liveTableId: raw.liveTableId.trim(),
    metricTableId: raw.metricTableId.trim(),
    dueViewId: raw.dueViewId.trim(),
    fieldIds: Object.fromEntries(keys.map((key, index) => [key, values[index]])),
    credentials: typeof raw.credentials?.larkKeychainService === "string" && raw.credentials.larkKeychainService.trim()
      ? { larkKeychainService: raw.credentials.larkKeychainService.trim() }
      : {},
    apiOrigin: typeof raw.apiOrigin === "string" && raw.apiOrigin.trim()
      ? raw.apiOrigin.trim()
      : "https://open.larksuite.com",
  };
}

function fieldMap(fields) {
  const result = new Map();
  for (const field of fields) {
    if (typeof field?.field_id !== "string") continue;
    const matches = result.get(field.field_id) ?? [];
    matches.push(field);
    result.set(field.field_id, matches);
  }
  return result;
}

function bind(byId, id, allowedTypes, label) {
  const matches = byId.get(id) ?? [];
  assert(matches.length === 1, matches.length ? `${label} field ID is duplicated` : `${label} field ID is missing`);
  const field = matches[0];
  const uiType = String(field.ui_type ?? "");
  assert(allowedTypes.includes(uiType), `${label} field type must be ${allowedTypes.join(" or ")}; live=${uiType}`);
  assert(typeof field.field_name === "string" && field.field_name, `${label} current field name is missing`);
  return { id, name: field.field_name, type: uiType, property: field.property ?? null };
}

function relation(binding, tableId, label) {
  assert(binding.property?.table_id === tableId, `${label} relation target changed`);
  assert(binding.property?.multiple === false, `${label} relation must be single-value`);
  return binding;
}

export function resolveLiveHistoryFields(creatorFields, liveFields, metricFields, config) {
  const creator = fieldMap(creatorFields);
  const live = fieldMap(liveFields);
  const metric = fieldMap(metricFields);
  const calculatedTypes = ["Lookup", "Formula", "Number", "DateTime"];
  const bindings = {
    creator: {
      account: bind(creator, config.fieldIds.creatorAccount, ["Url", "Text"], "creator account"),
      latestLiveAt: bind(creator, config.fieldIds.creatorLatestLiveAt, calculatedTypes, "creator latest live"),
      liveDays30d: bind(creator, config.fieldIds.creatorLiveDays30d, calculatedTypes, "creator live days"),
      liveHours30d: bind(creator, config.fieldIds.creatorLiveHours30d, calculatedTypes, "creator live hours"),
      likes30d: bind(creator, config.fieldIds.creatorLikes30d, calculatedTypes, "creator live likes"),
    },
    live: {
      start: bind(live, config.fieldIds.liveStart, ["DateTime"], "live start"),
      end: bind(live, config.fieldIds.liveEnd, ["DateTime"], "live end"),
      creator: relation(
        bind(live, config.fieldIds.liveCreator, ["DuplexLink"], "live creator"),
        config.creatorTableId,
        "live creator",
      ),
      likes: bind(live, config.fieldIds.liveLikes, ["Number"], "live likes"),
    },
    metric: {
      timestamp: bind(metric, config.fieldIds.metricTimestamp, ["DateTime"], "metric timestamp"),
      creator: relation(
        bind(metric, config.fieldIds.metricCreator, ["DuplexLink"], "metric creator"),
        config.creatorTableId,
        "metric creator",
      ),
      fanClub: bind(metric, config.fieldIds.metricFanClub, ["Number"], "metric fan club"),
      latestLiveAt: bind(metric, config.fieldIds.metricLatestLiveAt, ["DateTime"], "metric latest live"),
      liveDays30d: bind(metric, config.fieldIds.metricLiveDays30d, ["Number"], "metric live days"),
      liveHours30d: bind(metric, config.fieldIds.metricLiveHours30d, ["Number"], "metric live hours"),
      likes30d: bind(metric, config.fieldIds.metricLikes30d, ["Number"], "metric live likes"),
    },
  };
  for (const group of ["creator", "live", "metric"]) {
    const names = Object.values(bindings[group]).map((field) => field.name);
    assert(new Set(names).size === names.length, `resolved ${group} field names must be unique`);
  }
  return bindings;
}

async function resolveBindings(client, config) {
  const creatorFields = await client.listFields(config.appToken, config.creatorTableId);
  const liveFields = await client.listFields(config.appToken, config.liveTableId);
  const metricFields = await client.listFields(config.appToken, config.metricTableId);
  return resolveLiveHistoryFields(creatorFields, liveFields, metricFields, config);
}

function accountText(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof value.text === "string") return value.text.trim();
  return "";
}

function selectTargetRows({ records, accountFieldName, mode, selectedAccounts, limit }) {
  const rows = records.map((record, index) => {
    const accountKey = normalizeAccountKey(accountText(record.fields?.[accountFieldName]));
    assert(isRecordId(record.record_id), `creator row ${index + 1} record ID is invalid`);
    assert(accountKey, `creator row ${index + 1} account is invalid`);
    return { creatorRecordId: record.record_id, accountKey };
  });
  const byAccount = new Map();
  for (const row of rows) {
    assert(!byAccount.has(row.accountKey), `creator account is duplicated: ${row.accountKey}`);
    byAccount.set(row.accountKey, row);
  }
  if (mode !== "selected") return rows.slice(0, limit);
  const seen = new Set();
  return selectedAccounts.map((value) => {
    const accountKey = normalizeAccountKey(value);
    assert(accountKey && !seen.has(accountKey), `selected account is invalid or duplicated: ${value}`);
    seen.add(accountKey);
    const row = byAccount.get(accountKey);
    assert(row, `selected account is absent from Lark: ${value}`);
    return row;
  }).slice(0, limit);
}

function knownLives(liveRecords, bindings) {
  const byCreator = new Map();
  const seenKeys = new Set();
  for (const [index, record] of liveRecords.entries()) {
    const fields = record.fields ?? {};
    const creatorIds = linkedRecordIds(fields[bindings.live.creator.name]);
    const startMs = Number(fields[bindings.live.start.name]);
    const endMs = Number(fields[bindings.live.end.name]);
    assert(creatorIds.length === 1, `stored live row ${index + 1} creator link is invalid`);
    assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs, `stored live row ${index + 1} timestamps are invalid`);
    const key = `${creatorIds[0]}:${startMs}:${endMs}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const rows = byCreator.get(creatorIds[0]) ?? [];
    rows.push({ startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() });
    byCreator.set(creatorIds[0], rows);
  }
  for (const rows of byCreator.values()) {
    rows.sort((left, right) => Date.parse(right.startAt) - Date.parse(left.startAt));
    rows.splice(KNOWN_EVENT_LIMIT);
  }
  return byCreator;
}

export async function exportLiveHistoryTargets({
  client,
  config,
  mode = "due",
  selectedAccounts = [],
  limit = 20,
  nowMs = Date.now(),
}) {
  assert(["due", "selected", "all"].includes(mode), "target mode is invalid");
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "limit must be between 1 and 100");
  assert(mode === "selected" || selectedAccounts.length === 0, "selected accounts require selected mode");
  const bindings = await resolveBindings(client, config);
  const query = mode === "due" ? { view_id: config.dueViewId } : {};
  const creatorRecords = await client.listRecords(config.appToken, config.creatorTableId, query);
  const liveRecords = await client.listRecords(config.appToken, config.liveTableId);
  const selected = selectTargetRows({
    records: creatorRecords,
    accountFieldName: bindings.creator.account.name,
    mode,
    selectedAccounts,
    limit,
  });
  const history = knownLives(liveRecords, bindings);
  const rows = selected.map((row) => ({
    ...row,
    liveContext: {
      cutoffAt: new Date(nowMs - LIVE_LOOKBACK_MS).toISOString(),
      knownEvents: history.get(row.creatorRecordId) ?? [],
    },
  }));
  const manifest = {
    version: 1,
    inputKind: LIVE_HISTORY_TARGET_INPUT_KIND,
    generatedAt: new Date(nowMs).toISOString(),
    targetMode: mode,
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
  return validateLiveTargetManifest(manifest);
}

function verifyTargets({ manifest, bindings, allCreators, dueCreators }) {
  const allById = new Map(allCreators.map((record) => [String(record.record_id ?? ""), record]));
  const dueIds = new Set(dueCreators.map((record) => String(record.record_id ?? "")));
  const accounts = new Map();
  for (const record of allCreators) {
    const accountKey = normalizeAccountKey(accountText(record.fields?.[bindings.creator.account.name]));
    if (!accountKey) continue;
    const ids = accounts.get(accountKey) ?? [];
    ids.push(record.record_id);
    accounts.set(accountKey, ids);
  }
  const issues = [];
  for (const row of manifest.rows) {
    const current = allById.get(row.creatorRecordId);
    const expected = normalizeAccountKey(row.accountKey);
    if (!current) issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_record_missing" });
    else if (normalizeAccountKey(accountText(current.fields?.[bindings.creator.account.name])) !== expected) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_account_changed" });
    } else if ((accounts.get(expected) ?? []).length !== 1) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_account_not_unique" });
    } else if (manifest.targetMode === "due" && !dueIds.has(row.creatorRecordId)) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "not_in_due_view" });
    }
  }
  return issues;
}

function unwrap(value) {
  if (Array.isArray(value)) return value.length === 1 ? unwrap(value[0]) : value.length ? undefined : null;
  if (value && typeof value === "object") {
    if ("value" in value) return unwrap(value.value);
    if ("text" in value) return unwrap(value.text);
  }
  return value;
}

function numberValue(value, { integer = false } = {}) {
  const scalar = unwrap(value);
  if (scalar === null || scalar === undefined || scalar === "") return null;
  const number = typeof scalar === "number" ? scalar : Number(String(scalar).replaceAll(",", ""));
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) return undefined;
  return number;
}

function dateValue(value) {
  const scalar = unwrap(value);
  if (scalar === null || scalar === undefined || scalar === "") return null;
  const number = typeof scalar === "number" ? scalar : Date.parse(String(scalar));
  return Number.isFinite(number) ? number : undefined;
}

function summaryIsComplete(summary) {
  const values = Object.values(summary);
  if (values.some((value) => value === undefined)) return false;
  const populated = values.every((value) => value !== null);
  const noHistory = values.every((value) => value === null);
  return populated || noHistory;
}

function summaryFromCreator(record, bindings) {
  const fields = record?.fields ?? {};
  const summary = {
    latestLiveAtMs: dateValue(fields[bindings.creator.latestLiveAt.name]),
    liveDays30d: numberValue(fields[bindings.creator.liveDays30d.name], { integer: true }),
    liveHours30d: numberValue(fields[bindings.creator.liveHours30d.name]),
    likes30d: numberValue(fields[bindings.creator.likes30d.name], { integer: true }),
  };
  return {
    ...summary,
    complete: summaryIsComplete(summary),
  };
}

export async function prepareLiveHistoryPlan({ client, config, manifest, observations, nowMs = Date.now() }) {
  const bindings = await resolveBindings(client, config);
  const creatorRecords = await client.listRecords(config.appToken, config.creatorTableId);
  const dueCreators = manifest.targetMode === "due"
    ? await client.listRecords(config.appToken, config.creatorTableId, { view_id: config.dueViewId })
    : [];
  const liveRecords = await client.listRecords(config.appToken, config.liveTableId);
  const metricRecords = await client.listRecords(config.appToken, config.metricTableId);
  const targetIssues = verifyTargets({ manifest, bindings, allCreators: creatorRecords, dueCreators });
  let plan = buildLiveHistorySyncPlan({ manifest, observations, liveRecords, metricRecords, bindings, nowMs });
  if (targetIssues.length) plan.operations.targetIssues.push(...targetIssues);
  plan.summary.targetIssueCount = plan.operations.targetIssues.length;
  plan = recalculateLivePlanSha256(plan);
  return { plan, bindings, creatorRecords, liveRecords, metricRecords };
}

function livePayload(item, bindings) {
  const fields = {
    [bindings.live.start.name]: item.startMs,
    [bindings.live.end.name]: item.endMs,
    [bindings.live.creator.name]: [item.creatorRecordId],
  };
  if (item.likeCount !== null) fields[bindings.live.likes.name] = item.likeCount;
  return { fields };
}

function metricPayload(item, bindings) {
  const fields = {
    [bindings.metric.timestamp.name]: item.observedAtMs,
    [bindings.metric.creator.name]: [item.creatorRecordId],
  };
  if (item.fanClubCount !== null) fields[bindings.metric.fanClub.name] = item.fanClubCount;
  return { fields };
}

async function createInBatches(client, appToken, tableId, records) {
  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    await client.batchCreate(appToken, tableId, records.slice(index, index + BATCH_SIZE));
  }
}

async function requireCreatorSummaries({
  client,
  config,
  bindings,
  metricItems,
  liveCreates,
  preflightCreatorRecords,
}) {
  if (!metricItems.length) return;
  const latestCreated = new Map();
  for (const item of liveCreates) {
    latestCreated.set(
      item.creatorRecordId,
      Math.max(latestCreated.get(item.creatorRecordId) ?? -Infinity, item.startMs),
    );
  }
  let records = preflightCreatorRecords;
  if (liveCreates.length) {
    await new Promise((resolve) => setTimeout(resolve, CREATOR_SUMMARY_SETTLE_MS));
    records = await client.listRecords(config.appToken, config.creatorTableId);
  }
  const byId = new Map(records.map((record) => [String(record.record_id ?? ""), record]));
  const missing = [];
  for (const item of metricItems) {
    const summary = summaryFromCreator(byId.get(item.creatorRecordId), bindings);
    const expectedLatest = latestCreated.get(item.creatorRecordId);
    if (!summary.complete || (expectedLatest !== undefined && (summary.latestLiveAtMs ?? -Infinity) < expectedLatest)) {
      missing.push(item.creatorRecordId);
    }
  }
  if (missing.length) {
    throw new Error(`creator LIVE summaries are incomplete for ${missing.length} metric rows; automatic polling is disabled`);
  }
}

export async function applyLiveHistoryPlan({
  client,
  config,
  reviewedPlan,
  apply = false,
  expectSha256,
  confirmLiveCreate,
  confirmMetricCreate,
}) {
  validateLiveHistorySyncPlan(reviewedPlan);
  const current = await prepareLiveHistoryPlan({
    client,
    config,
    manifest: reviewedPlan.inputs.manifest,
    observations: reviewedPlan.inputs.observations,
    nowMs: reviewedPlan.builtAtMs,
  });
  const plan = current.plan;
  const operationCount = plan.summary.liveCreateCount + plan.summary.metricCreateCount;
  const report = {
    status: livePlanIsBlocked(plan) ? "blocked" : operationCount ? "ready" : "unchanged",
    dryRun: true,
    flowVerification: "not_run",
    planSha256: plan.planSha256,
    ...plan.summary,
  };
  if (plan.planSha256 !== reviewedPlan.planSha256) {
    return { ...report, status: "blocked", stalePlanCount: 1 };
  }
  if (!apply) return { ...report, stalePlanCount: 0 };
  assert(!livePlanIsBlocked(plan), "blocking issues prevent apply");
  assert(expectSha256 === plan.planSha256, "--expect-sha256 does not match the current plan");
  assert(Number(confirmLiveCreate) === plan.summary.liveCreateCount, "--confirm-live-create does not match");
  assert(Number(confirmMetricCreate) === plan.summary.metricCreateCount, "--confirm-metric-create does not match");
  if (!operationCount) return { ...report, dryRun: false, status: "unchanged", verified: true };

  let liveWriteError = null;
  try {
    await createInBatches(
      client,
      config.appToken,
      config.liveTableId,
      plan.operations.liveCreates.map((item) => livePayload(item, current.bindings)),
    );
  } catch (error) {
    liveWriteError = error;
  }
  let latestLiveRecords = current.liveRecords;
  let reconciledPlan = plan;
  if (plan.operations.liveCreates.length) {
    latestLiveRecords = await client.listRecords(config.appToken, config.liveTableId);
    reconciledPlan = buildLiveHistorySyncPlan({
      manifest: reviewedPlan.inputs.manifest,
      observations: reviewedPlan.inputs.observations,
      liveRecords: latestLiveRecords,
      metricRecords: current.metricRecords,
      bindings: current.bindings,
      nowMs: reviewedPlan.builtAtMs,
    });
    if (reconciledPlan.summary.liveCreateCount || reconciledPlan.summary.liveConflictCount) {
      const reason = liveWriteError ? `live write result is uncertain: ${liveWriteError.message}` : "live post-write verification failed";
      throw new Error(`${reason}; remaining lives=${reconciledPlan.summary.liveCreateCount}; automatic retry is disabled`);
    }
  }

  await requireCreatorSummaries({
    client,
    config,
    bindings: current.bindings,
    metricItems: plan.operations.metricCreates,
    liveCreates: plan.operations.liveCreates,
    preflightCreatorRecords: current.creatorRecords,
  });

  let metricWriteError = null;
  try {
    await createInBatches(
      client,
      config.appToken,
      config.metricTableId,
      plan.operations.metricCreates.map((item) => metricPayload(item, current.bindings)),
    );
  } catch (error) {
    metricWriteError = error;
  }
  if (plan.operations.metricCreates.length) {
    const latestMetricRecords = await client.listRecords(config.appToken, config.metricTableId);
    reconciledPlan = buildLiveHistorySyncPlan({
      manifest: reviewedPlan.inputs.manifest,
      observations: reviewedPlan.inputs.observations,
      liveRecords: latestLiveRecords,
      metricRecords: latestMetricRecords,
      bindings: current.bindings,
      nowMs: reviewedPlan.builtAtMs,
    });
    if (
      reconciledPlan.summary.liveCreateCount ||
      reconciledPlan.summary.metricCreateCount ||
      livePlanIsBlocked(reconciledPlan)
    ) {
      const error = metricWriteError ?? liveWriteError;
      const reason = error ? `write result is uncertain: ${error.message}` : "post-write verification failed";
      throw new Error(
        `${reason}; remaining lives=${reconciledPlan.summary.liveCreateCount}; ` +
        `remaining metrics=${reconciledPlan.summary.metricCreateCount}; automatic retry is disabled`,
      );
    }
  }
  return {
    status: "success",
    dryRun: false,
    planSha256: plan.planSha256,
    liveCreatedCount: plan.summary.liveCreateCount,
    metricCreatedCount: plan.summary.metricCreateCount,
    liveVerifiedCount: reconciledPlan.summary.liveAlreadyAppliedCount,
    metricVerifiedCount: reconciledPlan.summary.metricAlreadyAppliedCount,
    flowVerification: "not_run",
    verified: true,
    recoveredFromAmbiguousResponse: Boolean(liveWriteError || metricWriteError),
  };
}
