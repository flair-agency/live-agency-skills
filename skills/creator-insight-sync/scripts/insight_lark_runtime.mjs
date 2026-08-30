import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  INSIGHT_CONTEXT_KIND,
  buildInsightPlan,
  calculateContextSha256,
  insightPlanIsBlocked,
  isRecordId,
  normalizeAccountKey,
  validateInsightContext,
  validateInsightPlan,
  validateInsightProposals,
} from "./insight_sync_core.mjs";

const BATCH_SIZE = 500;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export { writePrivateJson };

export async function loadInsightConfig(filePath) {
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of [
    "appToken",
    "creatorTableId",
    "profileTableId",
    "metricTableId",
    "tagTableId",
    "insightViewId",
  ]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const keys = [
    "creatorAccount",
    "creatorInsight",
    "creatorTraits",
    "profileTimestamp",
    "profileCreator",
    "profileFeatureObservationData",
    "metricTimestamp",
    "metricCreator",
    "metricFanClub",
    "metricLatestLiveAt",
    "metricLiveDays30d",
    "metricLiveHours30d",
    "metricLikes30d",
    "tagVocabulary",
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
    profileTableId: raw.profileTableId.trim(),
    metricTableId: raw.metricTableId.trim(),
    tagTableId: raw.tagTableId.trim(),
    insightViewId: raw.insightViewId.trim(),
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

function optionNames(binding) {
  return [...new Set((binding.property?.options ?? []).map((option) => String(option.name ?? "").trim()).filter(Boolean))].sort();
}

export function resolveInsightFields(creatorFields, profileFields, metricFields, tagFields, config) {
  const creator = fieldMap(creatorFields);
  const profile = fieldMap(profileFields);
  const metric = fieldMap(metricFields);
  const tags = fieldMap(tagFields);
  const bindings = {
    creator: {
      account: bind(creator, config.fieldIds.creatorAccount, ["Url", "Text"], "creator account"),
      insight: bind(creator, config.fieldIds.creatorInsight, ["Text"], "creator insight"),
      traits: bind(creator, config.fieldIds.creatorTraits, ["MultiSelect"], "creator traits"),
    },
    profile: {
      timestamp: bind(profile, config.fieldIds.profileTimestamp, ["DateTime", "CreatedTime"], "profile timestamp"),
      creator: relation(
        bind(profile, config.fieldIds.profileCreator, ["DuplexLink"], "profile creator"),
        config.creatorTableId,
        "profile creator",
      ),
      featureObservationData: bind(
        profile,
        config.fieldIds.profileFeatureObservationData,
        ["Text"],
        "profile feature observation data",
      ),
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
      likes30d: bind(metric, config.fieldIds.metricLikes30d, ["Number"], "metric likes"),
    },
    tags: {
      vocabulary: bind(tags, config.fieldIds.tagVocabulary, ["MultiSelect"], "tag vocabulary"),
    },
  };
  const approvedTraits = optionNames(bindings.tags.vocabulary);
  assert(approvedTraits.length > 0, "approved trait vocabulary is empty");
  const creatorTraits = optionNames(bindings.creator.traits);
  assert(JSON.stringify(creatorTraits) === JSON.stringify(approvedTraits), "creator trait options differ from the approved tag table");
  return { bindings, approvedTraits };
}

async function resolveBindings(client, config) {
  const [creatorFields, profileFields, metricFields, tagFields] = await Promise.all([
    client.listFields(config.appToken, config.creatorTableId),
    client.listFields(config.appToken, config.profileTableId),
    client.listFields(config.appToken, config.metricTableId),
    client.listFields(config.appToken, config.tagTableId),
  ]);
  return resolveInsightFields(creatorFields, profileFields, metricFields, tagFields, config);
}

function unwrap(value) {
  if (Array.isArray(value)) return value.length === 1 ? unwrap(value[0]) : value.length ? value : null;
  if (value && typeof value === "object") {
    if ("value" in value) return unwrap(value.value);
    if ("text" in value) return unwrap(value.text);
  }
  return value;
}

function textValue(value) {
  const scalar = unwrap(value);
  if (scalar === null || scalar === undefined || scalar === "") return "";
  return typeof scalar === "string" ? scalar : String(scalar);
}

function multiSelectValues(value) {
  if (value === null || value === undefined || value === "") return [];
  const array = Array.isArray(value) ? value : [value];
  const values = array.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") return String(entry.name ?? entry.text ?? entry.value ?? "");
    return "";
  }).map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(values)].sort();
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

