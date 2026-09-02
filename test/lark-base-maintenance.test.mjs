import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMaintenancePlan,
  calculateMaintenancePlanSha256,
} from "../skills/lark-base-maintenance/scripts/maintenance_plan.mjs";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function receipt(overrides = {}) {
  return {
    version: 1,
    status: "verified",
    base_alias: "creator-scouting",
    schema_sha256: SHA_A,
    backup_class: "daily",
    period_key: "2026-09-03",
    artifact_kind: "full-base-export",
    restore_scope: "full-base",
    artifact_bytes: 100,
    artifact_sha256: SHA_B,
    completed_at: "2026-09-03T00:00:00.000Z",
    verified_at: "2026-09-03T00:01:00.000Z",
    receipt_sha256: SHA_C,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    version: 1,
    observed_at: new Date(NOW + 2 * 60 * 1000).toISOString(),
    timezone: "Asia/Tokyo",
    base: { alias: "creator-scouting", schema_sha256: SHA_A },
    policy: {
      backup_max_age_hours: 36,
      compaction_interval_days: 7,
      retention_interval_days: 30,
      recovery_drill_interval_days: 183,
      warning_ratio: 0.75,
      critical_ratio: 0.9,
    },
    backup_receipts: [receipt()],
    tables: [
      {
        alias: "profile-history",
        record_count: 7000,
        record_limit: 10000,
        compaction: {
          skill: "creator-profile-compaction",
          status: "unchanged",
          last_dry_run_at: "2026-09-02T00:00:00.000Z",
        },
      },
    ],
    retention: { last_planned_at: "2026-09-02T00:00:00.000Z" },
    recovery_drill: { last_successful_at: "2026-09-02T00:00:00.000Z" },
    ...overrides,
  };
}

test("keeps a healthy current run mutation-free", () => {
  const plan = buildMaintenancePlan(state());
  assert.equal(plan.backup.fresh, true);
  assert.equal(plan.tables[0].capacity_status, "healthy");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.summary.unattended_mutation_count, 0);
  assert.equal(plan.plan_sha256, calculateMaintenancePlanSha256(plan));
});

test("requests backup and compaction dry run without proposing deletion", () => {
  const plan = buildMaintenancePlan(state({
    backup_receipts: [],
    tables: [{
      alias: "profile-history",
      record_count: 9500,
      record_limit: 10000,
      compaction: {
        skill: "creator-profile-compaction",
        status: "not-run",
        last_dry_run_at: null,
      },
    }],
    retention: { last_planned_at: null },
    recovery_drill: { last_successful_at: null },
  }));
  assert.equal(plan.tables[0].capacity_status, "critical");
  assert.deepEqual(plan.actions.map((action) => action.action), [
    "check-or-create-backup",
    "run-compaction-dry-run",
    "run-retention-dry-run",
    "run-recovery-drill-preflight",
  ]);
  assert.equal(plan.actions.some((action) => /delete|restore/.test(action.action)), false);
  assert.equal(plan.summary.unattended_mutation_count, 0);
});

test("accepts equivalent distributed backups and counts them", () => {
  const duplicate = receipt({ receipt_sha256: "d".repeat(64), verified_at: "2026-09-03T00:01:30.000Z" });
  const plan = buildMaintenancePlan(state({ backup_receipts: [receipt(), duplicate] }));
  assert.equal(plan.backup.fresh, true);
  assert.equal(plan.backup.valid_receipt_count, 2);
  assert.equal(plan.backup.equivalent_latest_count, 2);
});

test("does not treat a recent previous-period receipt as today's daily coverage", () => {
  const previous = receipt({
    period_key: "2026-09-02",
    completed_at: "2026-09-02T23:55:00.000Z",
    verified_at: "2026-09-02T23:56:00.000Z",
  });
  const plan = buildMaintenancePlan(state({ backup_receipts: [previous] }));
  assert.equal(plan.backup.fresh, false);
  assert.equal(plan.backup.required_daily_period_key, "2026-09-03");
  assert.equal(plan.actions[0].action, "check-or-create-backup");
});

test("marks a child plan review-ready only after a later full backup", () => {
  const readyTable = {
    alias: "live-history",
    record_count: 9000,
    record_limit: 10000,
    compaction: {
      skill: "creator-live-history-compaction",
      status: "ready",
      last_dry_run_at: "2026-09-02T23:58:00.000Z",
      built_at: "2026-09-02T23:58:00.000Z",
      plan_sha256: "e".repeat(64),
      delete_candidate_count: 500,
      projected_record_count: 8500,
      blocking_count: 0,
    },
  };
  const plan = buildMaintenancePlan(state({ tables: [readyTable] }));
  assert.equal(plan.tables[0].compaction.review_ready, true);
  assert.equal(plan.tables[0].compaction.requires_explicit_approval, true);

  const oldBackup = receipt({ period_key: "2026-09-02", completed_at: "2026-09-02T23:00:00.000Z", verified_at: "2026-09-02T23:01:00.000Z" });
  const blocked = buildMaintenancePlan(state({ backup_receipts: [oldBackup], tables: [readyTable] }));
  assert.equal(blocked.tables[0].compaction.review_ready, false);
});

test("rejects unreviewed capacity ratios and unsupported compaction skills", () => {
  assert.throws(
    () => buildMaintenancePlan(state({ policy: { ...state().policy, warning_ratio: 0.95, critical_ratio: 0.9 } })),
    /capacity ratios/,
  );
  const unsupported = state();
  unsupported.tables[0].compaction.skill = "unknown-compaction";
  assert.throws(() => buildMaintenancePlan(unsupported), /unsupported/);
});
