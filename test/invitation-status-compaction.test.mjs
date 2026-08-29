import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInvitationCompactionPlan,
  calculateInvitationArchiveSha256,
  inspectInvitationRestore,
  invitationCompactionPlanIsBlocked,
} from "../skills/creator-invitation-status-compaction/scripts/invitation_compaction_core.mjs";
import {
  applyInvitationCompaction,
  buildInvitationArchive,
  buildInvitationArchiveReceipt,
  createInvitationCompactionPlan,
  invitationCompactionConfigurationSha256,
  restoreInvitationArchive,
  validateInvitationArchive,
  validateInvitationArchiveReceipt,
} from "../skills/creator-invitation-status-compaction/scripts/lark_invitation_compact.mjs";

const bindings = {
  creator: { id: "fldCreator", name: "Renamed creator", type: "DuplexLink", property: null },
  status: { id: "fldStatus", name: "Renamed status", type: "SingleSelect", property: null },
  observedAt: { id: "fldObserved", name: "Renamed observed", type: "DateTime", property: null },
  nickname: { id: "fldNickname", name: "Renamed nickname", type: "Text", property: null },
  avatar: { id: "fldAvatar", name: "Renamed avatar", type: "Attachment", property: null },
  externalUserId: { id: "fldExternal", name: "Renamed external", type: "Text", property: null },
};

const config = {
  appToken: "app",
  creatorTableId: "creators",
  invitationStateTableId: "states",
  dueViewId: "due",
  fieldIds: {
    creatorAccount: "fldAccount",
    stateCreator: "fldCreator",
    stateStatus: "fldStatus",
    stateObservedAt: "fldObserved",
    stateNickname: "fldNickname",
    stateAvatar: "fldAvatar",
    stateExternalUserId: "fldExternal",
  },
  archiveDestination: {
    sharedDriveId: "shared-drive",
    folderId: "private-folder",
    mimeType: "application/gzip",
  },
  apiOrigin: "https://example.invalid",
};

function storedRecord({
  recordId,
  creator = "creator-1",
  state = "A",
  observedAtMs,
  externalUserId = "external-1",
  nickname = "Synthetic",
  avatars = [],
}) {
  return {
    record_id: recordId,
    fields: {
      [bindings.creator.name]: [{ record_ids: [creator] }],
      [bindings.status.name]: state,
      [bindings.observedAt.name]: observedAtMs,
      [bindings.externalUserId.name]: externalUserId,
      [bindings.nickname.name]: nickname,
      [bindings.avatar.name]: avatars,
    },
  };
}

const noAvatar = async () => {
  throw new Error("unexpected avatar");
};

function source(backupDirectory = "/private/synthetic-avatars") {
  return {
    configuration_sha256: invitationCompactionConfigurationSha256(config),
    schema_sha256: "a".repeat(64),
    app_token: config.appToken,
    invitation_state_table_id: config.invitationStateTableId,
    avatar_backup_directory: backupDirectory,
  };
}

test("compacts only adjacent equal states and preserves A-B-A", async () => {
  const plan = await buildInvitationCompactionPlan({
    records: [
      storedRecord({ recordId: "recA1", observedAtMs: 1 }),
      storedRecord({ recordId: "recA2", observedAtMs: 2 }),
      storedRecord({ recordId: "recB", observedAtMs: 3, state: "B" }),
      storedRecord({ recordId: "recA3", observedAtMs: 4 }),
    ],
    bindings,
    source: source(),
    builtAtMs: 100,
    resolveAttachmentEvidence: noAvatar,
  });
  assert.equal(invitationCompactionPlanIsBlocked(plan), false);
  assert.equal(plan.summary.delete_candidate_count, 1);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].keep_record_id, "recA2");
  assert.deepEqual(plan.operations[0].delete_record_ids, ["recA1"]);
});

test("identity, timestamp, and malformed records block all deletion", async () => {
  const plans = await Promise.all([
    buildInvitationCompactionPlan({
      records: [
        storedRecord({ recordId: "rec1", observedAtMs: 1, externalUserId: "one" }),
        storedRecord({ recordId: "rec2", observedAtMs: 2, externalUserId: "two" }),
      ],
      bindings,
      source: source(),
      builtAtMs: 100,
      resolveAttachmentEvidence: noAvatar,
    }),
    buildInvitationCompactionPlan({
      records: [
        storedRecord({ recordId: "rec1", observedAtMs: 1, state: "A" }),
        storedRecord({ recordId: "rec2", observedAtMs: 1, state: "B" }),
      ],
      bindings,
      source: source(),
      builtAtMs: 100,
      resolveAttachmentEvidence: noAvatar,
    }),
    buildInvitationCompactionPlan({
      records: [
        storedRecord({ recordId: "rec1", observedAtMs: 1 }),
        { record_id: "recBroken", fields: {} },
      ],
      bindings,
      source: source(),
      builtAtMs: 100,
      resolveAttachmentEvidence: noAvatar,
    }),
  ]);
  assert.equal(plans[0].summary.identity_conflict_count, 1);
  assert.equal(plans[1].summary.timestamp_conflict_count, 1);
  assert.equal(plans[2].summary.invalid_record_count, 1);
  for (const plan of plans) assert.equal(invitationCompactionPlanIsBlocked(plan), true);
});