function accountText(value) {
  return textValue(value).trim();
}

function selectCreators({ records, bindings, mode, selectedAccounts, targetRecordIds, limit }) {
  const rows = records.map((record, index) => {
    const creatorRecordId = String(record.record_id ?? "");
    const accountKey = normalizeAccountKey(accountText(record.fields?.[bindings.creator.account.name]));
    assert(isRecordId(creatorRecordId), `creator row ${index + 1} record ID is invalid`);
    assert(accountKey, `creator row ${index + 1} account is invalid`);
    return { record, creatorRecordId, accountKey };
  });
  const byId = new Map(rows.map((row) => [row.creatorRecordId, row]));
  const byAccount = new Map();
  for (const row of rows) {
    assert(!byAccount.has(row.accountKey), `creator account is duplicated: ${row.accountKey}`);
    byAccount.set(row.accountKey, row);
  }
  if (targetRecordIds) {
    return targetRecordIds.map((recordId) => {
      const row = byId.get(recordId);
      assert(row, `target creator record is missing: ${recordId}`);
      return row;
    });
  }
  if (mode === "selected") {
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
  return rows.slice(0, limit);
}

function normalizedProfiles(records, bindings, selectedIds) {
  const byCreator = new Map();
  for (const [index, record] of records.entries()) {
    const fields = record.fields ?? {};
    const creatorIds = linkedRecordIds(fields[bindings.profile.creator.name]);
    const timestampMs = Number(fields[bindings.profile.timestamp.name]);
    assert(creatorIds.length === 1, `profile row ${index + 1} creator link is invalid`);
    assert(Number.isFinite(timestampMs), `profile row ${index + 1} timestamp is invalid`);
    if (!selectedIds.has(creatorIds[0])) continue;
    const raw = textValue(fields[bindings.profile.featureObservationData.name]);
    let data = null;
    let valid = true;
    if (raw) {
      try {
        data = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isSafeInteger(data.schema_version)) {
          valid = false;
        }
      } catch {
        valid = false;
      }
    }
    const rows = byCreator.get(creatorIds[0]) ?? [];
    rows.push({ recordId: record.record_id, timestampMs, rawPresent: Boolean(raw), valid, data });
    byCreator.set(creatorIds[0], rows);
  }
  for (const rows of byCreator.values()) rows.sort((left, right) => right.timestampMs - left.timestampMs || right.recordId.localeCompare(left.recordId));
  return byCreator;
}

