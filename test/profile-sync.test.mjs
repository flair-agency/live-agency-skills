import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProfileObservations } from "@live-agency-skills/source-provider-api";

import {
  PROFILE_TARGET_INPUT_KIND,
  buildProfileSyncPlan,
  planIsBlocked,
  sha256Json,
} from "../skills/creator-profile-sync/scripts/profile_sync_core.mjs";
import {
  applyProfilePlan,
  exportProfileTargets,
  prepareProfilePlan,
  resolveProfileFields,
} from "../skills/creator-profile-sync/scripts/profile_lark_runtime.mjs";
import { resolveProfileSource } from "../skills/creator-profile-sync/scripts/resolve_profile_source.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const NOW = Date.parse("2030-01-31T03:04:05.000Z");
const CREATOR_ID = "recCreator0001";

const config = {
  appToken: "app",
  creatorTableId: "creator-table",
  profileTableId: "profile-table",
  dueViewId: "due-view",
  fieldIds: {
    creatorAccount: "fldAccount",
    profileTimestamp: "fldProfileTime",
    profileCreator: "fldProfileCreator",
    profileFollowerCount: "fldFollowers",
    profileRecentPostCount30d: "fldRecentPosts",
    profileLatestPostAt: "fldLatestPost",
    profileNickname: "fldNickname",
    profileAvatar: "fldAvatar",
    profileFeatureObservationData: "fldFeatureData",
  },
  apiOrigin: "https://example.invalid",
};

function fieldDefinitions(prefix = "Renamed ") {
  return {
    creator: [{ field_id: "fldAccount", field_name: `${prefix}Account`, ui_type: "Url" }],
    profile: [
      { field_id: "fldProfileTime", field_name: `${prefix}Profile Time`, ui_type: "CreatedTime" },
      {
        field_id: "fldProfileCreator",
        field_name: `${prefix}Creator`,
        ui_type: "DuplexLink",
        property: { table_id: "creator-table", multiple: false },
      },
      { field_id: "fldFollowers", field_name: `${prefix}Followers`, ui_type: "Number" },
      { field_id: "fldRecentPosts", field_name: `${prefix}Recent Posts`, ui_type: "Number" },
      { field_id: "fldLatestPost", field_name: `${prefix}Latest Post`, ui_type: "DateTime" },
      { field_id: "fldNickname", field_name: `${prefix}Nickname`, ui_type: "Text" },
      { field_id: "fldAvatar", field_name: `${prefix}Avatar`, ui_type: "Attachment" },
      { field_id: "fldFeatureData", field_name: `${prefix}Feature Data`, ui_type: "Text" },
    ],
  };
}

function bindings() {
  const fields = fieldDefinitions();
  return resolveProfileFields(fields.creator, fields.profile, config);
}

