import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDrillPreflight,
  sha256Json,
} from "../skills/lark-base-disaster-recovery-drill/scripts/drill_core.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function backup(overrides = {}) {
  return {
    version: 1,
    status: "verified",
    base_alias: "synthetic-scouting",
    schema_sha256: SHA_A,
    artifact_kind: "full-base-export",
    artifact_sha256: SHA_B,
    receipt_sha256: SHA_C,
    restore_scope: "full-base",
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    version: 1,
    base_alias: "synthetic-scouting",
    production_instance_ref: "synthetic-production",
    isolated_destination_ref: "synthetic-ephemeral-test",
    destination_policy: "new-non-production-base",
    restore_route: "browser-native-base-import",
    cleanup_policy: "separate-explicit-approval",
    expected_schema_sha256: SHA_A,
    attachment_check: "required",
    ...overrides,
  };
}

test("scheduled drill preparation stops at a content-bound dry run", () => {
  const plan = buildDrillPreflight({
    backupReceipt: backup(),
    profile: profile(),
    executionMode: "scheduled",
  });
  assert.equal(plan.status, "dry-run-complete");
  assert.equal(plan.test_creation_authorized, false);
  assert.equal(plan.plan_sha256, sha256Json(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "plan_sha256"))));
});

test("separate test-creation authorization can make only the isolated restore ready", () => {
  const plan = buildDrillPreflight({
    backupReceipt: backup(),
    profile: profile(),
    executionMode: "interactive",
    testCreationAuthorized: true,
  });
  assert.equal(plan.status, "ready-for-isolated-restore");
  assert.equal(plan.cleanup_policy, "separate-explicit-approval");
});

test("rejects unverified, logical-only, mismatched, and production destinations", () => {
  assert.throws(
    () => buildDrillPreflight({ backupReceipt: backup({ status: "uploaded" }), profile: profile(), executionMode: "interactive" }),
    /must be verified/,
  );
  assert.throws(
    () => buildDrillPreflight({ backupReceipt: backup({ artifact_kind: "logical-data-snapshot" }), profile: profile(), executionMode: "interactive" }),
    /full Base export/,
  );
  assert.throws(
    () => buildDrillPreflight({ backupReceipt: backup(), profile: profile({ expected_schema_sha256: "d".repeat(64) }), executionMode: "interactive" }),
    /schema does not match/,
  );
  assert.throws(
    () => buildDrillPreflight({ backupReceipt: backup(), profile: profile({ isolated_destination_ref: "synthetic-production" }), executionMode: "interactive" }),
    /must differ from production/,
  );
});

