import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRefreshPlan,
  groupConsecutiveStates,
  hasBlockingRefreshIssues,
  normalizeObservations,
} from "../skills/creator-invitation-status-sync/scripts/invitation_state_core.mjs";
import {
  exportTargets,
  prepareRefresh,
  refreshPlanSha256,
  resolveInvitationFields,
} from "../skills/creator-invitation-status-sync/scripts/invitation_lark_runtime.mjs";
import { LARK_MEDIA_MAX_BYTES } from "../skills/_shared/lark-base-client.mjs";
import { resolveInvitationSource } from "../skills/creator-invitation-status-sync/scripts/resolve_invitation_source.mjs";
import {
  applyReviewed,
  dryRun,
} from "../skills/creator-invitation-status-sync/scripts/sync_invitation_observations.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bindings = {
  creator: { name: "Creator" },
  status: { name: "State" },
  observedAt: { name: "Observed" },
  nickname: { name: "Nickname" },
  avatar: { name: "Avatar" },
  externalUserId: { name: "External ID" },
};
const config = {
  appToken: "app",
  creatorTableId: "creatorTable",
  invitationStateTableId: "stateTable",
  dueViewId: "dueView",
  fieldIds: {
    creatorAccount: "fldAccount",
    stateCreator: "fldCreator",
    stateStatus: "fldStatus",
    stateObservedAt: "fldObserved",
    stateNickname: "fldNickname",
    stateAvatar: "fldAvatar",
    stateExternalUserId: "fldExternal",
  },
  apiOrigin: "https://example.invalid",
};
const manifest = {
  version: 1,
  targetMode: "due",
  rowCount: 1,
  rows: [{ creatorRecordId: "recCreator1", accountKey: "@Synthetic.Creator" }],
};

function observations(overrides = {}) {
  return {
    observedAt: "2030-01-02T03:04:05.000Z",
    rowCount: 1,
    creators: [
      {
        accountKey: "synthetic.creator",
        state: "synthetic_pending",
        externalUserId: "fixture-1",
        nickname: "Synthetic Creator",
        ...overrides,
      },
    ],
  };
}

function storedRecord({
  recordId = "recState1",
  state = "synthetic_pending",
  externalUserId = "fixture-1",
  nickname = "Synthetic Creator",
  observedAt = Date.parse("2030-01-01T03:04:05.000Z"),
} = {}) {
  return {
    record_id: recordId,
    fields: {
      Creator: [{ record_ids: ["recCreator1"] }],
      State: state,
      Observed: observedAt,
      Nickname: nickname,
      Avatar: [],
      "External ID": externalUserId,
    },
  };
}

const noAvatarHash = async () => {
  throw new Error("unexpected attachment");
};

test("requires an exact one-to-one target and observation set", () => {
  const normalized = normalizeObservations(observations(), manifest);
  assert.equal(normalized.creators[0].creatorRecordId, "recCreator1");
  assert.throws(
    () => normalizeObservations(observations({ accountKey: "unrequested" }), manifest),
    /unrequested account/,
  );
});

test("binds reviewed operations and every reported count into the plan hash", () => {
  const plan = {
    version: 2,
    operationMode: "refresh",
    generatedAt: "2030-01-02T03:05:00.000Z",
    manifest,
    observations: observations(),
    operations: { updates: [{ recordId: "recState1" }] },
    counts: { create: 0, update: 1, attach: 0, alreadyApplied: 0 },
  };
  const originalHash = refreshPlanSha256(plan);
  const changedOperation = structuredClone(plan);
  changedOperation.operations.updates[0].recordId = "recState2";
  const changedCount = structuredClone(plan);
  changedCount.counts.alreadyApplied = 1;
  assert.notEqual(refreshPlanSha256(changedOperation), originalHash);
  assert.notEqual(refreshPlanSha256(changedCount), originalHash);
});

test("allows the same display name in different Lark tables", () => {
  const resolved = resolveInvitationFields(
    [{ field_id: "fldAccount", field_name: "Creator", ui_type: "Url" }],
    [
      { field_id: "fldCreator", field_name: "Creator", ui_type: "DuplexLink" },
      { field_id: "fldStatus", field_name: "State", ui_type: "SingleSelect" },
      { field_id: "fldObserved", field_name: "Observed", ui_type: "DateTime" },
      { field_id: "fldNickname", field_name: "Nickname", ui_type: "Text" },
      { field_id: "fldAvatar", field_name: "Avatar", ui_type: "Attachment" },
      { field_id: "fldExternal", field_name: "External ID", ui_type: "Text" },
    ],
    config.fieldIds,
  );
  assert.equal(resolved.creatorAccount.name, resolved.state.creator.name);
});

