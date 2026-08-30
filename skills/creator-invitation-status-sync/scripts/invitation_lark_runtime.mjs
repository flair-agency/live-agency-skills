import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { LARK_MEDIA_MAX_BYTES } from "../../_shared/lark-base-client.mjs";
import { writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  buildRefreshPlan,
  hasBlockingRefreshIssues,
  normalizeAccountKey,
  validateTargetManifest,
} from "./invitation_state_core.mjs";

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export { writePrivateJson };

export async function loadInvitationConfig(filePath) {
  let config;
  try {
    config = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new TypeError(`cannot read Lark configuration: ${error.message}`);
  }
  for (const key of ["appToken", "creatorTableId", "invitationStateTableId", "dueViewId"]) {
    if (typeof config[key] !== "string" || !config[key]) {
      throw new TypeError(`Lark configuration ${key} is required`);
    }
  }
  const keys = [
    "creatorAccount",
    "stateCreator",
    "stateStatus",
    "stateObservedAt",
    "stateNickname",
    "stateAvatar",
    "stateExternalUserId",
  ];
  if (!config.fieldIds || typeof config.fieldIds !== "object") {
    throw new TypeError("Lark configuration fieldIds is required");
  }
  const values = keys.map((key) => {
    const value = config.fieldIds[key];
    if (typeof value !== "string" || !value) {
      throw new TypeError(`Lark configuration fieldIds.${key} is required`);
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new TypeError("Lark configuration field IDs must be distinct");
  }
  return {
    ...config,
    fieldIds: Object.fromEntries(keys.map((key, index) => [key, values[index]])),
    apiOrigin: config.apiOrigin ?? "https://open.larksuite.com",
  };
}

function fieldMap(fields) {
  const result = new Map();
  for (const field of fields) {
    if (typeof field.field_id !== "string") continue;
    const rows = result.get(field.field_id) ?? [];
    rows.push(field);
    result.set(field.field_id, rows);
  }
  return result;
}

function bind(byId, id, expectedType, label) {
  const rows = byId.get(id) ?? [];
  if (rows.length !== 1) {
    throw new TypeError(rows.length ? `${label} field ID is duplicated` : `${label} field ID is missing`);
  }
  const field = rows[0];
  if (field.ui_type !== expectedType) {
    throw new TypeError(`${label} field type must be ${expectedType}; live=${field.ui_type}`);
  }
  if (typeof field.field_name !== "string" || !field.field_name) {
    throw new TypeError(`${label} current field name is missing`);
  }
  return { id, name: field.field_name, type: field.ui_type, property: field.property ?? null };
}

export function resolveInvitationFields(creatorFields, stateFields, fieldIds) {
  const creatorById = fieldMap(creatorFields);
  const stateById = fieldMap(stateFields);
  const creatorAccount = bind(creatorById, fieldIds.creatorAccount, "Url", "creator account");
  const state = {
    creator: bind(stateById, fieldIds.stateCreator, "DuplexLink", "state creator"),
    status: bind(stateById, fieldIds.stateStatus, "SingleSelect", "state status"),
    observedAt: bind(stateById, fieldIds.stateObservedAt, "DateTime", "state observedAt"),
    nickname: bind(stateById, fieldIds.stateNickname, "Text", "state nickname"),
    avatar: bind(stateById, fieldIds.stateAvatar, "Attachment", "state avatar"),
    externalUserId: bind(
      stateById,
      fieldIds.stateExternalUserId,
      "Text",
      "state externalUserId",
    ),
  };
  const names = [creatorAccount.name, ...Object.values(state).map((value) => value.name)];
  if (new Set(names).size !== names.length) throw new TypeError("resolved field names are not unique");
  return { creatorAccount, state };
}

function accountText(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof value.text === "string") return value.text.trim();
  return "";
}

function selectTargetRows({ mode, records, accountFieldName, selectedAccounts = [], limit = null }) {
  const rows = records.map((record, index) => {
    const accountKey = normalizeAccountKey(accountText(record.fields?.[accountFieldName]));
    if (!record.record_id || !accountKey) throw new TypeError(`creator row ${index + 1} is invalid`);
    return {
      creatorRecordId: String(record.record_id),
      accountKey,
    };
  });
  const byAccount = new Map();
  for (const row of rows) {
    if (byAccount.has(row.accountKey)) throw new TypeError(`creator account is duplicated: ${row.accountKey}`);
    byAccount.set(row.accountKey, row);
  }
  let selected;
  if (mode === "selected") {
    const seen = new Set();
    selected = selectedAccounts.map((value) => {
      const key = normalizeAccountKey(value);
      if (!key || seen.has(key)) throw new TypeError(`selected account is invalid or duplicated: ${value}`);
      seen.add(key);
      const row = byAccount.get(key);
      if (!row) throw new TypeError(`selected account is absent from Lark: ${value}`);
      return row;
    });
  } else selected = rows;
  return limit === null ? selected : selected.slice(0, limit);
}

export async function exportTargets({ client, config, mode = "due", selectedAccounts = [], limit = null }) {
  if (!["due", "selected", "all"].includes(mode)) throw new TypeError("target mode is invalid");
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new TypeError("limit must be a positive integer");
  }
  if (mode !== "selected" && selectedAccounts.length) {
    throw new TypeError("selected accounts require selected mode");
  }
  const [creatorFields, stateFields] = await Promise.all([
    client.listFields(config.appToken, config.creatorTableId),
    client.listFields(config.appToken, config.invitationStateTableId),
  ]);
  const bindings = resolveInvitationFields(creatorFields, stateFields, config.fieldIds);
  const query = mode === "due" ? { view_id: config.dueViewId } : {};
  const records = await client.listRecords(config.appToken, config.creatorTableId, query);
  const rows = selectTargetRows({
    mode,
    records,
    accountFieldName: bindings.creatorAccount.name,
    selectedAccounts,
    limit,
  });
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    targetMode: mode,
    rowCount: rows.length,
    rows,
  };
  manifest.rowsSha256 = sha256Json(rows);
  return manifest;
}

