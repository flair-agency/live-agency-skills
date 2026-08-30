import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateLiveHistoryObservations } from "@live-agency-skills/source-provider-api";

import {
  LIVE_HISTORY_TARGET_INPUT_KIND,
  buildLiveHistorySyncPlan,
  livePlanIsBlocked,
  sha256Json,
} from "../skills/creator-live-history-sync/scripts/live_history_sync_core.mjs";
import {
  applyLiveHistoryPlan,
  exportLiveHistoryTargets,
  prepareLiveHistoryPlan,
  resolveLiveHistoryFields,
} from "../skills/creator-live-history-sync/scripts/live_history_lark_runtime.mjs";
import { resolveLiveHistorySource } from "../skills/creator-live-history-sync/scripts/resolve_live_history_source.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const NOW = Date.parse("2030-01-31T03:04:05.000Z");
const CREATOR_ID = "recCreator0001";
const NEW_LIVE_START = Date.parse("2030-01-30T01:00:00.000Z");
const NEW_LIVE_END = Date.parse("2030-01-30T02:00:00.000Z");

const config = {
  appToken: "app",
  creatorTableId: "creator-table",
  liveTableId: "live-table",
  metricTableId: "metric-table",
  dueViewId: "due-view",
  fieldIds: {
    creatorAccount: "fldAccount",
    creatorLatestLiveAt: "fldCreatorLatest",
    creatorLiveDays30d: "fldCreatorDays",
    creatorLiveHours30d: "fldCreatorHours",
    creatorLikes30d: "fldCreatorLikes",
    liveStart: "fldLiveStart",
    liveEnd: "fldLiveEnd",
    liveCreator: "fldLiveCreator",
    liveLikes: "fldLiveLikes",
    metricTimestamp: "fldMetricTime",
    metricCreator: "fldMetricCreator",
    metricFanClub: "fldMetricFanClub",
    metricLatestLiveAt: "fldMetricLatest",
    metricLiveDays30d: "fldMetricDays",
    metricLiveHours30d: "fldMetricHours",
    metricLikes30d: "fldMetricLikes",
  },
  apiOrigin: "https://example.invalid",
};

function fieldDefinitions(prefix = "Renamed ") {
  return {
    creator: [
      { field_id: "fldAccount", field_name: `${prefix}Account`, ui_type: "Url" },
      { field_id: "fldCreatorLatest", field_name: `${prefix}Creator Latest`, ui_type: "Lookup" },
      { field_id: "fldCreatorDays", field_name: `${prefix}Creator Days`, ui_type: "Formula" },
      { field_id: "fldCreatorHours", field_name: `${prefix}Creator Hours`, ui_type: "Formula" },
      { field_id: "fldCreatorLikes", field_name: `${prefix}Creator Likes`, ui_type: "Lookup" },
    ],
    live: [
      { field_id: "fldLiveStart", field_name: `${prefix}Live Start`, ui_type: "DateTime" },
      { field_id: "fldLiveEnd", field_name: `${prefix}Live End`, ui_type: "DateTime" },
      {
        field_id: "fldLiveCreator",
        field_name: `${prefix}Live Creator`,
        ui_type: "DuplexLink",
        property: { table_id: "creator-table", multiple: false },
      },
      { field_id: "fldLiveLikes", field_name: `${prefix}Live Likes`, ui_type: "Number" },
    ],
    metric: [
      { field_id: "fldMetricTime", field_name: `${prefix}Metric Time`, ui_type: "DateTime" },
      {
        field_id: "fldMetricCreator",
        field_name: `${prefix}Metric Creator`,
        ui_type: "DuplexLink",
        property: { table_id: "creator-table", multiple: false },
      },
      { field_id: "fldMetricFanClub", field_name: `${prefix}Metric Fan Club`, ui_type: "Number" },
      { field_id: "fldMetricLatest", field_name: `${prefix}Metric Latest`, ui_type: "DateTime" },
      { field_id: "fldMetricDays", field_name: `${prefix}Metric Days`, ui_type: "Number" },
      { field_id: "fldMetricHours", field_name: `${prefix}Metric Hours`, ui_type: "Number" },
      { field_id: "fldMetricLikes", field_name: `${prefix}Metric Likes`, ui_type: "Number" },
    ],
  };
}

function bindings() {
  const fields = fieldDefinitions();
  return resolveLiveHistoryFields(fields.creator, fields.live, fields.metric, config);
}

