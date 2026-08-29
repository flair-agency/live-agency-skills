import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlan,
  buildArchiveReceipt,
  buildLiveCompactionPlan,
  buildRestoreArchive,
  calculateLiveCompactionPlanSha256,
  configurationSha256,
  resolveSchema,
  restoreArchive,
  retentionCutoffs,
  validateArchiveReceipt,
  validateRestoreArchive,
} from "../skills/creator-live-history-compaction/scripts/lark_live_history_compact.mjs";

const NOW = Date.parse("2030-08-28T21:00:00+09:00");
const DAY_MS = 24 * 60 * 60 * 1000;
const fieldIds = { start: "fld_start", end: "fld_end", creator: "fld_creator", likes: "fld_likes" };
const config = {
  appToken: "app",
  creatorTableId: "creators",
  tableId: "live",
  fieldIds,
  schemaExpectations: [],
  archiveDestination: { sharedDriveId: "drive", folderId: "folder", mimeType: "application/gzip" },
  apiOrigin: "https://example.invalid",
};

function fields(prefix = "") {
  return [
    { field_id: fieldIds.start, field_name: `${prefix}start`, type: 5, property: null },
    { field_id: fieldIds.end, field_name: `${prefix}end`, type: 5, property: null },
    {
      field_id: fieldIds.creator,
      field_name: `${prefix}creator`,
      type: 21,
      property: { table_id: config.creatorTableId, multiple: false },
    },
    { field_id: fieldIds.likes, field_name: `${prefix}likes`, type: 2, property: null },
  ];
}

function schema(prefix = "") {
  return resolveSchema(fields(prefix), config);
}

function source(prefix = "") {
  return { configuration_sha256: configurationSha256(config), live_schema_sha256: schema(prefix).schemaSha256 };
}

function record(number, creatorId, startMs, durationMinutes = 60, likes = 100, prefix = "") {
  return {
    record_id: `recLive${String(number).padStart(6, "0")}`,
    fields: {
      [`${prefix}creator`]: [creatorId],
      [`${prefix}start`]: startMs,
      [`${prefix}end`]: startMs + durationMinutes * 60 * 1000,
      [`${prefix}likes`]: likes,
    },
  };
}

function sample(prefix = "") {
  return [
    record(1, "recCreator0001", NOW - 100 * DAY_MS, 60, 100, prefix),
    record(2, "recCreator0001", NOW - 60 * DAY_MS, 75, 222, prefix),
    record(3, "recCreator0001", NOW - 40 * DAY_MS, 60, 150, prefix),
    record(4, "recCreator0001", NOW - 10 * DAY_MS, 60, 200, prefix),
    record(5, "recCreator0001", NOW, 60, 250, prefix),
  ];
}

function plan(records = sample(), prefix = "") {
  return buildLiveCompactionPlan(records, schema(prefix).bindings, source(prefix), NOW);
}

test("uses the start of the JST calendar day containing the 30-day cutoff", () => {
  const cutoffs = retentionCutoffs(NOW);
  assert.equal(cutoffs.safe_boundary_ms, Date.parse("2030-07-29T00:00:00+09:00"));
  assert.ok(cutoffs.safe_boundary_ms <= cutoffs.exact_cutoff_ms);
});

test("resolves renamed fields by IDs and keeps oldest, latest, and the rolling window", () => {
  const result = plan(sample("renamed_"), "renamed_");
  const byId = new Map(result.items[0].records.map((item) => [item.record_id, item]));
  assert.equal(byId.get("recLive000001").decision, "keep");
  assert.equal(byId.get("recLive000002").decision, "delete");
  assert.equal(byId.get("recLive000003").decision, "delete");
  assert.equal(byId.get("recLive000004").decision, "keep");
  assert.equal(result.plan_sha256, calculateLiveCompactionPlanSha256(result));
});