function targetManifest(overrides = {}) {
  const rows = overrides.rows ?? [{ creatorRecordId: CREATOR_ID, accountKey: "synthetic.creator" }];
  return {
    version: 2,
    inputKind: PROFILE_TARGET_INPUT_KIND,
    generatedAt: new Date(NOW).toISOString(),
    targetMode: overrides.targetMode ?? "due",
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
}

function featureData({ nickname = "Synthetic Creator", recentPosts = 8 } = {}) {
  return {
    schema_version: 1,
    profile: { display_name: nickname, bio: null, links: [] },
    posts: { last_30_days_count: recentPosts, items: [] },
    observation: { observed_at: new Date(NOW).toISOString(), scope: "synthetic public data" },
  };
}

function observations(overrides = {}) {
  const profile = {
    followerCount: 12300,
    followerStatus: "observed_rounded",
    followerDisplay: "12.3K",
    recentPostCount30d: 8,
    recentPostStatus: "observed_exact",
    latestPostAt: "2030-01-30T01:00:00.000Z",
    latestPostStatus: "observed_exact",
    nickname: "Synthetic Creator",
    nicknameStatus: "observed_exact",
    avatar: null,
    avatarStatus: "not_available",
    featureObservationData: featureData(),
    featureObservationStatus: "observed_exact",
    ...(overrides.profile ?? {}),
  };
  return {
    observedAt: new Date(NOW).toISOString(),
    rowCount: 1,
    creators: [{
      creatorRecordId: overrides.creatorRecordId ?? CREATOR_ID,
      accountKey: overrides.accountKey ?? "synthetic.creator",
      observedAt: new Date(NOW).toISOString(),
      profile,
    }],
  };
}

test("validates normalized public-profile observations and cross-field consistency", () => {
  assert.equal(validateProfileObservations(observations()).rowCount, 1);
  assert.throws(
    () => validateProfileObservations(observations({ profile: {
      recentPostCount30d: 7,
      featureObservationData: featureData({ recentPosts: 8 }),
    } })),
    /last_30_days_count does not match/,
  );
  assert.throws(
    () => validateProfileObservations(observations({ profile: {
      nickname: null,
      nicknameStatus: "observed_exact",
      featureObservationData: null,
      featureObservationStatus: "not_available",
    } })),
    /null value cannot be observed/,
  );
});

test("resolves renamed profile fields strictly by stable IDs", () => {
  const resolved = bindings();
  assert.equal(resolved.creator.account.name, "Renamed Account");
  assert.equal(resolved.profile.featureObservationData.name, "Renamed Feature Data");
  assert.equal(resolved.profile.avatar.type, "Attachment");
});

test("builds profile-only creates and treats unavailable values as replay wildcards", async () => {
  const resolved = bindings();
  const first = await buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: observations(),
    profileRecords: [],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(first.summary.profileCreateCount, 1);
  assert.equal(first.summary.profileAttachCount, 0);
  assert.equal(planIsBlocked(first), false);
  assert.equal("liveCreates" in first.operations, false);

  const partial = observations({ profile: {
    recentPostCount30d: null,
    recentPostStatus: "not_available",
    latestPostAt: null,
    latestPostStatus: "not_available",
    nickname: null,
    nicknameStatus: "not_available",
    featureObservationData: null,
    featureObservationStatus: "not_available",
  } });
  const replay = await buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: partial,
    profileRecords: [{
      record_id: "recProfile0001",
      fields: {
        "Renamed Profile Time": NOW,
        "Renamed Creator": [{ record_ids: [CREATOR_ID] }],
        "Renamed Followers": 12300,
        "Renamed Recent Posts": 99,
        "Renamed Latest Post": NOW - 1000,
        "Renamed Nickname": "Changed later",
      },
    }],
    bindings: resolved,
    resolveAttachmentHash: async () => "a".repeat(64),
    nowMs: NOW,
  });
  assert.equal(replay.summary.profileAlreadyAppliedCount, 1);
  assert.equal(replay.summary.profileCreateCount, 0);
});

test("resumes a missing avatar attachment without creating another profile row", async () => {
  const avatar = {
    path: "/private/synthetic/avatar.png",
    sha256: "a".repeat(64),
    size: 10,
    name: "avatar.png",
    mimeType: "image/png",
  };
  const desired = observations({ profile: { avatar, avatarStatus: "observed_exact" } });
  const record = {
    record_id: "recProfile0001",
    fields: {
      "Renamed Profile Time": NOW,
      "Renamed Creator": [CREATOR_ID],
      "Renamed Followers": 12300,
      "Renamed Recent Posts": 8,
      "Renamed Latest Post": Date.parse("2030-01-30T01:00:00.000Z"),
      "Renamed Nickname": "Synthetic Creator",
      "Renamed Feature Data": JSON.stringify(featureData()),
      "Renamed Avatar": [],
    },
  };
  const result = await buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: desired,
    profileRecords: [record],
    bindings: bindings(),
    resolveAttachmentHash: async () => {
      throw new Error("unexpected attachment");
    },
    nowMs: NOW,
  });
  assert.equal(result.summary.profileCreateCount, 0);
  assert.equal(result.summary.profileAttachExistingCount, 1);
  assert.equal(result.summary.profileAttachCount, 1);
});

test("blocks missing targets and malformed stored profile records", async () => {
  const result = await buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: observations({ creatorRecordId: "recUnexpected01", accountKey: "unexpected" }),
    profileRecords: [{ record_id: "recBroken0001", fields: {} }],
    bindings: bindings(),
    nowMs: NOW,
  });
  assert.equal(result.summary.targetIssueCount, 2);
  assert.equal(result.summary.invalidStoredProfileCount, 1);
  assert.equal(planIsBlocked(result), true);
});

