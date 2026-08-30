#!/usr/bin/env node

import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { createLarkBaseClient } from "../../_shared/lark-base-client.mjs";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import {
  loadInvitationConfig,
  resolveInvitationFields,
} from "../../creator-invitation-status-sync/scripts/invitation_lark_runtime.mjs";
import {
  buildInvitationCompactionPlan,
  calculateInvitationArchiveReceiptSha256,
  calculateInvitationArchiveSha256,
  hydrateInvitationState,
  inspectInvitationRestore,
  invitationCompactionPlanIsBlocked,
  sha256,
  stableStringify,
  validateInvitationCompactionPlan,
} from "./invitation_compaction_core.mjs";

const BATCH_SIZE = 100;
const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configurationIdentity(config) {
  return {
    app_token: config.appToken,
    creator_table_id: config.creatorTableId,
    invitation_state_table_id: config.invitationStateTableId,
    field_ids: config.fieldIds,
    archive_destination: config.archiveDestination,
  };
}

export function invitationCompactionConfigurationSha256(config) {
  return sha256(stableStringify(configurationIdentity(config)));
}

export async function loadCompactionConfig(filePath) {
  assert(filePath, "--config is required");
  await readPrivateJson(path.resolve(filePath));
  const base = await loadInvitationConfig(filePath);
  const destination = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8")).archiveDestination;
  assert(destination && typeof destination === "object", "configuration archiveDestination is required");
  for (const key of ["sharedDriveId", "folderId"]) {
    assert(typeof destination[key] === "string" && destination[key].trim(), `archiveDestination.${key} is required`);
  }
  return {
    ...base,
    archiveDestination: {
      sharedDriveId: destination.sharedDriveId.trim(),
      folderId: destination.folderId.trim(),
      mimeType: typeof destination.mimeType === "string" && destination.mimeType.trim()
        ? destination.mimeType.trim()
        : "application/gzip",
    },
  };
}

function schemaSha256(bindings) {
  const signature = Object.values(bindings.state)
    .map((field) => ({ field_id: field.id, type: field.type, property: field.property ?? null }))
    .sort((left, right) => left.field_id.localeCompare(right.field_id));
  return sha256(stableStringify(signature));
}

async function writeOwnerOnlyFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  try {
    await fs.writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(filePath);
    assert(crypto.timingSafeEqual(crypto.createHash("sha256").update(existing).digest(), crypto.createHash("sha256").update(content).digest()), "existing avatar backup content differs");
  }
  await fs.chmod(filePath, 0o600);
}

function attachmentResolver(client, backupDirectory = null) {
  const cache = new Map();
  return async (attachment) => {
    const token = String(attachment?.file_token ?? "");
    if (cache.has(token)) return cache.get(token);
    const downloaded = await client.downloadAttachment(attachment);
    const evidence = {
      sha256: downloaded.sha256,
      size: downloaded.size,
      name: downloaded.name,
      mimeType: downloaded.mimeType,
    };
    if (backupDirectory) {
      const filePath = path.join(path.resolve(backupDirectory), `${downloaded.sha256}.bin`);
      await writeOwnerOnlyFile(filePath, downloaded.content);
      evidence.path = filePath;
    }
    cache.set(token, evidence);
    return evidence;
  };
}

async function currentRuntime(config, { client = null, backupDirectory = null } = {}) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin });
  const [creatorFields, stateFields] = await Promise.all([
    activeClient.listFields(config.appToken, config.creatorTableId),
    activeClient.listFields(config.appToken, config.invitationStateTableId),
  ]);
  const bindings = resolveInvitationFields(creatorFields, stateFields, config.fieldIds);
  const records = await activeClient.listRecords(config.appToken, config.invitationStateTableId);
  return { client: activeClient, bindings, records, schemaSha256: schemaSha256(bindings) };
}

function planSource(config, schemaHash, backupDirectory) {
  return {
    configuration_sha256: invitationCompactionConfigurationSha256(config),
    schema_sha256: schemaHash,
    app_token: config.appToken,
    invitation_state_table_id: config.invitationStateTableId,
    avatar_backup_directory: path.resolve(backupDirectory),
  };
}