test("keeps the whole boundary day and protects data-quality warnings", () => {
  const cutoffs = retentionCutoffs(NOW);
  const warning = record(3, "recCreator0001", NOW - 40 * DAY_MS);
  warning.fields.end = warning.fields.start - 1;
  const result = plan([
    record(1, "recCreator0001", NOW - 100 * DAY_MS),
    record(2, "recCreator0001", cutoffs.safe_boundary_ms + 60 * 60 * 1000),
    warning,
    record(4, "recCreator0001", NOW),
  ]);
  const byId = new Map(result.items[0].records.map((item) => [item.record_id, item]));
  assert.equal(byId.get("recLive000002").decision, "keep");
  assert.deepEqual(byId.get("recLive000003").data_quality_warnings, ["end_before_start"]);
  assert.equal(byId.get("recLive000003").decision, "keep");
  assert.equal(result.summary.metric_preservation_violation_count, 0);
});

test("a non-unique creator link blocks deletion", () => {
  const malformed = record(1, "recCreator0001", NOW - 100 * DAY_MS);
  malformed.fields.creator = [];
  const result = plan([malformed]);
  assert.equal(result.summary.blocking_malformed_count, 1);
  assert.equal(result.summary.delete_candidate_count, 0);
});

test("archive uses semantic values and a verified receipt is bound to destination", () => {
  const currentPlan = plan();
  const archive = buildRestoreArchive(currentPlan, config, NOW + 1000);
  assert.equal(archive.records.length, 2);
  assert.deepEqual(Object.keys(archive.records[0].values).sort(), ["creator_record_id", "end_ms", "like_count", "start_ms"]);
  assert.doesNotThrow(() => validateRestoreArchive(archive, config));
  const fileSha = "a".repeat(64);
  const receipt = buildArchiveReceipt(archive, config, {
    file_id: "ArchiveFileIdentifier",
    folder_id: config.archiveDestination.folderId,
    file_name: archive.file_name,
    file_url: "https://example.invalid/archive",
    file_sha256: fileSha,
  }, NOW + 2000);
  assert.doesNotThrow(() => validateArchiveReceipt(receipt, currentPlan, config, fileSha));
});

test("deletes only approved candidates and verifies every keep record", async () => {
  let live = sample();
  const currentPlan = plan(live);
  const archive = buildRestoreArchive(currentPlan, config, NOW + 1000);
  const receipt = buildArchiveReceipt(archive, config, {
    file_id: "ArchiveFileIdentifier",
    folder_id: config.archiveDestination.folderId,
    file_name: archive.file_name,
    file_url: "https://example.invalid/archive",
    file_sha256: "a".repeat(64),
  }, NOW + 2000);
  const client = {
    listFields: async () => fields(),
    listRecords: async (_app, table) => table === config.tableId ? live : [{ record_id: "recCreator0001" }],
    batchDelete: async (_app, _table, ids) => {
      const deleting = new Set(ids);
      live = live.filter((item) => !deleting.has(item.record_id));
    },
  };
  const result = await applyPlan({
    plan: currentPlan,
    receipt,
    config,
    apply: true,
    expectSha256: currentPlan.plan_sha256,
    confirmDelete: currentPlan.summary.delete_candidate_count,
    client,
  });
  assert.equal(result.verified, true);
  assert.equal(result.deleted_count, 2);
});

test("restores missing archived sessions with current renamed field names", async () => {
  const currentPlan = plan();
  const archive = buildRestoreArchive(currentPlan, config, NOW + 1000);
  let live = sample("renamed_").filter((item) => !new Set(archive.records.map((record) => record.original_record_id)).has(item.record_id));
  let next = 100;
  const client = {
    listFields: async () => fields("renamed_"),
    listRecords: async (_app, table) => table === config.tableId ? live : [{ record_id: "recCreator0001" }],
    batchCreate: async (_app, _table, records) => {
      live.push(...records.map((item) => ({ ...item, record_id: `recRestored${next++}` })));
      return records;
    },
  };
  const result = await restoreArchive({
    archive,
    config,
    apply: true,
    expectArchiveSha256: archive.archive_sha256,
    confirmRestore: archive.records.length,
    client,
  });
  assert.equal(result.verified, true);
  assert.equal(result.created_count, 2);
});