function normalizedMetrics(records, bindings, selectedIds) {
  const byCreator = new Map();
  for (const [index, record] of records.entries()) {
    const fields = record.fields ?? {};
    const creatorIds = linkedRecordIds(fields[bindings.metric.creator.name]);
    const timestampMs = Number(fields[bindings.metric.timestamp.name]);
    assert(creatorIds.length === 1, `LIVE metric row ${index + 1} creator link is invalid`);
    assert(Number.isFinite(timestampMs), `LIVE metric row ${index + 1} timestamp is invalid`);
    if (!selectedIds.has(creatorIds[0])) continue;
    const fanClub = numberValue(fields[bindings.metric.fanClub.name], { integer: true });
    const latestLiveAtMs = dateValue(fields[bindings.metric.latestLiveAt.name]);
    const liveDays30d = numberValue(fields[bindings.metric.liveDays30d.name], { integer: true });
    const liveHours30d = numberValue(fields[bindings.metric.liveHours30d.name]);
    const likes30d = numberValue(fields[bindings.metric.likes30d.name], { integer: true });
    const invalid = [fanClub, latestLiveAtMs, liveDays30d, liveHours30d, likes30d].some((value) => value === undefined);
    const complete = !invalid && liveDays30d !== null && liveHours30d !== null && likes30d !== null;
    const rows = byCreator.get(creatorIds[0]) ?? [];
    rows.push({
      recordId: record.record_id,
      timestampMs,
      valid: !invalid,
      complete,
      fanClub,
      latestLiveAtMs,
      liveDays30d,
      liveHours30d,
      likes30d,
    });
    byCreator.set(creatorIds[0], rows);
  }
  for (const rows of byCreator.values()) rows.sort((left, right) => right.timestampMs - left.timestampMs || right.recordId.localeCompare(left.recordId));
  return byCreator;
}

function profileSelection(rows = []) {
  const latestValid = rows.find((row) => row.rawPresent && row.valid) ?? null;
  const blockingInvalid = rows.some(
    (row) => row.rawPresent && !row.valid && (!latestValid || row.timestampMs >= latestValid.timestampMs),
  );
  return {
    readiness: blockingInvalid ? "invalid_profile" : latestValid ? "ready" : "missing_profile",
    latestProfile: blockingInvalid || !latestValid ? null : {
      recordId: latestValid.recordId,
      observedAt: new Date(latestValid.timestampMs).toISOString(),
      featureObservationData: latestValid.data,
    },
    newerBlankProfileCount: latestValid
      ? rows.filter((row) => !row.rawPresent && row.timestampMs > latestValid.timestampMs).length
      : rows.filter((row) => !row.rawPresent).length,
  };
}

function metricSelection(rows = []) {
  const latest = rows.find((row) => row.complete) ?? null;
  return {
    latestLiveMetric: latest ? {
      recordId: latest.recordId,
      measuredAt: new Date(latest.timestampMs).toISOString(),
      fanClub: latest.fanClub,
      latestLiveAt: latest.latestLiveAtMs === null ? null : new Date(latest.latestLiveAtMs).toISOString(),
      liveDays30d: latest.liveDays30d,
      liveHours30d: latest.liveHours30d,
      likes30d: latest.likes30d,
    } : null,
    newerIncompleteMetricCount: latest
      ? rows.filter((row) => !row.complete && row.timestampMs > latest.timestampMs).length
      : rows.filter((row) => !row.complete).length,
  };
}

export async function buildInsightContext({
  client,
  config,
  mode = "due",
  selectedAccounts = [],
  targetRecordIds = null,
  limit = 100,
  nowMs = Date.now(),
}) {
  assert(["due", "selected", "all"].includes(mode), "insight target mode is invalid");
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, "insight limit must be between 1 and 500");
  const { bindings, approvedTraits } = await resolveBindings(client, config);
  const query = targetRecordIds ? {} : mode === "due" ? { view_id: config.insightViewId } : {};
  const [creatorRecords, profileRecords, metricRecords] = await Promise.all([
    client.listRecords(config.appToken, config.creatorTableId, query),
    client.listRecords(config.appToken, config.profileTableId),
    client.listRecords(config.appToken, config.metricTableId),
  ]);
  const selected = selectCreators({
    records: creatorRecords,
    bindings,
    mode,
    selectedAccounts,
    targetRecordIds,
    limit,
  });
  const selectedIds = new Set(selected.map((row) => row.creatorRecordId));
  const profiles = normalizedProfiles(profileRecords, bindings, selectedIds);
  const metrics = normalizedMetrics(metricRecords, bindings, selectedIds);
  const rows = selected.map(({ record, creatorRecordId, accountKey }) => ({
    creatorRecordId,
    accountKey,
    currentInsight: textValue(record.fields?.[bindings.creator.insight.name]),
    currentTraits: multiSelectValues(record.fields?.[bindings.creator.traits.name]),
    ...profileSelection(profiles.get(creatorRecordId)),
    ...metricSelection(metrics.get(creatorRecordId)),
  }));
  const context = {
    version: 1,
    inputKind: INSIGHT_CONTEXT_KIND,
    generatedAt: new Date(nowMs).toISOString(),
    approvedTraits,
    rowCount: rows.length,
    rows,
  };
  context.contextSha256 = calculateContextSha256(context);
  return { context: validateInsightContext(context), bindings };
}