export function validatePlanForConfig(plan, config) {
  validateInvitationCompactionPlan(plan);
  assert(plan.source?.configuration_sha256 === invitationCompactionConfigurationSha256(config), "plan configuration SHA does not match");
  assert(plan.source?.app_token === config.appToken, "plan app token does not match configuration");
  assert(plan.source?.invitation_state_table_id === config.invitationStateTableId, "plan table does not match configuration");
  assert(path.isAbsolute(plan.source?.avatar_backup_directory ?? ""), "plan avatar backup directory is invalid");
  return plan;
}

export async function createInvitationCompactionPlan({ config, output, backupDirectory, client, builtAtMs = Date.now() }) {
  assert(output, "plan requires --output");
  const avatarDirectory = path.resolve(backupDirectory ?? `${path.resolve(output)}.backup/avatars`);
  const current = await currentRuntime(config, { client, backupDirectory: avatarDirectory });
  const plan = await buildInvitationCompactionPlan({
    records: current.records,
    bindings: current.bindings.state,
    source: planSource(config, current.schemaSha256, avatarDirectory),
    builtAtMs,
    resolveAttachmentEvidence: attachmentResolver(current.client, avatarDirectory),
  });
  await writePrivateJson(path.resolve(output), plan);
  return {
    status: invitationCompactionPlanIsBlocked(plan) ? "blocked" : plan.summary.delete_candidate_count ? "success" : "unchanged",
    mode: "invitation-status-compaction-plan",
    output: path.resolve(output),
    plan_sha256: plan.plan_sha256,
    avatar_backup_directory: avatarDirectory,
    ...plan.summary,
  };
}

async function rebuildPlan(plan, config, client) {
  validatePlanForConfig(plan, config);
  const current = await currentRuntime(config, {
    client,
    backupDirectory: plan.source.avatar_backup_directory,
  });
  const rebuilt = await buildInvitationCompactionPlan({
    records: current.records,
    bindings: current.bindings.state,
    source: planSource(config, current.schemaSha256, plan.source.avatar_backup_directory),
    builtAtMs: plan.built_at_ms,
    resolveAttachmentEvidence: attachmentResolver(current.client, plan.source.avatar_backup_directory),
  });
  return { current, rebuilt };
}

export async function inspectInvitationCompactionPlan({ plan, config, client }) {
  const { rebuilt } = await rebuildPlan(plan, config, client);
  const stale = rebuilt.plan_sha256 !== plan.plan_sha256;
  return {
    status: stale || invitationCompactionPlanIsBlocked(plan) ? "blocked" : plan.summary.delete_candidate_count ? "ready" : "unchanged",
    mode: "invitation-status-compaction-apply",
    dry_run: true,
    plan_sha256: plan.plan_sha256,
    live_record_count: plan.summary.live_record_count,
    delete_count: plan.summary.delete_candidate_count,
    keep_count: plan.summary.keep_count,
    operation_count: plan.summary.operation_count,
    affected_creator_count: plan.summary.affected_creator_count,
    invalid_record_count: plan.summary.invalid_record_count,
    identity_conflict_count: plan.summary.identity_conflict_count,
    timestamp_conflict_count: plan.summary.timestamp_conflict_count,
    blocking_issue_count: plan.summary.blocking_issue_count,
    stale_count: stale ? 1 : 0,
  };
}

async function readAvatarEvidence(evidence) {
  assert(typeof evidence.path === "string" && path.isAbsolute(evidence.path), "archived avatar path is invalid");
  const content = await fs.readFile(evidence.path);
  assert(content.length === evidence.size, "archived avatar size changed");
  assert(sha256(content) === evidence.sha256, "archived avatar SHA changed");
  return content;
}

function archiveFileName(plan, createdAtMs) {
  return `${new Date(createdAtMs).toISOString().replaceAll(":", "-")}--${plan.plan_sha256.slice(0, 12)}--invitation-status-restore.json.gz`;
}

