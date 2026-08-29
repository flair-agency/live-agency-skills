import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateGiftHistorySnapshot } from "@live-agency-skills/source-provider-api";

import {
  buildGiftHistoryPlan,
  giftPlanIsBlocked,
  replayGiftHistoryPlan,
  validateGiftHistoryPlan,
} from "../skills/gift-history-sync/scripts/gift_history_core.mjs";
import {
  buildProjectionPlan,
  buildProjectionTarget,
  projectionPayload,
  resolveProjectionFields,
  validateProjectionConfig,
} from "../skills/gift-history-sync/scripts/gift_projection_core.mjs";
import { resolveGiftSource } from "../skills/gift-history-sync/scripts/resolve_gift_source.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const NOW = Date.parse("2030-01-03T03:04:05.000Z");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function event(overrides = {}) {
  return {
    eventKey: "event-0001",
    accountKey: "synthetic.sender",
    occurredAt: "2030-01-01T12:00:00.000Z",
    amount: "100",
    recipientKey: "recipient.old",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const events = overrides.events ?? [event({ recipientKey: "recipient.new" })];
  return {
    version: 1,
    snapshotDate: overrides.snapshotDate ?? "2030-01-02",
    observedAt: "2030-01-02T03:04:05.000Z",
    accountKey: "synthetic.sender",
    sourceSha256: overrides.sourceSha256 ?? digest("new-source"),
    rowCount: events.length,
    events,
  };
}

function master(overrides = {}) {
  return {
    version: 1,
    events: overrides.events ?? [event()],
    syncLog: overrides.syncLog ?? [{
      accountKey: "synthetic.sender",
      snapshotDate: "2030-01-01",
      sourceSha256: digest("old-source"),
      status: "success",
    }],
  };
}

test("validates canonical gift snapshots and rejects duplicate or unordered events", () => {
  assert.equal(validateGiftHistorySnapshot(snapshot()).rowCount, 1);
  assert.throws(
    () => validateGiftHistorySnapshot(snapshot({ events: [event(), event()] })),
    /eventKey is duplicated/,
  );
  assert.throws(
    () => validateGiftHistorySnapshot(snapshot({ events: [
      event({ eventKey: "event-0002", occurredAt: "2030-01-02T00:00:00.000Z" }),
      event({ eventKey: "event-0001", occurredAt: "2030-01-01T00:00:00.000Z" }),
    ] })),
    /not strictly ordered/,
  );
});

test("newer snapshots preserve omitted events and update common recipient evidence", () => {
  const plan = buildGiftHistoryPlan({
    master: master({ events: [
      event(),
      event({
        eventKey: "master-only",
        occurredAt: "2029-12-31T12:00:00.000Z",
        amount: "25",
        recipientKey: "recipient.historical",
      }),
    ] }),
    snapshot: snapshot({ events: [
      event({ recipientKey: "recipient.new" }),
      event({
        eventKey: "source-only",
        occurredAt: "2030-01-02T01:00:00.000Z",
        amount: "75",
        recipientKey: "recipient.added",
      }),
    ] }),
    nowMs: NOW,
  });
  assert.equal(plan.mode, "newer");
  assert.equal(plan.summary.additionCount, 1);
  assert.equal(plan.summary.recipientUpdateCount, 1);
  assert.equal(plan.summary.retainedMasterOnlyCount, 1);
  assert.equal(plan.summary.targetRowCount, 3);
  assert.equal(plan.summary.targetAmount, "200");
  assert.equal(plan.evidence.usernameChanges[0].currentEvidence, true);
  assert.equal(giftPlanIsBlocked(plan), false);
  validateGiftHistoryPlan(plan);
});