function targetManifest() {
  const rows = [{
    creatorRecordId: CREATOR_ID,
    accountKey: "synthetic.creator",
    liveContext: {
      cutoffAt: "2030-01-01T03:04:05.000Z",
      knownEvents: [],
    },
  }];
  return {
    version: 1,
    inputKind: LIVE_HISTORY_TARGET_INPUT_KIND,
    generatedAt: new Date(NOW).toISOString(),
    targetMode: "due",
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
}

function observations(overrides = {}) {
  return {
    observedAt: new Date(NOW).toISOString(),
    rowCount: 1,
    creators: [{
      creatorRecordId: overrides.creatorRecordId ?? CREATOR_ID,
      accountKey: overrides.accountKey ?? "synthetic.creator",
      observedAt: new Date(NOW).toISOString(),
      fanClubCount: overrides.fanClubCount ?? 456,
      fanClubStatus: overrides.fanClubStatus ?? "observed_exact",
      liveScan: overrides.liveScan ?? {
        mode: "incremental",
        stopReason: "known-anchor",
        knownMatchCount: 1,
      },
      lives: overrides.lives ?? [{
        startAt: new Date(NEW_LIVE_START).toISOString(),
        endAt: new Date(NEW_LIVE_END).toISOString(),
        likeCount: 789,
        likeStatus: "observed_exact",
      }],
    }],
  };
}

test("validates normalized LIVE observations and rejects unsafe sessions", () => {
  assert.equal(validateLiveHistoryObservations(observations()).rowCount, 1);
  assert.throws(
    () => validateLiveHistoryObservations(observations({ lives: [{
      startAt: "2030-01-29T00:00:00.000Z",
      endAt: "2030-01-31T00:00:01.000Z",
      likeCount: 1,
      likeStatus: "observed_exact",
    }] })),
    /duration is invalid/,
  );
});

test("builds independent LIVE and metric creates", () => {
  const plan = buildLiveHistorySyncPlan({
    manifest: targetManifest(),
    observations: observations(),
    liveRecords: [],
    metricRecords: [],
    bindings: bindings(),
    nowMs: NOW,
  });
  assert.equal(plan.summary.liveCreateCount, 1);
  assert.equal(plan.summary.metricCreateCount, 1);
  assert.equal(livePlanIsBlocked(plan), false);
});

test("reconciles exact metric snapshots and blocks conflicting LIVE likes", () => {
  const fields = fieldDefinitions();
  const resolved = bindings();
  const live = {
    record_id: "recLiveStored01",
    fields: {
      [`Renamed Live Start`]: NEW_LIVE_START,
      [`Renamed Live End`]: NEW_LIVE_END,
      [`Renamed Live Creator`]: [CREATOR_ID],
      [`Renamed Live Likes`]: 700,
    },
  };
  const metric = {
    record_id: "recMetricStored1",
    fields: {
      [`Renamed Metric Time`]: NOW,
      [`Renamed Metric Creator`]: [CREATOR_ID],
      [`Renamed Metric Fan Club`]: 456,
    },
  };
  const plan = buildLiveHistorySyncPlan({
    manifest: targetManifest(),
    observations: observations(),
    liveRecords: [live],
    metricRecords: [metric],
    bindings: resolved,
    nowMs: NOW,
  });
  assert.equal(plan.summary.liveConflictCount, 1);
  assert.equal(plan.summary.metricAlreadyAppliedCount, 1);
  assert.equal(plan.summary.metricCreateCount, 0);
  assert.equal(livePlanIsBlocked(plan), true);
  assert.ok(fields.metric.length > 0);
});

function fakeLarkClient() {
  const fields = fieldDefinitions();
  const creators = [{
    record_id: CREATOR_ID,
    fields: {
      "Renamed Account": { text: "@Synthetic.Creator" },
      "Renamed Creator Latest": Date.parse("2030-01-20T01:00:00.000Z"),
      "Renamed Creator Days": 1,
      "Renamed Creator Hours": 1,
      "Renamed Creator Likes": 100,
    },
  }];
  const lives = [{
    record_id: "recLiveAnchor01",
    fields: {
      "Renamed Live Start": Date.parse("2030-01-20T01:00:00.000Z"),
      "Renamed Live End": Date.parse("2030-01-20T02:00:00.000Z"),
      "Renamed Live Creator": [CREATOR_ID],
      "Renamed Live Likes": 100,
    },
  }];
  const metrics = [];
  const calls = [];
  const listCalls = [];
  return {
    calls,
    listCalls,
    listFields: async (_app, table) => {
      if (table === config.creatorTableId) return fields.creator;
      if (table === config.liveTableId) return fields.live;
      return fields.metric;
    },
    listRecords: async (_app, table, query = {}) => {
      listCalls.push({ table, query: structuredClone(query) });
      if (table === config.creatorTableId) {
        if (query.view_id && query.view_id !== config.dueViewId) return [];
        return creators;
      }
      return table === config.liveTableId ? lives : metrics;
    },
    batchCreate: async (_app, table, rows) => {
      calls.push({ table, rows: structuredClone(rows) });
      if (table === config.liveTableId) {
        for (const [index, row] of rows.entries()) {
          lives.push({ record_id: `recLiveNew000${index}`, fields: { ...row.fields } });
        }
        Object.assign(creators[0].fields, {
          "Renamed Creator Latest": NEW_LIVE_START,
          "Renamed Creator Days": 2,
          "Renamed Creator Hours": 2,
          "Renamed Creator Likes": 889,
        });
        return rows.map((_, index) => ({ record_id: `recLiveNew000${index}` }));
      }
      for (const [index, row] of rows.entries()) {
        metrics.push({
          record_id: `recMetricNew0${index}`,
          fields: { ...row.fields },
        });
      }
      return rows.map((_, index) => ({ record_id: `recMetricNew0${index}` }));
    },
  };
}

function fakeNoHistoryLarkClient() {
  const fields = fieldDefinitions();
  const creators = [{
    record_id: CREATOR_ID,
    fields: {
      "Renamed Account": { text: "@Synthetic.Creator" },
    },
  }];
  const lives = [];
  const metrics = [];
  const calls = [];
  const listCalls = [];
  return {
    calls,
    listCalls,
    listFields: async (_app, table) => {
      if (table === config.creatorTableId) return fields.creator;
      if (table === config.liveTableId) return fields.live;
      return fields.metric;
    },
    listRecords: async (_app, table, query = {}) => {
      listCalls.push({ table, query: structuredClone(query) });
      if (table === config.creatorTableId) return creators;
      return table === config.liveTableId ? lives : metrics;
    },
    batchCreate: async (_app, table, rows) => {
      calls.push({ table, rows: structuredClone(rows) });
      assert.equal(table, config.metricTableId);
      for (const [index, row] of rows.entries()) {
        metrics.push({
          record_id: `recMetricEmpty${index}`,
          fields: { ...row.fields },
        });
      }
      return rows.map((_, index) => ({ record_id: `recMetricEmpty${index}` }));
    },
  };
}

test("appends LIVE rows and verifies created metric records without polling flow fields", async () => {
  const client = fakeLarkClient();
  const manifest = await exportLiveHistoryTargets({ client, config, nowMs: NOW });
  assert.equal(manifest.rows[0].liveContext.knownEvents.length, 1);
  const prepared = await prepareLiveHistoryPlan({
    client,
    config,
    manifest,
    observations: observations(),
    nowMs: NOW,
  });
  client.listCalls.length = 0;
  const result = await applyLiveHistoryPlan({
    client,
    config,
    reviewedPlan: prepared.plan,
    apply: true,
    expectSha256: prepared.plan.planSha256,
    confirmLiveCreate: 1,
    confirmMetricCreate: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.verified, true);
  assert.equal(result.flowVerification, "not_run");
  assert.deepEqual(client.calls.map((call) => call.table), ["live-table", "metric-table"]);
  assert.deepEqual(client.listCalls.map((call) => call.table), [
    "creator-table",
    "creator-table",
    "live-table",
    "metric-table",
    "live-table",
    "creator-table",
    "metric-table",
  ]);
  assert.deepEqual(Object.keys(client.calls[1].rows[0].fields).sort(), [
    "Renamed Metric Creator",
    "Renamed Metric Fan Club",
    "Renamed Metric Time",
  ]);
});

test("creates and verifies a LIVE metric when a confirmed no-history creator has blank summaries", async () => {
  const client = fakeNoHistoryLarkClient();
  const noHistoryObservation = observations({
    fanClubCount: 12,
    liveScan: {
      mode: "baseline-full",
      stopReason: "no-history",
      knownMatchCount: 0,
    },
    lives: [],
  });
  const prepared = await prepareLiveHistoryPlan({
    client,
    config,
    manifest: targetManifest(),
    observations: noHistoryObservation,
    nowMs: NOW,
  });
  client.listCalls.length = 0;
  const result = await applyLiveHistoryPlan({
    client,
    config,
    reviewedPlan: prepared.plan,
    apply: true,
    expectSha256: prepared.plan.planSha256,
    confirmLiveCreate: 0,
    confirmMetricCreate: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.metricCreatedCount, 1);
  assert.equal(result.flowVerification, "not_run");
  assert.deepEqual(client.calls.map((call) => call.table), ["metric-table"]);
  assert.deepEqual(client.listCalls.map((call) => call.table), [
    "creator-table",
    "creator-table",
    "live-table",
    "metric-table",
    "metric-table",
  ]);
});

test("discovers a separate manual LIVE-history provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "live-history-source-test-"));
  try {
    const requestPath = path.join(directory, "request.json");
    const outputPath = path.join(directory, "observations.json");
    await writeFile(requestPath, JSON.stringify(targetManifest()), { encoding: "utf8", mode: 0o600 });
    const result = await resolveLiveHistorySource({
      providerRoot: repositoryRoot,
      request: requestPath,
      output: outputPath,
      unattended: false,
    });
    assert.equal(result.status, "instructions-required");
    assert.equal(result.providerPackage, "@fixture/live-history-instruction-source");
    assert.match(result.instructions, /normalized live-history observation/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
