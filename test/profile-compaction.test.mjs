import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlan,
  buildCompactionPlan,
  calculateCompactionPlanSha256,
  inspectPlan,
  resolveFields,
  retentionBucket,
} from "../skills/creator-profile-compaction/scripts/lark_profile_compact.mjs";

const NOW = Date.parse("2030-08-28T12:00:00+09:00");
const DAY_MS = 24 * 60 * 60 * 1000;
const fieldIds = {
  timestamp: "fld_timestamp",
  creator: "fld_creator",
  followerCount: "fld_follower",
  recentPostCount30d: "fld_recent_posts",
  latestPostAt: "fld_latest_post",
  nickname: "fld_nickname",
  avatar: "fld_avatar",
  featureObservationData: "fld_feature_data",
};
const config = {
  appToken: "app",
  creatorTableId: "creators",
  tableId: "profiles",
  fieldIds,
  apiOrigin: "https://example.invalid",
};
const source = {
  app_token: "app",
  creator_table_id: "creators",
  table_id: "profiles",
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
    { field_id: fieldIds.followerCount, field_name: `${prefix}followers`, type: 2 },
    { field_id: fieldIds.recentPostCount30d, field_name: `${prefix}recentPosts`, type: 2 },
    { field_id: fieldIds.latestPostAt, field_name: `${prefix}latestPost`, type: 5 },
    { field_id: fieldIds.nickname, field_name: `${prefix}nickname`, type: 1 },
    { field_id: fieldIds.avatar, field_name: `${prefix}avatar`, type: 17 },
    { field_id: fieldIds.featureObservationData, field_name: `${prefix}featureData`, type: 1 },
  ];
}

function bindings(prefix = "") {
  return resolveFields(fields(prefix), fieldIds, config.creatorTableId);
}

function record(number, creatorId, ageDays, values = {}, prefix = "") {
  const value = (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback;
  return {
    record_id: `recProfile${String(number).padStart(5, "0")}`,
    fields: {
      [`${prefix}timestamp`]: NOW - ageDays * DAY_MS,
      [`${prefix}creator`]: [creatorId],
      [`${prefix}followers`]: value("follower", 100 + number),
      [`${prefix}recentPosts`]: value("recentPosts", 5),
      [`${prefix}latestPost`]: value("latestPost", NOW - (ageDays + 1) * DAY_MS),
      [`${prefix}nickname`]: value("nickname", "Synthetic Creator"),
      [`${prefix}avatar`]: value("avatar", [{ file_token: `token${number}` }]),
      [`${prefix}featureData`]: value("featureData", JSON.stringify({ schema_version: 1 })),
    },
  };
}

test("classifies retention tiers at exact boundaries", () => {
  assert.equal(retentionBucket(NOW - 6 * DAY_MS, NOW).tier, "recent");
  assert.equal(retentionBucket(NOW - 7 * DAY_MS, NOW).tier, "weekly");
  assert.equal(retentionBucket(NOW - 30 * DAY_MS, NOW).tier, "monthly");
  assert.equal(retentionBucket(NOW - 365 * DAY_MS, NOW).tier, "yearly");
});

test("uses stable field IDs after every display name is renamed", () => {
  const result = buildCompactionPlan([
    record(1, "recCreator0001", 400, {}, "renamed_"),
    record(2, "recCreator0001", 350, {}, "renamed_"),
    record(3, "recCreator0001", 1, {}, "renamed_"),
  ], bindings("renamed_"), source, NOW);
  assert.equal(result.summary.profile_record_count, 3);
  assert.equal(result.plan_sha256, calculateCompactionPlanSha256(result));
});

test("keeps oldest, latest, all recent, and separate incomplete metric representatives", () => {
  const rows = [
    record(1, "recCreator0001", 500),
    record(2, "recCreator0001", 60, {
      follower: null,
      recentPosts: null,
      latestPost: null,
      nickname: null,
      avatar: [],
      featureData: null,
    }),
    record(3, "recCreator0001", 50),
    record(4, "recCreator0001", 1),
    record(5, "recCreator0001", 0),
  ];
  const result = buildCompactionPlan(rows, bindings(), source, NOW);
  const byId = new Map(result.items[0].records.map((item) => [item.record_id, item]));
  assert.equal(byId.get("recProfile00001").decision, "keep");
  assert.equal(byId.get("recProfile00003").decision, "keep");
  assert.match(byId.get("recProfile00003").keep_reasons.join(" "), /feature-observation/);
  assert.equal(byId.get("recProfile00004").decision, "keep");
  assert.equal(byId.get("recProfile00005").decision, "keep");
});

test("protects malformed feature JSON and blocks apply", async () => {
  const malformed = record(1, "recCreator0001", 100);
  malformed.fields.featureData = "not-json";
  const plan = buildCompactionPlan([malformed], bindings(), source, NOW);
  assert.equal(plan.summary.malformed_count, 1);
  const client = {
    listFields: async () => fields(),
    listRecords: async () => [malformed],
  };
  const report = await inspectPlan({ plan, config, client });
  assert.equal(report.status, "blocked");
});

test("detects a stale plan before deletion", async () => {
  let rows = [
    record(1, "recCreator0001", 500),
    record(2, "recCreator0001", 400),
    record(3, "recCreator0001", 0),
  ];
  const plan = buildCompactionPlan(rows, bindings(), source, NOW);
  rows = [...rows, record(4, "recCreator0001", 1)];
  const client = { listFields: async () => fields(), listRecords: async () => rows };
  const report = await inspectPlan({ plan, config, client });
  assert.equal(report.status, "blocked");
  assert.equal(report.stale_count, 1);
});

test("deletes only candidates after exact approval and verifies by rereading", async () => {
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
