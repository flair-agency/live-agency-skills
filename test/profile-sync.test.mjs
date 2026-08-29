import assert from "node:assert/strict";
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
  liveTableId: "live-table",
  dueViewId: "due-view",
  fieldIds: {
    creatorAccount: "fldAccount",
    profileTimestamp: "fldProfileTime",
    profileCreator: "fldProfileCreator",
    profileFollowerCount: "fldFollowers",
    profileCommunityCount: "fldCommunity",
    liveStart: "fldLiveStart",
    liveEnd: "fldLiveEnd",
    liveCreator: "fldLiveCreator",
    liveLikes: "fldLiveLikes",
  },
  apiOrigin: "https://example.invalid",
};

function fieldDefinitions(prefix = "Renamed ") {
  return {
    creator: [
      { field_id: "fldAccount", field_name: `${prefix}Account`, ui_type: "Url" },
    ],
    profile: [
      { field_id: "fldProfileTime", field_name: `${prefix}Profile Time`, ui_type: "CreatedTime" },
      {
        field_id: "fldProfileCreator",
        field_name: `${prefix}Creator`,
        ui_type: "DuplexLink",
        property: { table_id: "creator-table", multiple: false },
      },
      { field_id: "fldFollowers", field_name: `${prefix}Followers`, ui_type: "Number" },
      { field_id: "fldCommunity", field_name: `${prefix}Community`, ui_type: "Number" },
    ],
    live: [
      { field_id: "fldLiveStart", field_name: `${prefix}Start`, ui_type: "DateTime" },
      { field_id: "fldLiveEnd", field_name: `${prefix}End`, ui_type: "DateTime" },
      {
        field_id: "fldLiveCreator",
        field_name: `${prefix}Creator`,
        ui_type: "DuplexLink",
        property: { table_id: "creator-table", multiple: false },
      },
      { field_id: "fldLiveLikes", field_name: `${prefix}Likes`, ui_type: "Number" },
    ],
  };
}

function bindings() {
  const fields = fieldDefinitions();
  return resolveProfileFields(fields.creator, fields.profile, fields.live, config);
}

