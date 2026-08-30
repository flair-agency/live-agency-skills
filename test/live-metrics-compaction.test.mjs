import assert from "node:assert/strict";
import test from "node:test";

import { RETENTION_POLICY as PROFILE_RETENTION_POLICY } from "../skills/creator-profile-compaction/scripts/lark_profile_compact.mjs";
import {
  RETENTION_POLICY,
  applyPlan,
  buildCompactionPlan,
  calculateCompactionPlanSha256,
  inspectPlan,
  resolveFields,
} from "../skills/creator-live-metrics-compaction/scripts/lark_live_metrics_compact.mjs";

const NOW = Date.parse("2030-08-28T12:00:00+09:00");
const DAY_MS = 24 * 60 * 60 * 1000;
const fieldIds = {
  timestamp: "fld_timestamp",
  creator: "fld_creator",
  fanClub: "fld_fan_club",
  latestLiveAt: "fld_latest_live",
  liveDays30d: "fld_live_days",
  liveHours30d: "fld_live_hours",
  likes30d: "fld_likes",
};
const config = {
  appToken: "app",
  creatorTableId: "creators",
  tableId: "live-metrics",
  fieldIds,
  apiOrigin: "https://example.invalid",
};
const source = {
  app_token: "app",
  creator_table_id: "creators",
  table_id: "live-metrics",
  field_ids: fieldIds,
};

function fields(prefix = "") {
  return [
    { field_id: fieldIds.timestamp, field_name: `${prefix}timestamp`, type: 5 },
    {
      field_id: fieldIds.creator,
      field_name: `${prefix}creator`,
      type: 21,
      property: { table_id: config.creatorTableId, multiple: false },
    },
    { field_id: fieldIds.fanClub, field_name: `${prefix}fanClub`, type: 2 },
    { field_id: fieldIds.latestLiveAt, field_name: `${prefix}latestLive`, type: 5 },
    { field_id: fieldIds.liveDays30d, field_name: `${prefix}liveDays`, type: 2 },
    { field_id: fieldIds.liveHours30d, field_name: `${prefix}liveHours`, type: 2 },
    { field_id: fieldIds.likes30d, field_name: `${prefix}likes`, type: 2 },
  ];
}

function bindings(prefix = "") {
  return resolveFields(fields(prefix), fieldIds, config.creatorTableId);
}

function record(number, creatorId, ageDays, values = {}, prefix = "") {
  const value = (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback;
  return {
    record_id: `recMetric${String(number).padStart(6, "0")}`,
    fields: {
      [`${prefix}timestamp`]: NOW - ageDays * DAY_MS,
      [`${prefix}creator`]: [creatorId],
      [`${prefix}fanClub`]: value("fanClub", 100 + number),
      [`${prefix}latestLive`]: value("latestLive", NOW - (ageDays + 1) * DAY_MS),
      [`${prefix}liveDays`]: value("liveDays", 8),
      [`${prefix}liveHours`]: value("liveHours", 12.5),
      [`${prefix}likes`]: value("likes", 1000 + number),
    },
  };
}

test("uses exactly the creator-profile retention policy", () => {
  assert.deepEqual(RETENTION_POLICY, PROFILE_RETENTION_POLICY);
});

test("retains a separate metric representative when the latest bucket row is incomplete", () => {
  const rows = [
    record(1, "recCreator0001", 500),
    record(2, "recCreator0001", 60),
    record(3, "recCreator0001", 50, {
      fanClub: null,
      latestLive: null,
      liveDays: null,
      liveHours: null,
      likes: null,
    }),
    record(4, "recCreator0001", 1),
    record(5, "recCreator0001", 0),
  ];
  const result = buildCompactionPlan(rows, bindings(), source, NOW);
  const byId = new Map(result.items[0].records.map((item) => [item.record_id, item]));
  assert.equal(byId.get("recMetric000002").decision, "keep");
  assert.match(byId.get("recMetric000002").keep_reasons.join(" "), /fan-club/);
  assert.equal(byId.get("recMetric000003").decision, "keep");
  assert.equal(result.plan_sha256, calculateCompactionPlanSha256(result));
});

test("resolves renamed fields and blocks malformed metric values", async () => {
  const malformed = record(1, "recCreator0001", 100, {}, "renamed_");
  malformed.fields.renamed_liveHours = "not-a-number";
  const plan = buildCompactionPlan([malformed], bindings("renamed_"), source, NOW);
  assert.equal(plan.summary.malformed_count, 1);
  const client = {
    listFields: async () => fields("renamed_"),
    listRecords: async () => [malformed],
  };
  const report = await inspectPlan({ plan, config, client });
  assert.equal(report.status, "blocked");
});

test("deletes only approved metric rows and verifies every retained row", async () => {
  let rows = [
    record(1, "recCreator0001", 500),
    record(2, "recCreator0001", 450),
    record(3, "recCreator0001", 400),
    record(4, "recCreator0001", 0),
  ];
  const plan = buildCompactionPlan(rows, bindings(), source, NOW);
  const client = {
    listFields: async () => fields(),
    listRecords: async () => rows,
    batchDelete: async (_app, _table, ids) => {
      const deleting = new Set(ids);
      rows = rows.filter((row) => !deleting.has(row.record_id));
    },
  };
  const result = await applyPlan({
    plan,
    config,
    apply: true,
    expectSha256: plan.plan_sha256,
    confirmDelete: plan.summary.delete_candidate_count,
    client,
  });
  assert.equal(result.verified, true);
  assert.equal(result.deleted_count, plan.summary.delete_candidate_count);
});
