import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  PROFILE_TARGET_INPUT_KIND,
  buildProfileSyncPlan,
  isRecordId,
  linkedRecordIds,
  normalizeAccountKey,
  planIsBlocked,
  sha256Json,
  validateProfileSyncPlan,
  validateTargetManifest,
} from "./profile_sync_core.mjs";

const KNOWN_EVENT_LIMIT = 20;
const LIVE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export { writePrivateJson };

export async function loadProfileConfig(filePath) {
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of ["appToken", "creatorTableId", "profileTableId", "liveTableId", "dueViewId"]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const keys = [
    "creatorAccount",
    "profileTimestamp",
    "profileCreator",
    "profileFollowerCount",
    "profileCommunityCount",
    "liveStart",
    "liveEnd",
    "liveCreator",
    "liveLikes",
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
    liveTableId: raw.liveTableId.trim(),
    dueViewId: raw.dueViewId.trim(),
    fieldIds: Object.fromEntries(keys.map((key, index) => [key, values[index]])),
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

export function resolveProfileFields(creatorFields, profileFields, liveFields, config) {
  const creator = fieldMap(creatorFields);
  const profile = fieldMap(profileFields);
  const live = fieldMap(liveFields);
  const bindings = {
    creator: {
      account: bind(creator, config.fieldIds.creatorAccount, ["Url", "Text"], "creator account"),
    },
    profile: {
      timestamp: bind(profile, config.fieldIds.profileTimestamp, ["DateTime", "CreatedTime"], "profile timestamp"),
      creator: relation(
        bind(profile, config.fieldIds.profileCreator, ["DuplexLink"], "profile creator"),
        config.creatorTableId,
        "profile creator",
      ),
      followerCount: bind(profile, config.fieldIds.profileFollowerCount, ["Number"], "profile follower count"),
      communityCount: bind(profile, config.fieldIds.profileCommunityCount, ["Number"], "profile community count"),
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
  };
  const profileNames = Object.values(bindings.profile).map((value) => value.name);
  const liveNames = Object.values(bindings.live).map((value) => value.name);
  assert(new Set(profileNames).size === profileNames.length, "resolved profile field names must be unique");
  assert(new Set(liveNames).size === liveNames.length, "resolved live field names must be unique");
  return bindings;
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
  let selected;
  if (mode === "selected") {
    const seen = new Set();
    selected = selectedAccounts.map((value) => {
      const accountKey = normalizeAccountKey(value);
      assert(accountKey && !seen.has(accountKey), `selected account is invalid or duplicated: ${value}`);
      seen.add(accountKey);
      const row = byAccount.get(accountKey);
      assert(row, `selected account is absent from Lark: ${value}`);
      return row;
    });
  } else selected = rows;
  return selected.slice(0, limit);
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

async function resolveLiveBindings(client, config) {
  const [creatorFields, profileFields, liveFields] = await Promise.all([
    client.listFields(config.appToken, config.creatorTableId),
    client.listFields(config.appToken, config.profileTableId),
    client.listFields(config.appToken, config.liveTableId),
  ]);
  return resolveProfileFields(creatorFields, profileFields, liveFields, config);
}

export async function exportProfileTargets({
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
  const bindings = await resolveLiveBindings(client, config);
  const query = mode === "due" ? { view_id: config.dueViewId } : {};
  const [creatorRecords, liveRecords] = await Promise.all([
    client.listRecords(config.appToken, config.creatorTableId, query),
    client.listRecords(config.appToken, config.liveTableId),
  ]);
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
    inputKind: PROFILE_TARGET_INPUT_KIND,
    generatedAt: new Date(nowMs).toISOString(),
    targetMode: mode,
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
  return validateTargetManifest(manifest);
}

async function verifyTargets({ client, config, manifest, bindings }) {
  validateTargetManifest(manifest);
  const [allCreators, dueCreators] = await Promise.all([
    client.listRecords(config.appToken, config.creatorTableId),
    manifest.targetMode === "due"
      ? client.listRecords(config.appToken, config.creatorTableId, { view_id: config.dueViewId })
      : Promise.resolve([]),
  ]);
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
    const live = allById.get(row.creatorRecordId);
    const expected = normalizeAccountKey(row.accountKey);
    if (!live) issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_record_missing" });
    else if (normalizeAccountKey(accountText(live.fields?.[bindings.creator.account.name])) !== expected) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_account_changed" });
    } else if ((accounts.get(expected) ?? []).length !== 1) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_account_not_unique" });
    } else if (manifest.targetMode === "due" && !dueIds.has(row.creatorRecordId)) {
      issues.push({ creatorRecordId: row.creatorRecordId, reason: "not_in_due_view" });
    }
  }
  return issues;
}

export async function prepareProfilePlan({ client, config, manifest, observations, nowMs = Date.now() }) {
  const bindings = await resolveLiveBindings(client, config);
  const targetIssues = await verifyTargets({ client, config, manifest, bindings });
  const [profileRecords, liveRecords] = await Promise.all([
    client.listRecords(config.appToken, config.profileTableId),
    client.listRecords(config.appToken, config.liveTableId),
  ]);
  const plan = buildProfileSyncPlan({ manifest, observations, profileRecords, liveRecords, bindings, nowMs });
  if (targetIssues.length) {
    plan.operations.targetIssues.push(...targetIssues);
    plan.summary.targetIssueCount = plan.operations.targetIssues.length;
    const { planSha256: ignored, ...unsigned } = plan;
    plan.planSha256 = sha256Json(unsigned);
  }
  return { plan, bindings };
}

function profilePayload(item, bindings) {
  const fields = { [bindings.profile.creator.name]: [item.creatorRecordId] };
  if (item.followerCount !== null) fields[bindings.profile.followerCount.name] = item.followerCount;
  if (item.communityCount !== null) fields[bindings.profile.communityCount.name] = item.communityCount;
  return { fields };
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

async function createInBatches(client, appToken, tableId, records) {
  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    await client.batchCreate(appToken, tableId, records.slice(index, index + BATCH_SIZE));
  }
}

export async function applyProfilePlan({
  client,
  config,
  reviewedPlan,
  apply = false,
  expectSha256,
  confirmProfileCreate,
  confirmLiveCreate,
}) {
  validateProfileSyncPlan(reviewedPlan);
  const current = await prepareProfilePlan({
    client,
    config,
    manifest: reviewedPlan.inputs.manifest,
    observations: reviewedPlan.inputs.observations,
    nowMs: reviewedPlan.builtAtMs,
  });
  const plan = current.plan;
  const report = {
    status: planIsBlocked(plan) ? "blocked" : plan.summary.profileCreateCount || plan.summary.liveCreateCount ? "ready" : "unchanged",
    dryRun: true,
    planSha256: plan.planSha256,
    ...plan.summary,
  };
  if (plan.planSha256 !== reviewedPlan.planSha256) {
    return { ...report, status: "blocked", stalePlanCount: 1 };
  }
  if (!apply) return { ...report, stalePlanCount: 0 };
  assert(!planIsBlocked(plan), "blocking issues prevent apply");
  assert(expectSha256 === plan.planSha256, "--expect-sha256 does not match the current plan");
  assert(Number(confirmProfileCreate) === plan.summary.profileCreateCount, "--confirm-profile-create does not match");
  assert(Number(confirmLiveCreate) === plan.summary.liveCreateCount, "--confirm-live-create does not match");
  if (!plan.summary.profileCreateCount && !plan.summary.liveCreateCount) {
    return { ...report, dryRun: false, status: "unchanged", verified: true };
  }

  let writeError = null;
  try {
    await createInBatches(
      client,
      config.appToken,
      config.profileTableId,
      plan.operations.profileCreates.map((item) => profilePayload(item, current.bindings)),
    );
    await createInBatches(
      client,
      config.appToken,
      config.liveTableId,
      plan.operations.liveCreates.map((item) => livePayload(item, current.bindings)),
    );
  } catch (error) {
    writeError = error;
  }

  let verification;
  for (const delayMs of [0, 500, 1500, 3000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    verification = await prepareProfilePlan({
      client,
      config,
      manifest: reviewedPlan.inputs.manifest,
      observations: reviewedPlan.inputs.observations,
      nowMs: reviewedPlan.builtAtMs,
    });
    if (
      verification.plan.summary.profileCreateCount === 0 &&
      verification.plan.summary.liveCreateCount === 0 &&
      !planIsBlocked(verification.plan)
    ) break;
  }
  if (
    verification.plan.summary.profileCreateCount !== 0 ||
    verification.plan.summary.liveCreateCount !== 0 ||
    planIsBlocked(verification.plan)
  ) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-write verification failed";
    throw new Error(
      `${reason}; remaining profiles=${verification.plan.summary.profileCreateCount}; ` +
      `remaining lives=${verification.plan.summary.liveCreateCount}; automatic retry is disabled`,
    );
  }
  return {
    status: "success",
    dryRun: false,
    planSha256: plan.planSha256,
    profileCreatedCount: plan.summary.profileCreateCount,
    liveCreatedCount: plan.summary.liveCreateCount,
    profileVerifiedCount: verification.plan.summary.profileAlreadyAppliedCount,
    liveVerifiedCount: verification.plan.summary.liveAlreadyAppliedCount,
    verified: true,
    recoveredFromAmbiguousResponse: Boolean(writeError),
  };
}