export async function prepareInsightPlan({ client, config, context, proposals, nowMs = Date.now() }) {
  validateInsightContext(context);
  validateInsightProposals(proposals, context);
  const targetRecordIds = context.rows.map((row) => row.creatorRecordId);
  const current = await buildInsightContext({ client, config, targetRecordIds, nowMs });
  const plan = buildInsightPlan({ context, proposals, currentContext: current.context, nowMs });
  return { plan, bindings: current.bindings };
}

async function updateInBatches(client, appToken, tableId, records) {
  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    await client.batchUpdate(appToken, tableId, records.slice(index, index + BATCH_SIZE));
  }
}

export async function applyInsightPlan({
  client,
  config,
  reviewedPlan,
  apply = false,
  expectSha256,
  confirmUpdate,
}) {
  validateInsightPlan(reviewedPlan);
  const current = await prepareInsightPlan({
    client,
    config,
    context: reviewedPlan.inputs.context,
    proposals: reviewedPlan.inputs.proposals,
    nowMs: reviewedPlan.builtAtMs,
  });
  const plan = current.plan;
  const report = {
    status: insightPlanIsBlocked(plan) ? "blocked" : plan.summary.updateCount ? "ready" : "unchanged",
    dryRun: true,
    planSha256: plan.planSha256,
    ...plan.summary,
  };
  if (plan.planSha256 !== reviewedPlan.planSha256) {
    return { ...report, status: "blocked", stalePlanCount: 1 };
  }
  if (!apply) return { ...report, stalePlanCount: 0 };
  assert(!insightPlanIsBlocked(plan), "blocking issues prevent insight apply");
  assert(expectSha256 === plan.planSha256, "--expect-sha256 does not match the current insight plan");
  assert(Number(confirmUpdate) === plan.summary.updateCount, "--confirm-update does not match");
  if (!plan.summary.updateCount) {
    return { ...report, dryRun: false, status: "unchanged", verified: true };
  }

  let writeError = null;
  try {
    await updateInBatches(
      client,
      config.appToken,
      config.creatorTableId,
      plan.operations.updates.map((item) => ({
        record_id: item.creatorRecordId,
        fields: {
          [current.bindings.creator.insight.name]: item.proposedInsight,
          [current.bindings.creator.traits.name]: item.proposedTraits,
        },
      })),
    );
  } catch (error) {
    writeError = error;
  }

  const verification = await buildInsightContext({
    client,
    config,
    targetRecordIds: reviewedPlan.inputs.context.rows.map((row) => row.creatorRecordId),
    nowMs: reviewedPlan.builtAtMs,
  });
  const verifiedById = new Map(verification.context.rows.map((row) => [row.creatorRecordId, row]));
  const failed = plan.operations.updates.filter((item) => {
    const row = verifiedById.get(item.creatorRecordId);
    return !row || row.currentInsight !== item.proposedInsight ||
      JSON.stringify([...row.currentTraits].sort()) !== JSON.stringify([...item.proposedTraits].sort());
  });
  if (failed.length) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-write verification failed";
    throw new Error(`${reason}; unverified updates=${failed.length}; automatic retry is disabled`);
  }
  return {
    status: "success",
    dryRun: false,
    planSha256: plan.planSha256,
    updatedCount: plan.summary.updateCount,
    verified: true,
    recoveredFromAmbiguousResponse: Boolean(writeError),
  };
}