test("avatar bytes are part of equality", async () => {
  const evidence = new Map([
    ["token-a", { sha256: "a".repeat(64), size: 3, name: "a.png", mimeType: "image/png" }],
    ["token-b", { sha256: "b".repeat(64), size: 3, name: "b.png", mimeType: "image/png" }],
  ]);
  const plan = await buildInvitationCompactionPlan({
    records: [
      storedRecord({ recordId: "rec1", observedAtMs: 1, avatars: [{ file_token: "token-a" }] }),
      storedRecord({ recordId: "rec2", observedAtMs: 2, avatars: [{ file_token: "token-b" }] }),
    ],
    bindings,
    source: source(),
    builtAtMs: 100,
    resolveAttachmentEvidence: async (attachment) => evidence.get(attachment.file_token),
  });
  assert.equal(plan.summary.delete_candidate_count, 0);
});

test("archive embeds verified avatar bytes and receipt binds the Drive destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-archive-test-"));
  try {
    const avatarPath = path.join(directory, "avatar.bin");
    const content = Buffer.from("avatar");
    await writeFile(avatarPath, content, { mode: 0o600 });
    const avatar = {
      sha256: (await import("node:crypto")).createHash("sha256").update(content).digest("hex"),
      size: content.length,
      name: "avatar.png",
      mimeType: "image/png",
      path: avatarPath,
    };
    const plan = await buildInvitationCompactionPlan({
      records: [
        storedRecord({ recordId: "rec1", observedAtMs: 1, avatars: [{ file_token: "token" }] }),
        storedRecord({ recordId: "rec2", observedAtMs: 2, avatars: [{ file_token: "token" }] }),
      ],
      bindings,
      source: source(directory),
      builtAtMs: 100,
      resolveAttachmentEvidence: async () => avatar,
    });
    const archive = await buildInvitationArchive(plan, config, 200);
    validateInvitationArchive(archive, config);
    assert.equal(Buffer.from(archive.avatar_blobs[0].content_base64, "base64").toString(), "avatar");
    const receipt = buildInvitationArchiveReceipt(archive, config, {
      file_id: "drive_file_12345",
      folder_id: config.archiveDestination.folderId,
      file_name: archive.file_name,
      file_url: "https://drive.google.com/file/d/synthetic",
      file_sha256: "c".repeat(64),
    }, 300);
    validateInvitationArchiveReceipt(receipt, plan, config, "c".repeat(64));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore inspection distinguishes create, attachment resume, exact, and conflict", () => {
  const blob = {
    sha256: "a".repeat(64),
    size: 3,
    name: "avatar.png",
    mime_type: "image/png",
    content_base64: Buffer.from("aaa").toString("base64"),
  };
  const record = {
    original_record_id: "recOld",
    restore_key: "restore-1",
    values: {
      creator_record_id: "creator-1",
      state: "A",
      external_user_id: "external-1",
      nickname: "Synthetic",
      observed_at_ms: 1,
      avatars: [{ sha256: blob.sha256, size: blob.size, name: blob.name, mimeType: blob.mime_type }],
    },
  };
  const archive = { records: [record] };
  assert.equal(inspectInvitationRestore(archive, []).create_count, 1);
  const current = {
    recordId: "recCurrent",
    creatorRecordId: "creator-1",
    state: "A",
    externalUserId: "external-1",
    nickname: "Synthetic",
    observedAtMs: 1,
    avatarEvidence: [],
  };
  assert.equal(inspectInvitationRestore(archive, [current]).attachment_record_count, 1);
  assert.equal(inspectInvitationRestore(archive, [{ ...current, avatarEvidence: [{ sha256: blob.sha256, size: 3, name: "avatar.png", mimeType: "image/png" }] }]).status, "unchanged");
  assert.equal(inspectInvitationRestore(archive, [{ ...current, state: "B" }]).status, "blocked");
});