export async function buildInvitationArchive(plan, config, createdAtMs = Date.now()) {
  validatePlanForConfig(plan, config);
  assert(!invitationCompactionPlanIsBlocked(plan), "blocked plan cannot be archived");
  const deleted = plan.operations.flatMap((operation) => operation.deleted_records);
  const blobs = new Map();
  const records = [];
  for (const record of deleted) {
    const avatars = [];
    for (const evidence of record.values.avatars) {
      const content = await readAvatarEvidence(evidence);
      const existing = blobs.get(evidence.sha256);
      const blob = {
        sha256: evidence.sha256,
        size: evidence.size,
        name: evidence.name,
        mime_type: evidence.mimeType,
        content_base64: content.toString("base64"),
      };
      if (existing) assert(existing.content_base64 === blob.content_base64, "avatar archive hash collision");
      else blobs.set(evidence.sha256, blob);
      avatars.push({ sha256: evidence.sha256, size: evidence.size, name: evidence.name, mimeType: evidence.mimeType });
    }
    records.push({
      original_record_id: record.original_record_id,
      restore_key: record.restore_key,
      values: { ...record.values, avatars },
    });
  }
  const unsigned = {
    version: 1,
    archive_type: "creator-invitation-status-compaction-restore",
    created_at: new Date(createdAtMs).toISOString(),
    created_at_ms: createdAtMs,
    plan_sha256: plan.plan_sha256,
    configuration_sha256: invitationCompactionConfigurationSha256(config),
    source: plan.source,
    file_name: archiveFileName(plan, createdAtMs),
    summary: { archived_record_count: records.length, avatar_blob_count: blobs.size },
    records,
    avatar_blobs: [...blobs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256)),
  };
  return { ...unsigned, archive_sha256: calculateInvitationArchiveSha256(unsigned) };
}

export function validateInvitationArchive(archive, config) {
  assert(archive?.version === 1 && archive?.archive_type === "creator-invitation-status-compaction-restore", "invitation archive is invalid");
  assert(archive.configuration_sha256 === invitationCompactionConfigurationSha256(config), "archive configuration SHA does not match");
  assert(Array.isArray(archive.records) && Array.isArray(archive.avatar_blobs), "invitation archive arrays are invalid");
  assert(archive.summary?.archived_record_count === archive.records.length, "archive record count does not match");
  assert(archive.summary?.avatar_blob_count === archive.avatar_blobs.length, "archive avatar count does not match");
  const blobHashes = new Set();
  for (const blob of archive.avatar_blobs) {
    assert(/^[0-9a-f]{64}$/.test(String(blob.sha256 ?? "")), "archive avatar SHA is invalid");
    const content = Buffer.from(String(blob.content_base64 ?? ""), "base64");
    assert(content.length === blob.size && sha256(content) === blob.sha256, "archive avatar content does not match");
    assert(!blobHashes.has(blob.sha256), "archive avatar SHA is duplicated");
    blobHashes.add(blob.sha256);
  }
  for (const record of archive.records) {
    for (const avatar of record.values?.avatars ?? []) assert(blobHashes.has(avatar.sha256), "archive record avatar is missing");
  }
  assert(archive.archive_sha256 === calculateInvitationArchiveSha256(archive), "archive SHA does not match");
  return archive;
}

async function writePrivateGzipJson(filename, value) {
  const resolved = path.resolve(filename);
  const directory = path.dirname(resolved);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const compressed = gzipSync(Buffer.from(`${stableStringify(value)}\n`, "utf8"), { level: 9 });
  assert(compressed.length > 0 && compressed.length <= ARCHIVE_MAX_BYTES, "archive size is invalid");
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

export async function readPrivateInvitationArchive(filename, config) {
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
    const archive = JSON.parse(decoded.toString("utf8"));
    validateInvitationArchive(archive, config);
    return { archive, file_sha256: sha256(compressed) };
  } finally {
    await handle.close();
  }
}