test("extends only the timestamp when the newest state is equal", async () => {
  const plan = await buildRefreshPlan({
    observations: observations(),
    manifest,
    storedRecords: [storedRecord()],
    bindings,
    resolveAttachmentHash: noAvatarHash,
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.creates.length, 0);
  assert.equal(hasBlockingRefreshIssues(plan), false);
});

test("creates a transition when normalized state differs", async () => {
  const plan = await buildRefreshPlan({
    observations: observations({ state: "synthetic_eligible" }),
    manifest,
    storedRecords: [storedRecord()],
    bindings,
    resolveAttachmentHash: noAvatarHash,
  });
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
});

test("blocks conflicting historical external identities", async () => {
  const plan = await buildRefreshPlan({
    observations: observations({ externalUserId: "fixture-2" }),
    manifest,
    storedRecords: [storedRecord()],
    bindings,
    resolveAttachmentHash: noAvatarHash,
  });
  assert.equal(plan.identityConflicts.length, 1);
  assert.equal(hasBlockingRefreshIssues(plan), true);
});

test("adjacent compaction helper does not merge A-B-A", () => {
  const state = (recordId, value, observedAtMs) => ({
    recordId,
    creatorRecordId: "recCreator1",
    state: value,
    externalUserId: "fixture-1",
    nickname: "Synthetic",
    avatarHashes: [],
    observedAtMs,
  });
  const groups = groupConsecutiveStates([
    state("rec1", "A", 1),
    state("rec2", "A", 2),
    state("rec3", "B", 3),
    state("rec4", "A", 4),
  ]);
  assert.deepEqual(groups.map((group) => group.map((item) => item.recordId)), [
    ["rec1", "rec2"],
    ["rec3"],
    ["rec4"],
  ]);
});

test("resolves an unattended synthetic provider through npm", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-source-test-"));
  try {
    const requestPath = path.join(directory, "request.json");
    const outputPath = path.join(directory, "observations.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        inputKind: "application/x.synthetic-observation-request+json",
        observedAt: "2030-01-02T03:04:05.000Z",
        targets: [{ accountKey: "synthetic.creator" }],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const result = await resolveInvitationSource({
      providerRoot: repositoryRoot,
      request: requestPath,
      output: outputPath,
      unattended: true,
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.status, "normalized");
    assert.equal(output.rowCount, 1);
    assert.equal(output.creators[0].state, "synthetic_pending");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeLarkClient() {
  const creatorFields = [
    { field_id: "fldAccount", field_name: "Account", ui_type: "Url" },
  ];
  const stateFields = [
    { field_id: "fldCreator", field_name: "Creator", ui_type: "DuplexLink" },
    {
      field_id: "fldStatus",
      field_name: "State",
      ui_type: "SingleSelect",
      property: { options: [{ name: "synthetic_pending" }, { name: "synthetic_eligible" }] },
    },
    { field_id: "fldObserved", field_name: "Observed", ui_type: "DateTime" },
    { field_id: "fldNickname", field_name: "Nickname", ui_type: "Text" },
    { field_id: "fldAvatar", field_name: "Avatar", ui_type: "Attachment" },
    { field_id: "fldExternal", field_name: "External ID", ui_type: "Text" },
  ];
  const creators = [
    { record_id: "recCreator1", fields: { Account: { text: "synthetic.creator" } } },
  ];
  const states = [storedRecord()];
  const client = {
    creators,
    states,
    listFields: async (_appToken, tableId) =>
      tableId === config.creatorTableId ? creatorFields : stateFields,
    due: true,
    listRecords: async (_appToken, tableId, query = {}) => {
      if (tableId !== config.creatorTableId) return states;
      if (query.view_id === config.dueViewId) return client.due ? creators : [];
      return creators;
    },
    attachmentSha256: noAvatarHash,
    batchUpdate: async (_appToken, _tableId, rows) => {
      for (const row of rows) {
        const record = states.find((item) => item.record_id === row.record_id);
        Object.assign(record.fields, row.fields);
      }
      client.due = false;
    },
    batchCreate: async (_appToken, _tableId, rows) => {
      return rows.map((row, index) => {
        const record_id = `recCreated${index + 1}`;
        states.push({ record_id, fields: { ...row.fields, Avatar: [] } });
        return { record_id };
      });
    },
    uploadMedia: async () => {
      throw new Error("unexpected upload");
    },
    appendAttachment: async () => {
      throw new Error("unexpected attachment");
    },
  };
  return client;
}

test("exports due targets and applies a reviewed timestamp-only plan", async () => {
  const client = fakeLarkClient();
  const exported = await exportTargets({ client, config, mode: "due" });
  assert.equal(exported.rowCount, 1);
  assert.equal(exported.rows[0].creatorRecordId, "recCreator1");

  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-plan-test-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const preview = await dryRun({
      client,
      config,
      manifest: exported,
      observations: observations(),
      outputPlan: planPath,
    });
    assert.equal(preview.update, 1);
    const reviewed = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(
      reviewed.planSha256,
      refreshPlanSha256(reviewed),
    );
    const result = await applyReviewed({
      client,
      config,
      reviewed,
      args: {
        expectSha256: reviewed.planSha256,
        confirmCreate: 0,
        confirmUpdate: 1,
        confirmAttach: 0,
        confirmAlreadyApplied: 0,
      },
    });
    assert.equal(result.verified, true);
    assert.equal(client.states[0].fields.Observed, Date.parse(observations().observedAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects live operation drift even when mutation counts stay equal", async () => {
  const client = fakeLarkClient();
  const exported = await exportTargets({ client, config, mode: "due" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-plan-drift-test-"));
  try {
    const planPath = path.join(directory, "plan.json");
    await dryRun({
      client,
      config,
      manifest: exported,
      observations: observations(),
      outputPlan: planPath,
    });
    const reviewed = JSON.parse(await readFile(planPath, "utf8"));
    client.states[0].record_id = "recStateChangedAfterReview";
    await assert.rejects(
      applyReviewed({
        client,
        config,
        reviewed,
        args: {
          expectSha256: reviewed.planSha256,
          confirmCreate: 0,
          confirmUpdate: 1,
          confirmAttach: 0,
          confirmAlreadyApplied: 0,
        },
      }),
      /live plan differs from the reviewed plan/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks an avatar attachment when a reviewed due target is no longer due", async () => {
  const client = fakeLarkClient();
  const exported = await exportTargets({ client, config, mode: "due" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-avatar-due-test-"));
  try {
    const avatarPath = path.join(directory, "avatar.png");
    const content = Buffer.from("synthetic avatar bytes");
    await writeFile(avatarPath, content, { mode: 0o600 });
    client.states[0].fields.Observed = Date.parse(observations().observedAt);
    client.due = false;
    const prepared = await prepareRefresh({
      client,
      config,
      manifest: exported,
      observations: observations({
        avatar: {
          path: avatarPath,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.length,
          name: "avatar.png",
          mimeType: "image/png",
        },
      }),
    });
    assert.equal(prepared.counts.attach, 1);
    assert.equal(prepared.blocked, true);
    assert.deepEqual(prepared.corePlan.staleObservations, [
      { accountKey: "synthetic.creator", reason: "creator is no longer due" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects avatars above the Lark verification limit before any Lark read", async () => {
  const client = fakeLarkClient();
  let fieldReads = 0;
  const listFields = client.listFields;
  client.listFields = async (...args) => {
    fieldReads += 1;
    return listFields(...args);
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "invitation-avatar-limit-test-"));
  try {
    const avatarPath = path.join(directory, "oversize.png");
    const content = Buffer.alloc(LARK_MEDIA_MAX_BYTES + 1, 1);
    await writeFile(avatarPath, content, { mode: 0o600 });
    await assert.rejects(
      prepareRefresh({
        client,
        config,
        manifest,
        observations: observations({
          avatar: {
            path: avatarPath,
            sha256: createHash("sha256").update(content).digest("hex"),
            size: content.length,
            name: "oversize.png",
            mimeType: "image/png",
          },
        }),
      }),
      /avatar file size/,
    );
    assert.equal(LARK_MEDIA_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(fieldReads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