async function verifyAvatarFile(avatar) {
  if (!avatar) return;
  if (!path.isAbsolute(avatar.path)) throw new TypeError("avatar path must be absolute");
  const filePath = path.resolve(avatar.path);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("avatar must be a regular file");
  if (stat.size !== avatar.size || stat.size < 1 || stat.size > LARK_MEDIA_MAX_BYTES) {
    throw new TypeError("avatar file size does not match normalized metadata");
  }
  const content = await readFile(filePath);
  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== avatar.sha256) throw new TypeError("avatar file hash does not match normalized metadata");
}

async function verifyObservationAvatars(observations) {
  for (const creator of observations.creators) await verifyAvatarFile(creator.avatar);
}

function optionNames(statusBinding) {
  return new Set((statusBinding.property?.options ?? []).map((option) => String(option.name ?? "")));
}

async function verifyManifestAgainstLive({ client, config, manifest, creatorAccountBinding }) {
  validateTargetManifest(manifest);
  if (manifest.rowsSha256 !== sha256Json(manifest.rows)) throw new TypeError("target manifest hash is invalid");
  const [allRecords, dueRecords] = await Promise.all([
    client.listRecords(config.appToken, config.creatorTableId),
    manifest.targetMode === "due"
      ? client.listRecords(config.appToken, config.creatorTableId, { view_id: config.dueViewId })
      : Promise.resolve([]),
  ]);
  const byId = new Map(allRecords.map((record) => [String(record.record_id ?? ""), record]));
  const dueIds = new Set(dueRecords.map((record) => String(record.record_id ?? "")));
  for (const row of manifest.rows) {
    const live = byId.get(row.creatorRecordId);
    if (!live) throw new TypeError(`creator record is missing: ${row.creatorRecordId}`);
    const liveAccount = normalizeAccountKey(accountText(live.fields?.[creatorAccountBinding.name]));
    if (liveAccount !== normalizeAccountKey(row.accountKey)) {
      throw new TypeError(`creator account changed: ${row.accountKey}`);
    }
  }
  return dueIds;
}

function operationSnapshot(corePlan) {
  return {
    creates: corePlan.creates,
    updates: corePlan.updates,
    attachExisting: corePlan.attachExisting,
    alreadyApplied: corePlan.alreadyApplied,
    identityConflicts: corePlan.identityConflicts,
    ambiguousLatest: corePlan.ambiguousLatest,
    staleObservations: corePlan.staleObservations,
    invalidStored: corePlan.invalidStored,
  };
}

export function refreshCounts(corePlan) {
  return {
    create: corePlan.creates.length,
    update: corePlan.updates.length,
    attach:
      corePlan.attachExisting.length + corePlan.creates.filter((row) => row.avatar).length,
    alreadyApplied: corePlan.alreadyApplied.length,
  };
}