function targetManifest(overrides = {}) {
  const rows = overrides.rows ?? [
    {
      creatorRecordId: CREATOR_ID,
      accountKey: "synthetic.creator",
      liveContext: {
        cutoffAt: "2030-01-01T03:04:05.000Z",
        knownEvents: [],
      },
    },
  ];
  return {
    version: 1,
    inputKind: PROFILE_TARGET_INPUT_KIND,
    generatedAt: new Date(NOW).toISOString(),
    targetMode: overrides.targetMode ?? "due",
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
}

function observations(overrides = {}) {
  const creator = {
    creatorRecordId: CREATOR_ID,
    accountKey: "synthetic.creator",
    observedAt: new Date(NOW).toISOString(),
    profile: {
      followerCount: 12300,
      followerStatus: "observed_rounded",
      followerDisplay: "12.3K",
      communityCount: 456,
      communityStatus: "observed_exact",
    },
    liveScan: {
      mode: "incremental",
      stopReason: "known-anchor",
      knownMatchCount: 1,
    },
    lives: [
      {
        startAt: "2030-01-30T01:00:00.000Z",
        endAt: "2030-01-30T02:00:00.000Z",
        likeCount: 789,
        likeStatus: "observed_exact",
      },
    ],
    ...overrides,
  };
  return {
    observedAt: new Date(NOW).toISOString(),
    rowCount: 1,
    creators: [creator],
  };
}

test("validates normalized profile observations and rejects unsafe live data", () => {
  assert.equal(validateProfileObservations(observations()).rowCount, 1);
  assert.throws(
    () => validateProfileObservations(observations({ lives: [
      {
        startAt: "2030-01-29T00:00:00.000Z",
        endAt: "2030-01-31T00:00:01.000Z",
        likeCount: 1,
        likeStatus: "observed_exact",
      },
    ] })),
    /duration is invalid/,
  );
  assert.throws(
    () => validateProfileObservations(observations({ profile: {
      followerCount: null,
      followerStatus: "observed_exact",
      communityCount: 1,
      communityStatus: "observed_exact",
    } })),
    /null value cannot be observed/,
  );
});

test("resolves renamed fields by stable IDs and permits repeated names across tables", () => {
  const resolved = bindings();
  assert.equal(resolved.creator.account.name, "Renamed Account");
  assert.equal(resolved.profile.creator.name, "Renamed Creator");
  assert.equal(resolved.live.creator.name, "Renamed Creator");
});

test("builds append-only operations and treats unavailable profile metrics as replay wildcards", () => {
  const resolved = bindings();
  const first = buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: observations(),
    profileRecords: [],
    liveRecords: [],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(first.summary.profileCreateCount, 1);
  assert.equal(first.summary.liveCreateCount, 1);
  assert.equal(planIsBlocked(first), false);

  const partial = observations({ profile: {
    followerCount: 12300,
    followerStatus: "observed_rounded",
    followerDisplay: "12.3K",
    communityCount: null,
    communityStatus: "not_available",
  }, lives: [] });
  const replay = buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: partial,
    profileRecords: [{
      record_id: "recProfile0001",
      fields: {
        "Renamed Profile Time": NOW,
        "Renamed Creator": [{ record_ids: [CREATOR_ID] }],
        "Renamed Followers": 12300,
        "Renamed Community": 999,
      },
    }],
    liveRecords: [],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(replay.summary.profileAlreadyAppliedCount, 1);
  assert.equal(replay.summary.profileCreateCount, 0);
});

test("blocks missing targets and conflicting existing live observations", () => {
  const resolved = bindings();
  const stored = {
    record_id: "recLive000001",
    fields: {
      "Renamed Start": Date.parse("2030-01-30T01:00:00.000Z"),
      "Renamed End": Date.parse("2030-01-30T02:00:00.000Z"),
      "Renamed Creator": [{ record_ids: [CREATOR_ID] }],
      "Renamed Likes": 700,
    },
  };
  const conflict = buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: observations(),
    profileRecords: [],
    liveRecords: [stored],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(conflict.summary.liveConflictCount, 1);
  assert.equal(planIsBlocked(conflict), true);

  const missing = observations({ creatorRecordId: "recUnexpected01", accountKey: "unexpected" });
  const targetIssue = buildProfileSyncPlan({
    manifest: targetManifest(),
    observations: missing,
    profileRecords: [],
    liveRecords: [],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(targetIssue.summary.targetIssueCount, 2);
  assert.equal(planIsBlocked(targetIssue), true);
});

function fakeLarkClient() {
  const fields = fieldDefinitions();
  const creators = [
    { record_id: CREATOR_ID, fields: { "Renamed Account": { text: "@Synthetic.Creator" } } },
  ];
  const profiles = [];
  const lives = [
    {
      record_id: "recLiveAnchor1",
      fields: {
        "Renamed Start": Date.parse("2030-01-20T01:00:00.000Z"),
        "Renamed End": Date.parse("2030-01-20T02:00:00.000Z"),
        "Renamed Creator": [{ record_ids: [CREATOR_ID] }],
        "Renamed Likes": 100,
      },
    },
  ];
  const calls = [];
  const client = {
    calls,
    listFields: async (_appToken, tableId) => {
      if (tableId === config.creatorTableId) return fields.creator;
      if (tableId === config.profileTableId) return fields.profile;
      return fields.live;
    },
    listRecords: async (_appToken, tableId, query = {}) => {
      if (tableId === config.creatorTableId) {
        if (query.view_id && query.view_id !== config.dueViewId) return [];
        return creators;
      }
      return tableId === config.profileTableId ? profiles : lives;
    },
    batchCreate: async (_appToken, tableId, rows) => {
      calls.push({ tableId, rows: structuredClone(rows) });
      const destination = tableId === config.profileTableId ? profiles : lives;
      return rows.map((row, index) => {
        const record_id = tableId === config.profileTableId
          ? `recProfileNew${index}`
          : `recLiveNew000${index}`;
        const storedFields = { ...row.fields };
        if (tableId === config.profileTableId) storedFields["Renamed Profile Time"] = NOW;
        destination.push({ record_id, fields: storedFields });
        return { record_id };
      });
    },
  };
  return client;
}

test("exports due targets with live anchors and verifies append-only writes by rereading", async () => {
  const client = fakeLarkClient();
  const manifest = await exportProfileTargets({ client, config, nowMs: NOW });
  assert.equal(manifest.rowCount, 1);
  assert.equal(manifest.rows[0].liveContext.knownEvents.length, 1);

  const prepared = await prepareProfilePlan({
    client,
    config,
    manifest,
    observations: observations(),
    nowMs: NOW,
  });
  const result = await applyProfilePlan({
    client,
    config,
    reviewedPlan: prepared.plan,
    apply: true,
    expectSha256: prepared.plan.planSha256,
    confirmProfileCreate: 1,
    confirmLiveCreate: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.verified, true);
  assert.deepEqual(client.calls.map((call) => call.tableId), ["profile-table", "live-table"]);
  assert.deepEqual(Object.keys(client.calls[0].rows[0].fields).sort(), [
    "Renamed Community",
    "Renamed Creator",
    "Renamed Followers",
  ]);
});

test("discovers a manual provider through npm without hardcoded provider IDs", async () => {
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