function fakeLarkClient() {
  const fields = fieldDefinitions();
  const creators = [
    { record_id: CREATOR_ID, fields: { "Renamed Account": { text: "@Synthetic.Creator" } } },
  ];
  const profiles = [];
  const calls = [];
  return {
    calls,
    listFields: async (_appToken, tableId) => tableId === config.creatorTableId ? fields.creator : fields.profile,
    listRecords: async (_appToken, tableId, query = {}) => {
      if (tableId === config.creatorTableId) {
        if (query.view_id && query.view_id !== config.dueViewId) return [];
        return creators;
      }
      return profiles;
    },
    batchCreate: async (_appToken, tableId, rows) => {
      calls.push({ tableId, rows: structuredClone(rows) });
      return rows.map((row, index) => {
        const record_id = `recProfileNew${index}`;
        profiles.push({
          record_id,
          fields: { ...row.fields, "Renamed Profile Time": NOW },
        });
        return { record_id };
      });
    },
    attachmentSha256: async () => {
      throw new Error("unexpected attachment");
    },
    uploadMedia: async () => {
      throw new Error("unexpected upload");
    },
    appendAttachment: async () => {
      throw new Error("unexpected attachment append");
    },
  };
}

test("exports profile-only targets and verifies append-only writes by rereading", async () => {
  const client = fakeLarkClient();
  const manifest = await exportProfileTargets({ client, config, nowMs: NOW });
  assert.equal(manifest.rowCount, 1);
  assert.deepEqual(Object.keys(manifest.rows[0]).sort(), ["accountKey", "creatorRecordId"]);

  const prepared = await prepareProfilePlan({ client, config, manifest, observations: observations(), nowMs: NOW });
  const result = await applyProfilePlan({
    client,
    config,
    reviewedPlan: prepared.plan,
    apply: true,
    expectSha256: prepared.plan.planSha256,
    confirmProfileCreate: 1,
    confirmProfileAttach: 0,
  });
  assert.equal(result.status, "success");
  assert.equal(result.verified, true);
  assert.deepEqual(client.calls.map((call) => call.tableId), ["profile-table"]);
  assert.deepEqual(Object.keys(client.calls[0].rows[0].fields).sort(), [
    "Renamed Creator",
    "Renamed Feature Data",
    "Renamed Followers",
    "Renamed Latest Post",
    "Renamed Nickname",
    "Renamed Recent Posts",
  ]);
});

test("includes an uploaded avatar in the new profile create for record-created flows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-avatar-test-"));
  try {
    const avatarPath = path.join(directory, "avatar.png");
    const bytes = Buffer.from("synthetic-avatar-bytes");
    await writeFile(avatarPath, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const withAvatar = observations({ profile: {
      avatar: {
        path: avatarPath,
        sha256,
        size: bytes.length,
        name: "avatar.png",
        mimeType: "image/png",
      },
      avatarStatus: "observed_exact",
    } });
    const client = fakeLarkClient();
    client.uploadMedia = async () => "synthetic-avatar-token";
    client.attachmentSha256 = async (attachment) => {
      assert.equal(attachment.file_token, "synthetic-avatar-token");
      return sha256;
    };
    const manifest = await exportProfileTargets({ client, config, nowMs: NOW });
    const prepared = await prepareProfilePlan({ client, config, manifest, observations: withAvatar, nowMs: NOW });
    const result = await applyProfilePlan({
      client,
      config,
      reviewedPlan: prepared.plan,
      apply: true,
      expectSha256: prepared.plan.planSha256,
      confirmProfileCreate: 1,
      confirmProfileAttach: 1,
    });
    assert.equal(result.status, "success");
    assert.deepEqual(
      client.calls[0].rows[0].fields["Renamed Avatar"],
      [{ file_token: "synthetic-avatar-token" }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers a manual profile provider through npm without hardcoded provider IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-source-test-"));
  try {
    const requestPath = path.join(directory, "request.json");
    const outputPath = path.join(directory, "observations.json");
    await writeFile(requestPath, JSON.stringify(targetManifest()), { encoding: "utf8", mode: 0o600 });
    const result = await resolveProfileSource({
      providerRoot: repositoryRoot,
      request: requestPath,
      output: outputPath,
      unattended: false,
    });
    assert.equal(result.status, "instructions-required");
    assert.equal(result.providerPackage, "@fixture/profile-instruction-source");
    assert.match(result.instructions, /normalized creator observation/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