export async function prepareRefresh({ client, config, manifest, observations }) {
  await verifyObservationAvatars(observations);
  const [creatorFields, stateFields] = await Promise.all([
    client.listFields(config.appToken, config.creatorTableId),
    client.listFields(config.appToken, config.invitationStateTableId),
  ]);
  const bindings = resolveInvitationFields(creatorFields, stateFields, config.fieldIds);
  const dueIds = await verifyManifestAgainstLive({
    client,
    config,
    manifest,
    creatorAccountBinding: bindings.creatorAccount,
  });
  const allowedStates = optionNames(bindings.state.status);
  for (const row of observations.creators) {
    if (!allowedStates.has(row.state)) throw new TypeError(`Lark state option is missing: ${row.state}`);
  }
  const storedRecords = await client.listRecords(config.appToken, config.invitationStateTableId);
  const corePlan = await buildRefreshPlan({
    observations,
    manifest,
    storedRecords,
    bindings: bindings.state,
    resolveAttachmentHash: (attachment) => client.attachmentSha256(attachment),
  });
  if (manifest.targetMode === "due") {
    for (const row of [...corePlan.creates, ...corePlan.updates]) {
      if (!dueIds.has(row.creatorRecordId)) {
        corePlan.staleObservations.push({
          accountKey: row.accountKey,
          reason: "creator is no longer due",
        });
      }
    }
  }
  const operations = operationSnapshot(corePlan);
  const planSha256 = sha256Json({ manifest, observations });
  return {
    planSha256,
    corePlan,
    operations,
    counts: refreshCounts(corePlan),
    bindings,
    blocked: hasBlockingRefreshIssues(corePlan),
  };
}

function fieldsForCreate(row, bindings) {
  const fields = {
    [bindings.creator.name]: [row.creatorRecordId],
    [bindings.status.name]: row.state,
    [bindings.observedAt.name]: row.observedAtMs,
  };
  if (row.nickname) fields[bindings.nickname.name] = row.nickname;
  if (row.externalUserId) fields[bindings.externalUserId.name] = row.externalUserId;
  return fields;
}

async function inBatches(rows, size, callback) {
  for (let index = 0; index < rows.length; index += size) {
    await callback(rows.slice(index, index + size));
  }
}

async function attachAvatar(client, config, bindings, row, recordId) {
  if (!row.avatar) return;
  await verifyAvatarFile(row.avatar);
  const fileToken = await client.uploadMedia(config.appToken, row.avatar);
  await client.appendAttachment(
    config.appToken,
    config.invitationStateTableId,
    recordId,
    bindings.avatar.id,
    fileToken,
  );
}

export async function applyRefresh({
  client,
  config,
  manifest,
  observations,
  expectedPlanSha256,
  confirmCreate,
  confirmUpdate,
  confirmAttach,
}) {
  const prepared = await prepareRefresh({ client, config, manifest, observations });
  if (prepared.planSha256 !== expectedPlanSha256) {
    throw new TypeError("live plan hash differs from the reviewed plan");
  }
  if (prepared.blocked) throw new TypeError("live plan has blocking conflicts");
  if (
    prepared.counts.create !== confirmCreate ||
    prepared.counts.update !== confirmUpdate ||
    prepared.counts.attach !== confirmAttach
  ) {
    throw new TypeError("live plan counts differ from the reviewed confirmation");
  }
  const state = prepared.bindings.state;
  await inBatches(prepared.corePlan.updates, 100, (rows) =>
    client.batchUpdate(
      config.appToken,
      config.invitationStateTableId,
      rows.map((row) => ({
        record_id: row.recordId,
        fields: { [state.observedAt.name]: row.observedAtMs },
      })),
    ),
  );

  const created = [];
  await inBatches(prepared.corePlan.creates, 100, async (rows) => {
    const records = await client.batchCreate(
      config.appToken,
      config.invitationStateTableId,
      rows.map((row) => ({ fields: fieldsForCreate(row, state) })),
    );
    for (let index = 0; index < rows.length; index += 1) {
      const recordId = String(records[index]?.record_id ?? "");
      if (!recordId) throw new TypeError("created state record ID is missing");
      created.push({ row: rows[index], recordId });
    }
  });
  for (const item of prepared.corePlan.attachExisting) {
    await attachAvatar(client, config, state, item, item.recordId);
  }
  for (const item of created) await attachAvatar(client, config, state, item.row, item.recordId);

  const verified = await prepareRefresh({ client, config, manifest, observations });
  if (
    verified.blocked ||
    verified.corePlan.creates.length ||
    verified.corePlan.updates.length ||
    verified.corePlan.attachExisting.length ||
    verified.corePlan.alreadyApplied.length !== observations.rowCount
  ) {
    throw new TypeError("post-write reread does not represent every observation exactly");
  }
  return { ...prepared.counts, verified: true, alreadyAppliedBefore: prepared.counts.alreadyApplied };
}