test("older snapshots add unknown keys without rolling recipient evidence backward", () => {
  const plan = buildGiftHistoryPlan({
    master: master({
      events: [event({ recipientKey: "recipient.current" })],
      syncLog: [{
        accountKey: "synthetic.sender",
        snapshotDate: "2030-01-05",
        sourceSha256: digest("latest"),
        status: "success",
      }],
    }),
    snapshot: snapshot({
      snapshotDate: "2030-01-02",
      events: [
        event({
          eventKey: "backfill-only",
          occurredAt: "2029-12-30T12:00:00.000Z",
          amount: "10",
        }),
        event({ recipientKey: "recipient.old" }),
      ],
    }),
    nowMs: NOW,
  });
  assert.equal(plan.mode, "backfill");
  assert.equal(plan.summary.additionCount, 1);
  assert.equal(plan.summary.recipientUpdateCount, 0);
  assert.equal(plan.evidence.usernameChanges[0].currentEvidence, false);
  assert.equal(plan.target.events.find((item) => item.eventKey === "event-0001").recipientKey, "recipient.current");
});

test("same-date digests are idempotent and changed source files fail closed", () => {
  const sourceSha256 = digest("same");
  const log = [{
    accountKey: "synthetic.sender",
    snapshotDate: "2030-01-02",
    sourceSha256,
    status: "success",
  }];
  const unchanged = buildGiftHistoryPlan({
    master: master({ syncLog: log }),
    snapshot: snapshot({ sourceSha256 }),
    nowMs: NOW,
  });
  assert.equal(unchanged.mode, "unchanged");
  assert.equal(unchanged.summary.additionCount, 0);

  const conflict = buildGiftHistoryPlan({
    master: master({ syncLog: log }),
    snapshot: snapshot({ sourceSha256: digest("different") }),
    nowMs: NOW,
  });
  assert.equal(conflict.mode, "same-date-conflict");
  assert.equal(giftPlanIsBlocked(conflict), true);

  const replacement = buildGiftHistoryPlan({
    master: master({ syncLog: log }),
    snapshot: snapshot({ sourceSha256: digest("different") }),
    allowSameDateReplacement: true,
    nowMs: NOW,
  });
  assert.equal(replacement.mode, "same-date-replacement");
  assert.equal(replacement.summary.recipientUpdateCount, 1);
});

test("reused keys with changed immutable event data block the plan", () => {
  const plan = buildGiftHistoryPlan({
    master: master(),
    snapshot: snapshot({ events: [event({ amount: "999" })] }),
    nowMs: NOW,
  });
  assert.equal(plan.operations.blockingIssues[0].reason, "incompatible_event_key_reuse");
  assert.equal(giftPlanIsBlocked(plan), true);
});

test("replaying against a changed master detects a stale reviewed plan", () => {
  const reviewed = buildGiftHistoryPlan({ master: master(), snapshot: snapshot(), nowMs: NOW });
  const replayed = replayGiftHistoryPlan({
    master: master({ events: [event(), event({
      eventKey: "concurrent-event",
      occurredAt: "2030-01-01T13:00:00.000Z",
      amount: "5",
    })] }),
    reviewedPlan: reviewed,
  });
  assert.notEqual(replayed.planSha256, reviewed.planSha256);
});

