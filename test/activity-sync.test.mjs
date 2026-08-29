import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ReconciliationError,
  buildPlan,
  normalizeSnapshot,
  resolveFields,
  runSync,
} from "../skills/creator-activity-sync/scripts/lark_activity_sync.mjs";
import { resolveActivitySource } from "../skills/creator-activity-sync/scripts/resolve_activity_source.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const fieldIds = {
  month: "fld_month",
  account: "fld_account",
  diamonds: "fld_diamonds",
  effectiveLiveDays: "fld_days",
  liveMinutes: "fld_minutes",
};

function fields(prefix = "") {
  return [
    { field_id: fieldIds.month, field_name: `${prefix}month`, type: 20 },
    { field_id: fieldIds.account, field_name: `${prefix}account`, type: 20 },
    { field_id: fieldIds.diamonds, field_name: `${prefix}diamonds`, type: 2 },
    { field_id: fieldIds.effectiveLiveDays, field_name: `${prefix}days`, type: 2 },
    { field_id: fieldIds.liveMinutes, field_name: `${prefix}minutes`, type: 2 },
  ];
}

function snapshot() {
  return normalizeSnapshot({
    month: "2030-01",
    sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
    rowCount: 1,
    creators: [
      { accountKey: "@Synthetic.Creator", diamonds: 100, effectiveLiveDays: 2, liveMinutes: 90 },
    ],
  });
}

test("normalizes identity and rejects post-normalization duplicates", () => {
  assert.equal(snapshot().creators[0].accountKey, "synthetic.creator");
  assert.throws(
    () =>
      normalizeSnapshot({
        month: "2030-01",
        sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
        rowCount: 2,
        creators: [
          { accountKey: "Same", diamonds: 1, effectiveLiveDays: 1, liveMinutes: 1 },
          { accountKey: "@same", diamonds: 2, effectiveLiveDays: 2, liveMinutes: 2 },
        ],
      }),
    /duplicated after normalization/,
  );
});

test("resolves renamed fields strictly by stable IDs", () => {
  const bindings = resolveFields(fields("renamed_"), fieldIds);
  const plan = buildPlan(
    [
      {
        record_id: "rec1",
        fields: {
          renamed_month: "2030/01/01",
          renamed_account: [{ text: "synthetic.creator" }],
          renamed_diamonds: 80,
          renamed_days: 1,
          renamed_minutes: 60,
        },
      },
    ],
    snapshot(),
    bindings,
  );
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.updates[0].fields, {
    renamed_diamonds: 100,
    renamed_days: 2,
    renamed_minutes: 90,
  });
});

test("rejects a duplicate monthly destination match", () => {
  const bindings = resolveFields(fields(), fieldIds);
  const record = {
    fields: { month: "2030/01/01", account: "synthetic.creator" },
  };
  const plan = buildPlan(
    [
      { ...record, record_id: "rec1" },
      { ...record, record_id: "rec2" },
    ],
    snapshot(),
    bindings,
  );
  assert.equal(plan.updates.length, 0);
  assert.match(plan.errors[0], /multiple destination records/);
});

test("requires numeric metric destinations", () => {
  const wrong = fields();
  wrong.find((field) => field.field_id === fieldIds.liveMinutes).type = 20;
  assert.throws(() => resolveFields(wrong, fieldIds), ReconciliationError);
});

test("applies only the three metric fields and verifies by rereading", async () => {
  const current = {
    record_id: "rec1",
    fields: { month: "2030/01/01", account: "synthetic.creator", diamonds: 80, days: 1, minutes: 60 },
  };
  const calls = [];
  const client = {
    listFields: async () => fields(),
    listRecords: async () => [current],
    batchUpdate: async (_appToken, _tableId, updates) => {
      calls.push(updates);
      Object.assign(current.fields, updates[0].fields);
    },
  };
  const result = await runSync({
    snapshot: snapshot(),
    config: { appToken: "app", tableId: "table", fieldIds, apiOrigin: "https://example.invalid" },
    apply: true,
    client,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(Object.keys(calls[0][0].fields).sort(), ["days", "diamonds", "minutes"]);
});

test("resolves a raw request through npm and writes a normalized private output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "activity-source-test-"));
  try {
    const requestPath = path.join(directory, "request.json");
    const outputPath = path.join(directory, "normalized.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        inputKind: "text/markdown",
        month: "2030-01",
        sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
        text: "synthetic input",
      }),
      "utf8",
    );
    const result = await resolveActivitySource({
      providerRoot: repositoryRoot,
      request: requestPath,
      output: outputPath,
      unattended: false,
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.snapshot.rowCount, 1);
    assert.equal(output.creators[0].accountKey, "synthetic_creator");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