function fakeClient(initialStates = []) {
  const stateFields = [
    { field_id: "fldCreator", field_name: bindings.creator.name, ui_type: "DuplexLink" },
    { field_id: "fldStatus", field_name: bindings.status.name, ui_type: "SingleSelect", property: { options: [{ name: "A" }, { name: "B" }] } },
    { field_id: "fldObserved", field_name: bindings.observedAt.name, ui_type: "DateTime" },
    { field_id: "fldNickname", field_name: bindings.nickname.name, ui_type: "Text" },
    { field_id: "fldAvatar", field_name: bindings.avatar.name, ui_type: "Attachment" },
    { field_id: "fldExternal", field_name: bindings.externalUserId.name, ui_type: "Text" },
  ];
  const creatorFields = [{ field_id: "fldAccount", field_name: "Renamed account", ui_type: "Url" }];
  const creators = [{ record_id: "creator-1", fields: { "Renamed account": { text: "synthetic" } } }];
  const states = initialStates.map((row) => structuredClone(row));
  const media = new Map();
  let nextRecord = 1;
  let nextMedia = 1;
  const client = {
    states,
    listFields: async (_appToken, tableId) => tableId === config.creatorTableId ? creatorFields : stateFields,
    listRecords: async (_appToken, tableId) => tableId === config.creatorTableId ? creators : states,
    downloadAttachment: async (attachment) => {
      const item = media.get(attachment.file_token);
      if (!item) throw new Error("missing fake media");
      return { fileToken: attachment.file_token, ...item };
    },
    batchDelete: async (_appToken, _tableId, ids) => {
      for (const id of ids) {
        const index = states.findIndex((record) => record.record_id === id);
        if (index >= 0) states.splice(index, 1);
      }
    },
    batchCreate: async (_appToken, _tableId, rows) => rows.map((row) => {
      const record_id = `recRestored${nextRecord++}`;
      states.push({ record_id, fields: { ...row.fields, [bindings.avatar.name]: [] } });
      return { record_id };
    }),
    uploadMedia: async (_appToken, avatar) => {
      const content = await readFile(avatar.path);
      const fileToken = `media${nextMedia++}`;
      media.set(fileToken, {
        content,
        sha256: avatar.sha256,
        size: content.length,
        name: avatar.name,
        mimeType: avatar.mimeType,
      });
      return fileToken;
    },
    appendAttachment: async (_appToken, _tableId, recordId, _fieldId, fileToken) => {
      states.find((record) => record.record_id === recordId).fields[bindings.avatar.name].push({ file_token: fileToken });
    },
  };
  return client;
}

test("deletes only an approved archived plan and verifies renamed fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-apply-test-"));
  try {
    const client = fakeClient([
      storedRecord({ recordId: "rec1", observedAtMs: 1 }),
      storedRecord({ recordId: "rec2", observedAtMs: 2 }),
    ]);
    const planPath = path.join(directory, "plan.json");
    await createInvitationCompactionPlan({ config, output: planPath, backupDirectory: path.join(directory, "avatars"), client, builtAtMs: 100 });
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const archive = await buildInvitationArchive(plan, config, 200);
    const receipt = buildInvitationArchiveReceipt(archive, config, {
      file_id: "drive_file_12345",
      folder_id: config.archiveDestination.folderId,
      file_name: archive.file_name,
      file_url: "https://drive.google.com/file/d/synthetic",
      file_sha256: "d".repeat(64),
    }, 300);
    const result = await applyInvitationCompaction({
      plan,
      receipt,
      config,
      apply: true,
      expectSha256: plan.plan_sha256,
      confirmDelete: 1,
      client,
    });
    assert.equal(result.verified, true);
    assert.equal(client.states.length, 1);
    assert.equal(client.states[0].record_id, "rec2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores a missing record with avatar bytes and verifies by rereading", async () => {
  const content = Buffer.from("avatar");
  const avatarSha = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
  const unsigned = {
    version: 1,
    archive_type: "creator-invitation-status-compaction-restore",
    created_at: new Date(200).toISOString(),
    created_at_ms: 200,
    plan_sha256: "e".repeat(64),
    configuration_sha256: invitationCompactionConfigurationSha256(config),
    source: source(),
    file_name: "synthetic.json.gz",
    summary: { archived_record_count: 1, avatar_blob_count: 1 },
    records: [{
      original_record_id: "recOld",
      restore_key: "restore-1",
      values: {
        creator_record_id: "creator-1",
        state: "A",
        external_user_id: "external-1",
        nickname: "Synthetic",
        observed_at_ms: 1,
        avatars: [{ sha256: avatarSha, size: content.length, name: "avatar.png", mimeType: "image/png" }],
      },
    }],
    avatar_blobs: [{
      sha256: avatarSha,
      size: content.length,
      name: "avatar.png",
      mime_type: "image/png",
      content_base64: content.toString("base64"),
    }],
  };
  const archive = { ...unsigned, archive_sha256: calculateInvitationArchiveSha256(unsigned) };
  const client = fakeClient([]);
  const result = await restoreInvitationArchive({
    archive,
    config,
    apply: true,
    expectArchiveSha256: archive.archive_sha256,
    confirmCreate: 1,
    confirmAttach: 0,
    client,
  });
  assert.equal(result.verified, true);
  assert.equal(client.states.length, 1);
  assert.equal(client.states[0].fields[bindings.avatar.name].length, 1);
});