export async function createInvitationArchive({ plan, config, outputDirectory, client, createdAtMs = Date.now() }) {
  assert(outputDirectory, "archive requires --output-dir");
  const dryRun = await inspectInvitationCompactionPlan({ plan, config, client });
  assert(dryRun.status !== "blocked", "blocked or stale plan cannot be archived");
  if (dryRun.delete_count === 0) return { status: "unchanged", mode: "invitation-status-compaction-archive", archived_record_count: 0 };
  const archive = await buildInvitationArchive(plan, config, createdAtMs);
  const written = await writePrivateGzipJson(path.join(path.resolve(outputDirectory), archive.file_name), archive);
  return {
    status: "success",
    mode: "invitation-status-compaction-archive",
    plan_sha256: plan.plan_sha256,
    archive_sha256: archive.archive_sha256,
    archived_record_count: archive.records.length,
    avatar_blob_count: archive.avatar_blobs.length,
    file_name: archive.file_name,
    ...written,
  };
}

export function buildInvitationArchiveReceipt(archive, config, fileMetadata, verifiedAtMs = Date.now()) {
  validateInvitationArchive(archive, config);
  assert(/^[A-Za-z0-9_-]{10,}$/.test(String(fileMetadata?.file_id ?? "")), "archive file ID is invalid");
  assert(fileMetadata.folder_id === config.archiveDestination.folderId, "archive folder ID does not match");
  assert(fileMetadata.file_name === archive.file_name, "archive file name does not match");
  const url = new URL(String(fileMetadata.file_url ?? ""));
  assert(url.protocol === "https:", "archive URL must use HTTPS");
  assert(/^[0-9a-f]{64}$/.test(String(fileMetadata.file_sha256 ?? "")), "archive file SHA is invalid");
  const unsigned = {
    version: 1,
    receipt_type: "creator-invitation-status-compaction-drive-archive",
    verified_at: new Date(verifiedAtMs).toISOString(),
    verified_at_ms: verifiedAtMs,
    plan_sha256: archive.plan_sha256,
    archive_sha256: archive.archive_sha256,
    archive_file_sha256: fileMetadata.file_sha256,
    archived_record_count: archive.records.length,
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
  return { ...unsigned, receipt_sha256: calculateInvitationArchiveReceiptSha256(unsigned) };
}

export function validateInvitationArchiveReceipt(receipt, plan, config, archiveFileSha256 = null) {
  assert(receipt?.version === 1 && receipt?.receipt_type === "creator-invitation-status-compaction-drive-archive", "archive receipt is invalid");
  assert(receipt.plan_sha256 === plan.plan_sha256, "receipt plan SHA does not match");
  assert(receipt.archived_record_count === plan.summary.delete_candidate_count, "receipt record count does not match");
  assert(receipt.drive?.shared_drive_id === config.archiveDestination.sharedDriveId, "receipt shared drive does not match");
  assert(receipt.drive?.folder_id === config.archiveDestination.folderId, "receipt folder does not match");
  assert(receipt.drive?.mime_type === config.archiveDestination.mimeType, "receipt MIME type does not match");
  assert(receipt.drive?.readback_verified === true, "archive receipt is not readback verified");
  if (archiveFileSha256 !== null) assert(receipt.archive_file_sha256 === archiveFileSha256, "receipt file SHA does not match");
  assert(receipt.receipt_sha256 === calculateInvitationArchiveReceiptSha256(receipt), "receipt SHA does not match");
  return receipt;
}

export async function createInvitationArchiveReceipt({ plan, archivePath, config, output, fileMetadata }) {
  validatePlanForConfig(plan, config);
  const archiveRead = await readPrivateInvitationArchive(archivePath, config);
  assert(archiveRead.archive.plan_sha256 === plan.plan_sha256, "archive plan SHA does not match");
  assert(fileMetadata.file_sha256 === archiveRead.file_sha256, "Drive readback SHA does not match local archive");
  const receipt = buildInvitationArchiveReceipt(archiveRead.archive, config, fileMetadata);
  await writePrivateJson(path.resolve(output), receipt);
  return {
    status: "success",
    mode: "invitation-status-compaction-archive-receipt",
    output: path.resolve(output),
    plan_sha256: receipt.plan_sha256,
    archive_sha256: receipt.archive_sha256,
    archive_file_sha256: receipt.archive_file_sha256,
    receipt_sha256: receipt.receipt_sha256,
    archived_record_count: receipt.archived_record_count,
  };
}

export async function applyInvitationCompaction({ plan, receipt, config, apply = false, expectSha256, confirmDelete, client }) {
  const activeClient = client ?? await createLarkBaseClient({ origin: config.apiOrigin });
  const dryRun = await inspectInvitationCompactionPlan({ plan, config, client: activeClient });
  if (!apply) return dryRun;
  assert(dryRun.status !== "blocked", "blocked or stale plan cannot be applied");
  assert(expectSha256 === plan.plan_sha256, "--expect-sha256 does not match plan");
  assert(Number(confirmDelete) === dryRun.delete_count, "--confirm-delete does not match dry-run count");
  if (dryRun.delete_count === 0) return { ...dryRun, dry_run: false, status: "unchanged", deleted_count: 0, verified: true };
  assert(receipt, "deletion requires a readback-verified archive receipt");
  validateInvitationArchiveReceipt(receipt, plan, config);
  const deleteIds = plan.operations.flatMap((operation) => operation.delete_record_ids);
  const keepIds = new Set(plan.operations.map((operation) => operation.keep_record_id));
  let writeError = null;
  try {
    for (let index = 0; index < deleteIds.length; index += BATCH_SIZE) {
      await activeClient.batchDelete(config.appToken, config.invitationStateTableId, deleteIds.slice(index, index + BATCH_SIZE));
    }
  } catch (error) {
    writeError = error;
  }
  const current = await activeClient.listRecords(config.appToken, config.invitationStateTableId);
  const remaining = new Set(current.map((record) => String(record.record_id ?? "")));
  const undeleted = deleteIds.filter((recordId) => remaining.has(recordId));
  const missingKeep = [...keepIds].filter((recordId) => !remaining.has(recordId));
  if (undeleted.length || missingKeep.length) {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-delete verification failed";
    throw new Error(`${reason}; undeleted=${undeleted.length}; missing_keep=${missingKeep.length}; automatic retry is disabled`);
  }
  const fields = await activeClient.listFields(config.appToken, config.invitationStateTableId);
  const creatorFields = await activeClient.listFields(config.appToken, config.creatorTableId);
  const bindings = resolveInvitationFields(creatorFields, fields, config.fieldIds);
  const verification = await buildInvitationCompactionPlan({
    records: current,
    bindings: bindings.state,
    source: planSource(config, schemaSha256(bindings), plan.source.avatar_backup_directory),
    builtAtMs: plan.built_at_ms,
    resolveAttachmentEvidence: attachmentResolver(activeClient, plan.source.avatar_backup_directory),
  });
  assert(!invitationCompactionPlanIsBlocked(verification), "post-delete data has blocking issues");
  assert(verification.summary.delete_candidate_count === 0, "post-delete plan still has deletion candidates");
  return {
    status: "success",
    mode: "invitation-status-compaction-apply",
    dry_run: false,
    plan_sha256: plan.plan_sha256,
    deleted_count: deleteIds.length,
    kept_count: current.length,
    verified: true,
    recovered_from_ambiguous_response: Boolean(writeError),
    archive_receipt_sha256: receipt.receipt_sha256,
  };
}

async function currentInvitationStates(config, client) {
  const current = await currentRuntime(config, { client });
  const resolver = attachmentResolver(current.client);
  const states = [];
  const invalid = [];
  for (const record of current.records) {
    try {
      states.push(await hydrateInvitationState(record, current.bindings.state, resolver));
    } catch (error) {
      invalid.push({ record_id: String(record?.record_id ?? ""), reason: error.message });
    }
  }
  return { ...current, states, invalid };
}

function restorePayload(record, bindings) {
  const values = record.values;
  const fields = {
    [bindings.creator.name]: [values.creator_record_id],
    [bindings.status.name]: values.state,
    [bindings.observedAt.name]: values.observed_at_ms,
  };
  if (values.nickname) fields[bindings.nickname.name] = values.nickname;
  if (values.external_user_id) fields[bindings.externalUserId.name] = values.external_user_id;
  return { fields };
}

function archiveBlobMap(archive) {
  return new Map(archive.avatar_blobs.map((blob) => [blob.sha256, blob]));
}

async function materializeBlob(blob, directory) {
  const content = Buffer.from(blob.content_base64, "base64");
  const filePath = path.join(directory, `${blob.sha256}.bin`);
  await fs.writeFile(filePath, content, { mode: 0o600, flag: "wx" });
  return { path: filePath, name: blob.name, mimeType: blob.mime_type, size: blob.size, sha256: blob.sha256 };
}

export async function inspectInvitationArchiveRestore({ archive, config, client }) {
  validateInvitationArchive(archive, config);
  const current = await currentInvitationStates(config, client);
  const creators = await current.client.listRecords(config.appToken, config.creatorTableId);
  const creatorIds = new Set(creators.map((record) => String(record.record_id ?? "")));
  const inspection = inspectInvitationRestore(archive, current.states);
  for (const record of archive.records) {
    if (!creatorIds.has(record.values.creator_record_id)) {
      inspection.conflicts.push({ restore_key: record.restore_key, reason: "creator_record_missing" });
    }
  }
  if (current.invalid.length) {
    for (const item of current.invalid) inspection.conflicts.push({ restore_key: "", reason: `invalid_live_record:${item.record_id}` });
  }
  inspection.conflict_count = inspection.conflicts.length;
  inspection.status = inspection.conflict_count ? "blocked" : inspection.create_count || inspection.attachment_record_count ? "ready" : "unchanged";
  return { ...inspection, current };
}

export async function restoreInvitationArchive({
  archive,
  config,
  apply = false,
  expectArchiveSha256,
  confirmCreate,
  confirmAttach,
  client,
}) {
  const dryRun = await inspectInvitationArchiveRestore({ archive, config, client });
  const publicReport = {
    status: dryRun.status,
    mode: "invitation-status-compaction-restore",
    dry_run: true,
    archive_sha256: archive.archive_sha256,
    archived_record_count: archive.records.length,
    create_count: dryRun.create_count,
    attachment_record_count: dryRun.attachment_record_count,
    already_restored_count: dryRun.already_restored_count,
    conflict_count: dryRun.conflict_count,
  };
  if (!apply) return publicReport;
  assert(dryRun.status !== "blocked", "archive conflicts block restore");
  assert(expectArchiveSha256 === archive.archive_sha256, "--expect-archive-sha256 does not match archive");
  assert(Number(confirmCreate) === dryRun.create_count, "--confirm-create does not match dry-run count");
  assert(Number(confirmAttach) === dryRun.attachment_record_count, "--confirm-attach does not match dry-run count");
  if (!dryRun.create_count && !dryRun.attachment_record_count) return { ...publicReport, dry_run: false, status: "unchanged", verified: true };

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "invitation-restore-"));
  await fs.chmod(tempDirectory, 0o700);
  const blobs = archiveBlobMap(archive);
  const files = new Map();
  const fileFor = async (hash) => {
    if (!files.has(hash)) files.set(hash, await materializeBlob(blobs.get(hash), tempDirectory));
    return files.get(hash);
  };
  let writeError = null;
  try {
    for (let index = 0; index < dryRun.creates.length; index += BATCH_SIZE) {
      const batch = dryRun.creates.slice(index, index + BATCH_SIZE);
      const created = await dryRun.current.client.batchCreate(
        config.appToken,
        config.invitationStateTableId,
        batch.map((record) => restorePayload(record, dryRun.current.bindings.state)),
      );
      for (let rowIndex = 0; rowIndex < batch.length; rowIndex += 1) {
        const recordId = String(created[rowIndex]?.record_id ?? "");
        assert(recordId, "restored invitation record ID is missing");
        for (const avatar of batch[rowIndex].values.avatars) {
          const fileToken = await dryRun.current.client.uploadMedia(config.appToken, await fileFor(avatar.sha256));
          await dryRun.current.client.appendAttachment(
            config.appToken,
            config.invitationStateTableId,
            recordId,
            dryRun.current.bindings.state.avatar.id,
            fileToken,
          );
        }
      }
    }
    for (const item of dryRun.attachments) {
      for (const hash of item.missing_avatar_sha256) {
        const fileToken = await dryRun.current.client.uploadMedia(config.appToken, await fileFor(hash));
        await dryRun.current.client.appendAttachment(
          config.appToken,
          config.invitationStateTableId,
          item.record_id,
          dryRun.current.bindings.state.avatar.id,
          fileToken,
        );
      }
    }
  } catch (error) {
    writeError = error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
  let verification;
  for (const delayMs of [0, 500, 1500, 3000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    verification = await inspectInvitationArchiveRestore({ archive, config, client: dryRun.current.client });
    if (verification.status === "unchanged") break;
  }
  if (verification.status !== "unchanged") {
    const reason = writeError ? `write result is uncertain: ${writeError.message}` : "post-restore verification failed";
    throw new Error(`${reason}; creates=${verification.create_count}; attachments=${verification.attachment_record_count}; conflicts=${verification.conflict_count}; automatic retry is disabled`);
  }
  return {
    status: "success",
    mode: "invitation-status-compaction-restore",
    dry_run: false,
    archive_sha256: archive.archive_sha256,
    requested_create_count: dryRun.create_count,
    requested_attachment_record_count: dryRun.attachment_record_count,
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
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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
    "  node lark_invitation_compact.mjs plan --config CONFIG.json --output PLAN.json [--backup-dir PRIVATE_DIR]",
    "  node lark_invitation_compact.mjs archive --config CONFIG.json --plan PLAN.json --output-dir PRIVATE_DIR",
    "  node lark_invitation_compact.mjs receipt --config CONFIG.json --plan PLAN.json --archive ARCHIVE.json.gz --output RECEIPT.json --drive-file-id ID --drive-file-url URL --drive-file-name NAME --verified-file-sha256 HASH",
    "  node lark_invitation_compact.mjs apply --config CONFIG.json --plan PLAN.json [--archive-receipt RECEIPT.json --apply --expect-sha256 HASH --confirm-delete COUNT]",
    "  node lark_invitation_compact.mjs restore --config CONFIG.json --archive ARCHIVE.json.gz [--apply --expect-archive-sha256 HASH --confirm-create COUNT --confirm-attach COUNT]",
  ].join("\n");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const config = await loadCompactionConfig(options.config);
  let result;
  if (command === "plan") {
    result = await createInvitationCompactionPlan({ config, output: options.output, backupDirectory: options.backupDir });
  } else if (command === "archive") {
    result = await createInvitationArchive({ plan: await readPrivateJson(path.resolve(options.plan)), config, outputDirectory: options.outputDir });
  } else if (command === "receipt") {
    const plan = await readPrivateJson(path.resolve(options.plan));
    result = await createInvitationArchiveReceipt({
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
    result = await applyInvitationCompaction({
      plan,
      receipt,
      config,
      apply: options.apply,
      expectSha256: options.expectSha256,
      confirmDelete: options.confirmDelete,
    });
  } else if (command === "restore") {
    const archiveRead = await readPrivateInvitationArchive(options.archive, config);
    result = await restoreInvitationArchive({
      archive: archiveRead.archive,
      config,
      apply: options.apply,
      expectArchiveSha256: options.expectArchiveSha256,
      confirmCreate: options.confirmCreate,
      confirmAttach: options.confirmAttach,
    });
    result.archive_file_sha256 = archiveRead.file_sha256;
  } else {
    throw new Error(`unknown command: ${command}\n${usage()}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  console.error(JSON.stringify({ status: "stopped", message: error.message }));
  process.exitCode = 1;
});