test("discovers and executes a normalized gift source through npm", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gift-source-test-"));
  try {
    const requestPath = path.join(directory, "request.json");
    const outputPath = path.join(directory, "snapshot.json");
    await writeFile(requestPath, JSON.stringify({
      inputKind: "application/x.synthetic-gift-history-request+json",
      accountKey: "synthetic.sender",
      snapshotDate: "2030-01-02",
    }), { encoding: "utf8", mode: 0o600 });
    const result = await resolveGiftSource({
      providerRoot: repositoryRoot,
      request: requestPath,
      output: outputPath,
      unattended: true,
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.status, "normalized");
    assert.equal(output.rowCount, 1);
    assert.equal(output.events[0].eventKey, "synthetic-event-0001");
    assert.equal((await stat(outputPath)).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function projectionConfig() {
  return validateProjectionConfig({
    version: 1,
    spreadsheet: { spreadsheetId: "synthetic-sheet" },
    lark: {
      accountProjection: {
        appToken: "synthetic-app",
        tableId: "synthetic-table",
        sourceSheetId: 42,
        backupDir: "/private/tmp/synthetic-backup",
        fieldIds: {
          recipient: "fldRecipient",
          account: "fldAccount",
          development: "fldDevelopment",
          relationship: "fldRelationship",
          scouting: "fldScouting",
        },
        keyFields: ["recipient", "account"],
        amountFields: ["development", "relationship", "scouting"],
        fieldTypes: {
          recipient: { uiType: "Text", stripLeadingAt: true },
          account: { uiType: "SingleSelect" },
          development: { uiType: "Number", minimum: 0 },
          relationship: { uiType: "Number", minimum: 0 },
          scouting: { uiType: "Number", minimum: 0 },
        },
      },
    },
  }, "accountProjection");
}

function projectionFields(prefix = "Renamed ") {
  return [
    { field_id: "fldRecipient", field_name: `${prefix}Recipient`, ui_type: "Text" },
    {
      field_id: "fldAccount",
      field_name: `${prefix}Account`,
      ui_type: "SingleSelect",
      property: { options: [{ name: "synthetic.sender" }] },
    },
    { field_id: "fldDevelopment", field_name: `${prefix}Development`, ui_type: "Number" },
    { field_id: "fldRelationship", field_name: `${prefix}Relationship`, ui_type: "Number" },
    { field_id: "fldScouting", field_name: `${prefix}Scouting`, ui_type: "Number" },
  ];
}

test("gift projections resolve renamed Lark fields strictly by stable IDs", () => {
  const config = projectionConfig();
  const bindings = resolveProjectionFields(projectionFields(), config);
  const target = buildProjectionTarget({ config, rows: [
    {
      recipient: "@synthetic.creator",
      account: "synthetic.sender",
      development: 10,
      relationship: 20,
      scouting: 30,
    },
    {
      recipient: "synthetic.new",
      account: "synthetic.sender",
      development: 1,
      relationship: 2,
      scouting: 3,
    },
  ] });
  const records = [
    {
      record_id: "rec-update",
      fields: {
        "Renamed Recipient": "synthetic.creator",
        "Renamed Account": "synthetic.sender",
        "Renamed Development": 9,
        "Renamed Relationship": 20,
        "Renamed Scouting": 30,
      },
    },
    {
      record_id: "rec-delete",
      fields: {
        "Renamed Recipient": "synthetic.old",
        "Renamed Account": "synthetic.sender",
        "Renamed Development": 1,
        "Renamed Relationship": 1,
        "Renamed Scouting": 1,
      },
    },
  ];
  const plan = buildProjectionPlan({ target, records, bindings, config });
  assert.equal(plan.summary.createCount, 1);
  assert.equal(plan.summary.updateCount, 1);
  assert.equal(plan.summary.deleteCount, 1);
  assert.deepEqual(
    projectionPayload(plan.operations.creates[0], bindings, config, { includeKeys: true }),
    {
      "Renamed Recipient": "synthetic.new",
      "Renamed Account": "synthetic.sender",
      "Renamed Development": 1,
      "Renamed Relationship": 2,
      "Renamed Scouting": 3,
    },
  );
});

test("gift projections fail closed on field drift, select drift, and duplicate keys", () => {
  const config = projectionConfig();
  assert.throws(
    () => resolveProjectionFields(
      projectionFields().map((field) => field.field_id === "fldScouting" ? { ...field, ui_type: "Text" } : field),
      config,
    ),
    /field type changed/,
  );
  const bindings = resolveProjectionFields(projectionFields(), config);
  const badOptionTarget = buildProjectionTarget({ config, rows: [{
    recipient: "synthetic.creator",
    account: "missing.option",
    development: 1,
    relationship: 2,
    scouting: 3,
  }] });
  assert.throws(
    () => buildProjectionPlan({ target: badOptionTarget, records: [], bindings, config }),
    /select option is missing/,
  );
  assert.throws(
    () => buildProjectionTarget({ config, rows: [
      { recipient: "@same", account: "synthetic.sender", development: 1 },
      { recipient: "same", account: "synthetic.sender", development: 2 },
    ] }),
    /duplicate composite key/,
  );
});
