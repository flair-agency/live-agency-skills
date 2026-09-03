import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRetentionPlan,
  calculateBackupReceiptSha256,
  calculateRetentionPlanSha256,
} from "../skills/lark-base-backup-retention/scripts/retention_plan.mjs";

const OBSERVED_AT = "2030-04-15T12:00:00.000Z";

function receipt(index, overrides = {}) {
  const core = {
    version: 1,
    status: "verified",
    base_alias: "creator-scouting",
    schema_sha256: "a".repeat(64),
    backup_class: "daily",
    period_key: "2030-04-15",
    artifact_kind: "full-base-export",
    acquisition_route: "browser-full-base-export",
    restore_scope: "full-base",
    artifact_bytes: 1000 + index,
    artifact_sha256: index.toString(16).padStart(64, "0"),
    completed_at: `${overrides.period_key ?? "2030-04-15"}T01:00:00.000Z`,
    verified_at: `${overrides.period_key ?? "2030-04-15"}T01:01:00.000Z`,
    ...overrides,
  };
  return { ...core, receipt_sha256: calculateBackupReceiptSha256(core) };
}

function pair(index, overrides = {}) {
  const normalizedReceipt = overrides.receipt ?? receipt(index, overrides.receipt_overrides);
  return {
    artifact_object_ref: `artifact-${index}`,
    receipt_object_ref: `receipt-${index}`,
    artifact_bytes: normalizedReceipt.artifact_bytes,
    receipt_bytes: 400 + index,
    pre_change_released: false,
    successful_drill_referenced: false,
    receipt: normalizedReceipt,
    ...overrides,
    receipt_overrides: undefined,
  };
}

function state(overrides = {}) {
  return {
    version: 1,
    observed_at: OBSERVED_AT,
    timezone: "Asia/Tokyo",
    base_alias: "creator-scouting",
    successful_drill_references_complete: true,
    policy: {
      daily_days: 35,
      monthly_months: 24,
      protect_pre_change_until_released: true,
      protect_last_verified: true,
      protect_successful_drill_sources: true,
    },
    verified_pairs: [],
    orphans: [],
    invalid_receipts: [],
    ...overrides,
  };
}

test("retains recent daily backups and the newest monthly representative", () => {
  const plan = buildRetentionPlan(state({
    verified_pairs: [
      pair(1),
      pair(2, { receipt: receipt(2, { period_key: "2030-03-31" }) }),
      pair(3, { receipt: receipt(3, { period_key: "2030-03-01" }) }),
      pair(4, { receipt: receipt(4, { period_key: "2029-12-01" }) }),
      pair(5, { receipt: receipt(5, { period_key: "2028-01-01" }) }),
    ],
  }));

  assert.deepEqual(plan.keep.map((item) => item.period_key), ["2030-04-15", "2030-03-31", "2029-12-01"]);
  assert.deepEqual(plan.delete_candidates.map((item) => item.period_key), ["2030-03-01", "2028-01-01"]);
  assert.equal(plan.summary.keep_pair_count, 3);
  assert.equal(plan.summary.delete_pair_count, 2);
  assert.equal(plan.summary.delete_object_count, 4);
  assert.equal(plan.summary.ready_for_review, true);
  assert.equal(plan.summary.unattended_delete_count, 0);
  assert.equal(plan.plan_sha256, calculateRetentionPlanSha256(plan));
});

test("selects the latest period in a month even when an older period is verified later", () => {
  const plan = buildRetentionPlan(state({
    policy: { ...state().policy, daily_days: 1 },
    verified_pairs: [
      pair(1),
      pair(2, { receipt: receipt(2, { period_key: "2030-03-31" }) }),
      pair(3, { receipt: receipt(3, {
        period_key: "2030-03-01",
        completed_at: "2030-04-01T02:00:00.000Z",
        verified_at: "2030-04-01T02:01:00.000Z",
      }) }),
    ],
  }));

  assert(plan.keep.some((item) => item.period_key === "2030-03-31" && item.reasons.includes("monthly-representative")));
  assert(plan.delete_candidates.some((item) => item.period_key === "2030-03-01"));
});

test("protects unreleased pre-change backups and successful drill sources", () => {
  const preChangeReceipt = receipt(6, {
    backup_class: "pre-change",
    period_key: "2027-01-01",
  });
  const drillSourceReceipt = receipt(7, { period_key: "2027-02-01" });
  const plan = buildRetentionPlan(state({
    verified_pairs: [
      pair(1),
      pair(6, { receipt: preChangeReceipt, pre_change_released: false }),
      pair(7, { receipt: drillSourceReceipt, successful_drill_referenced: true }),
    ],
  }));

  const reasons = Object.fromEntries(plan.keep.map((item) => [item.period_key, item.reasons]));
  assert(reasons["2027-01-01"].includes("protected-pre-change"));
  assert(reasons["2027-02-01"].includes("successful-drill-source"));
  assert.equal(plan.summary.protected_pair_count, 1);
  assert.equal(plan.summary.drill_referenced_count, 1);
  assert.equal(plan.summary.delete_pair_count, 0);
});

test("reports orphaned and invalid objects as blockers without deleting them", () => {
  const plan = buildRetentionPlan(state({
    verified_pairs: [
      pair(1),
      pair(8, { receipt: receipt(8, { period_key: "2027-01-01" }) }),
    ],
    orphans: [{ object_ref: "orphan-artifact", bytes: 123, kind: "artifact" }],
    invalid_receipts: [{ object_ref: "invalid-receipt", bytes: 45, kind: "receipt" }],
  }));

  assert.equal(plan.summary.delete_pair_count, 1);
  assert.equal(plan.summary.blocking_count, 2);
  assert.equal(plan.summary.ready_for_review, false);
  assert.equal(plan.delete_candidates.some((item) => item.artifact_object_ref === "orphan-artifact"), false);
  assert.deepEqual(plan.blocking_issues.map((item) => item.code), ["orphan-object", "invalid-receipt"]);
});

test("rejects duplicated storage references and unsafe retention policy", () => {
  assert.throws(
    () => buildRetentionPlan(state({
      verified_pairs: [pair(1), pair(2, { artifact_object_ref: "artifact-1" })],
    })),
    /duplicated/,
  );
  assert.throws(
    () => buildRetentionPlan(state({
      policy: {
        ...state().policy,
        protect_successful_drill_sources: false,
      },
    })),
    /must protect successful recovery-drill sources/,
  );
});

test("an empty verified set is a blocking state", () => {
  const plan = buildRetentionPlan(state());
  assert.equal(plan.summary.verified_pair_count, 0);
  assert.equal(plan.summary.blocking_count, 1);
  assert.equal(plan.summary.ready_for_review, false);
  assert.equal(plan.blocking_issues[0].code, "no-verified-backup");
});

test("requires complete successful-drill reference coverage", () => {
  assert.throws(
    () => buildRetentionPlan(state({ successful_drill_references_complete: false })),
    /reference coverage must be complete/,
  );
});
