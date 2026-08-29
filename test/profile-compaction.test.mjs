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
  communityCount: "fld_community",
};
const config = { appToken: "app", tableId: "table", fieldIds, apiOrigin: "https://example.invalid" };
const source = { app_token: "app", table_id: "table", field_ids: fieldIds };

function fields(prefix = "") {
  return [
    { field_id: fieldIds.timestamp, field_name: `${prefix}timestamp`, type: 5 },
    { field_id: fieldIds.creator, field_name: `${prefix}creator`, type: 21 },
    { field_id: fieldIds.followerCount, field_name: `${prefix}followers`, type: 2 },
    { field_id: fieldIds.communityCount, field_name: `${prefix}community`, type: 2 },
  ];
}

function bindings(prefix = "") {
  return resolveFields(fields(prefix), fieldIds);
}

function record(number, creatorId, ageDays, follower = 100 + number, community = 10 + number, prefix = "") {
  return {
    record_id: `recProfile${String(number).padStart(4, "0")}`,
    fields: {
      [`${prefix}timestamp`]: NOW - ageDays * DAY_MS,
      [`${prefix}creator`]: [creatorId],
      [`${prefix}followers`]: follower,
      [`${prefix}community`]: community,
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
  const renamed = bindings("renamed_");
  const plan = buildCompactionPlan(
    Array.from({ length: 40 }, (_, index) => record(index + 1, "recCreator0001", index, undefined, undefined, "renamed_")),
    renamed,
    source,
    NOW,
  );
  assert.ok(plan.summary.delete_candidate_count > 0);
  assert.equal(plan.plan_sha256, calculateCompactionPlanSha256(plan));
});

test("keeps oldest, latest, all recent, and separate incomplete metric representatives", () => {
  const records = [
    record(1, "recCreator0001", 0, 200, 20),
    record(2, "recCreator0001", 10, 190, null),
    record(3, "recCreator0001", 11, null, 18),
    record(4, "recCreator0001", 20, 180, 17),
    record(5, "recCreator0001", 400, 100, 10),
  ];
  const plan = buildCompactionPlan(records, bindings(), source, NOW);
  const byId = new Map(plan.items[0].records.map((item) => [item.record_id, item]));
  assert.equal(byId.get("recProfile0001").decision, "keep");
  assert.equal(byId.get("recProfile0002").decision, "keep");
  assert.equal(byId.get("recProfile0003").decision, "keep");
  assert.equal(byId.get("recProfile0005").decision, "keep");
});

test("protects malformed records and blocks apply", async () => {
  const malformed = record(1, "recCreator0001", 50);
  malformed.fields.creator = [];
  const current = [malformed];
  const client = {
    listFields: async () => fields(),
    listRecords: async () => current,
  };
  const plan = buildCompactionPlan(current, bindings(), source, NOW);
  assert.equal(plan.summary.malformed_count, 1);
  assert.equal((await inspectPlan({ plan, config, client })).status, "blocked");
});

test("detects a stale plan before deletion", async () => {
  const current = Array.from({ length: 40 }, (_, index) => record(index + 1, "recCreator0001", index));
  const plan = buildCompactionPlan(current, bindings(), source, NOW);
  current.push(record(99, "recCreator0001", 2));
  const client = {
    listFields: async () => fields(),
    listRecords: async () => current,
  };
  const result = await inspectPlan({ plan, config, client });
  assert.equal(result.status, "blocked");
  assert.equal(result.stale_count, 1);
});

test("deletes only candidates after exact approval and verifies by rereading", async () => {
  let current = Array.from({ length: 40 }, (_, index) => record(index + 1, "recCreator0001", index));
  const plan = buildCompactionPlan(current, bindings(), source, NOW);
  const deleted = [];
  const client = {
    listFields: async () => fields(),
    listRecords: async () => current,
    batchDelete: async (_appToken, _tableId, ids) => {
      deleted.push(...ids);
      const deleting = new Set(ids);
      current = current.filter((item) => !deleting.has(item.record_id));
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
  assert.equal(deleted.length, plan.summary.delete_candidate_count);
});
