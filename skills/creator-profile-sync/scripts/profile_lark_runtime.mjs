import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { LARK_MEDIA_MAX_BYTES } from "../../_shared/lark-base-client.mjs";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  PROFILE_TARGET_INPUT_KIND,
  buildProfileSyncPlan,
  isRecordId,
  normalizeAccountKey,
  planIsBlocked,
  sha256Json,
  validateProfileSyncPlan,
  validateTargetManifest,
} from "./profile_sync_core.mjs";

const BATCH_SIZE = 500;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export { writePrivateJson };

export async function loadProfileConfig(filePath) {
  const raw = await readPrivateJson(path.resolve(filePath));
  for (const key of ["appToken", "creatorTableId", "profileTableId", "dueViewId"]) {
    assert(typeof raw[key] === "string" && raw[key].trim(), `configuration ${key} is required`);
  }
  const keys = [
    "creatorAccount",
    "profileTimestamp",
    "profileCreator",
    "profileFollowerCount",
    "profileRecentPostCount30d",
    "profileLatestPostAt",
    "profileNickname",
    "profileAvatar",
    "profileFeatureObservationData",
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

export function resolveProfileFields(creatorFields, profileFields, config) {
  const creator = fieldMap(creatorFields);
  const profile = fieldMap(profileFields);
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
      recentPostCount30d: bind(profile, config.fieldIds.profileRecentPostCount30d, ["Number"], "profile recent post count"),
      latestPostAt: bind(profile, config.fieldIds.profileLatestPostAt, ["DateTime"], "profile latest post"),
      nickname: bind(profile, config.fieldIds.profileNickname, ["Text"], "profile nickname"),
      avatar: bind(profile, config.fieldIds.profileAvatar, ["Attachment"], "profile avatar"),
      featureObservationData: bind(
        profile,
        config.fieldIds.profileFeatureObservationData,
        ["Text"],
        "profile feature observation data",
      ),
    },
  };
  const profileNames = Object.values(bindings.profile).map((value) => value.name);
  assert(new Set(profileNames).size === profileNames.length, "resolved profile field names must be unique");
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

async function resolveBindings(client, config) {
  const [creatorFields, profileFields] = await Promise.all([
    client.listFields(config.appToken, config.creatorTableId),
    client.listFields(config.appToken, config.profileTableId),
  ]);
  return resolveProfileFields(creatorFields, profileFields, config);
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
  const bindings = await resolveBindings(client, config);
  const query = mode === "due" ? { view_id: config.dueViewId } : {};
  const records = await client.listRecords(config.appToken, config.creatorTableId, query);
  const rows = selectTargetRows({
    records,
    accountFieldName: bindings.creator.account.name,
    mode,
    selectedAccounts,
    limit,
  });
  const manifest = {
    version: 2,
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

async function verifyAvatarFile(avatar) {
  if (!avatar) return;
  const filePath = path.resolve(avatar.path);
  const stat = await lstat(filePath);
  assert(stat.isFile() && !stat.isSymbolicLink(), "avatar must be a regular file");
  assert(
    stat.size === avatar.size && stat.size >= 1 && stat.size <= LARK_MEDIA_MAX_BYTES,
    "avatar file size does not match normalized metadata",
  );
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  assert(hash === avatar.sha256, "avatar file hash does not match normalized metadata");
}

async function verifyObservationAvatars(observations) {
  for (const creator of observations.creators) await verifyAvatarFile(creator.profile.avatar);
}

export async function prepareProfilePlan({ client, config, manifest, observations, nowMs = Date.now() }) {
  await verifyObservationAvatars(observations);
  const bindings = await resolveBindings(client, config);
  const targetIssues = await verifyTargets({ client, config, manifest, bindings });
  const profileRecords = await client.listRecords(config.appToken, config.profileTableId);
  const plan = await buildProfileSyncPlan({
    manifest,
    observations,
    profileRecords,
    bindings,
    resolveAttachmentHash: (attachment) => client.attachmentSha256(attachment),
    nowMs,
  });
  if (targetIssues.length) {
    plan.operations.targetIssues.push(...targetIssues);
    plan.summary.targetIssueCount = plan.operations.targetIssues.length;
    const { planSha256: ignored, ...unsigned } = plan;
    plan.planSha256 = sha256Json(unsigned);
  }
  return { plan, bindings };
}

function profilePayload(item, bindings, avatarFileToken = null) {
  const fields = { [bindings.profile.creator.name]: [item.creatorRecordId] };
  if (bindings.profile.timestamp.type === "DateTime") {
    fields[bindings.profile.timestamp.name] = item.observedAtMs;
  }
  if (item.followerCount !== null) fields[bindings.profile.followerCount.name] = item.followerCount;
  if (item.recentPostCount30d !== null) {
    fields[bindings.profile.recentPostCount30d.name] = item.recentPostCount30d;
  }
  if (item.latestPostAtMs !== null) fields[bindings.profile.latestPostAt.name] = item.latestPostAtMs;
  if (item.nickname !== null) fields[bindings.profile.nickname.name] = item.nickname;
  if (item.featureObservationJson !== null) {
    fields[bindings.profile.featureObservationData.name] = item.featureObservationJson;
  }
  if (avatarFileToken !== null) {
    fields[bindings.profile.avatar.name] = [{ file_token: avatarFileToken }];
  }
  return { fields };
}

async function createInBatches(client, appToken, tableId, rows) {
  const created = [];
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    created.push(...await client.batchCreate(appToken, tableId, rows.slice(index, index + BATCH_SIZE)));
  }
  return created;
}

async function uploadAvatar(client, config, item) {
  if (!item.avatar) return null;
  await verifyAvatarFile(item.avatar);
  return client.uploadMedia(config.appToken, item.avatar);
}

async function attachAvatar(client, config, bindings, item, recordId) {
  const fileToken = await uploadAvatar(client, config, item);
  if (fileToken === null) return;
  await client.appendAttachment(
    config.appToken,
    config.profileTableId,
    recordId,
    bindings.profile.avatar.id,
    fileToken,
  );
}

export async function applyProfilePlan({
  client,
  config,
  reviewedPlan,
  apply = false,
  expectSha256,
  confirmProfileCreate,
  confirmProfileAttach,
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
  const operationCount = plan.summary.profileCreateCount + plan.summary.profileAttachExistingCount;
  const report = {
    status: planIsBlocked(plan) ? "blocked" : operationCount ? "ready" : "unchanged",
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
  assert(Number(confirmProfileAttach) === plan.summary.profileAttachCount, "--confirm-profile-attach does not match");
  if (!operationCount) {
    return { ...report, dryRun: false, status: "unchanged", verified: true };
  }

  let writeError = null;
  try {
    for (const item of plan.operations.profileAttachExisting) {
      await attachAvatar(client, config, current.bindings, item, item.recordId);
    }
    const createItems = plan.operations.profileCreates;
    const avatarFileTokens = [];
    for (const item of createItems) avatarFileTokens.push(await uploadAvatar(client, config, item));
    const created = await createInBatches(
      client,
      config.appToken,
      config.profileTableId,
      createItems.map((item, index) => profilePayload(item, current.bindings, avatarFileTokens[index])),
    );
    assert(created.length === createItems.length, "created profile response count does not match");
    for (let index = 0; index < created.length; index += 1) {
      const recordId = String(created[index]?.record_id ?? "");
      assert(isRecordId(recordId), "created profile record ID is missing");
    }
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
      verification.plan.summary.profileAttachExistingCount === 0 &&
      !planIsBlocked(verification.plan)
    ) break;
  }
  if (
    verification.plan.summary.profileCreateCount !== 0 ||
    verification.plan.summary.profileAttachExistingCount !== 0 ||
    planIsBlocked(verification.plan)
  ) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-write verification failed";
    throw new Error(
      `${reason}; remaining profiles=${verification.plan.summary.profileCreateCount}; ` +
      `remaining attachments=${verification.plan.summary.profileAttachExistingCount}; automatic retry is disabled`,
    );
  }
  return {
    status: "success",
    dryRun: false,
    planSha256: plan.planSha256,
    profileCreatedCount: plan.summary.profileCreateCount,
    profileAttachedCount: plan.summary.profileAttachCount,
    profileVerifiedCount: verification.plan.summary.profileAlreadyAppliedCount,
    verified: true,
    recoveredFromAmbiguousResponse: Boolean(writeError),
  };
}
