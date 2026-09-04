import assert from "node:assert/strict";
import test from "node:test";

import { evaluateInvitationV2DualRun } from "../skills/creator-invitation-status-sync/scripts/invitation_v2_dual_run.mjs";
import {
  refreshPlanSha256,
  sha256Json,
} from "../skills/creator-invitation-status-sync/scripts/invitation_lark_runtime.mjs";

function manifest(accountKey = "synthetic.creator") {
  const rows = [{ creatorRecordId: "recSyntheticCreator", accountKey }];
  return {
    version: 1,
    generatedAt: "2030-01-02T03:04:05.000Z",
    targetMode: "due",
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
}

function observations(state = "synthetic_eligible") {
  return {
    observedAt: "2030-01-02T03:05:00.000Z",
    rowCount: 1,
    creators: [
      {
        accountKey: "synthetic.creator",
        state,
        externalUserId: "synthetic-user-1",
        nickname: "Synthetic Creator",
      },
    ],
  };
}

function plan(targetManifest, normalizedObservations, state = "synthetic_eligible") {
  const value = {
    version: 2,
    operationMode: "refresh",
    generatedAt: "2030-01-02T03:06:00.000Z",
    manifest: targetManifest,
    observations: normalizedObservations,
    operations: {
      creates: [
        {
          creatorRecordId: "recSyntheticCreator",
          accountKey: "synthetic.creator",
          state,
          observedAtMs: Date.parse(normalizedObservations.observedAt),
        },
      ],
      updates: [],
      attachExisting: [],
      alreadyApplied: [],
      identityConflicts: [],
      ambiguousLatest: [],
      staleObservations: [],
      invalidStored: [],
    },
    counts: { create: 1, update: 0, attach: 0, alreadyApplied: 0 },
  };
  value.planSha256 = refreshPlanSha256(value);
  return value;
}

function completedPath(targetManifest, normalizedObservations, dryRunPlan) {
  return {
    status: "completed",
    targetManifest,
    observations: normalizedObservations,
    dryRunPlan,
    unavailableValues: [],
    stopReasons: [],
  };
}

function input() {
  const targetManifest = manifest();
  const normalizedObservations = observations();
  const dryRunPlan = plan(targetManifest, normalizedObservations);
  return {
    version: 1,
    skill: "creator-invitation-status-sync",
    generatedAt: "2030-01-02T03:07:00.000Z",
    reviewedTargetManifest: targetManifest,
    paths: {
      v1: completedPath(targetManifest, normalizedObservations, dryRunPlan),
      v2: completedPath(
        structuredClone(targetManifest),
        structuredClone(normalizedObservations),
        structuredClone(dryRunPlan),
      ),
    },
  };
}

test("reports an exact synthetic v1/v2 comparison without authorizing cutover", () => {
  const result = evaluateInvitationV2DualRun(input());
  assert.equal(result.status, "equivalent");
  assert.equal(result.targetCount, 1);
  assert.equal(result.comparisons.length, 5);
  assert.equal(result.comparisons.every((item) => item.matches), true);
  assert.equal(result.cutoverGate.routeSwitchAllowed, false);
  assert.deepEqual(result.cutoverGate.pending, [
    "active-domain-write-route-for-invitation-history",
    "explicit-scheduled-route-approval",
    "two-successful-scheduled-v2-cycles",
  ]);
  assert.match(result.inputSha256, /^[0-9a-f]{64}$/);
  assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
});

test("reports every required comparison dimension independently", () => {
  const value = input();
  value.paths.v2.observations = observations("synthetic_ineligible");
  value.paths.v2.dryRunPlan = plan(
    value.paths.v2.targetManifest,
    value.paths.v2.observations,
    "synthetic_ineligible",
  );
  value.paths.v2.unavailableValues = [{ field: "avatar", reason: "not-observed" }];
  const result = evaluateInvitationV2DualRun(value);
  assert.equal(result.status, "different");
  assert.equal(
    result.comparisons.find((item) => item.dimension === "coverage").matches,
    true,
  );
  assert.equal(
    result.comparisons.find((item) => item.dimension === "normalized-values").matches,
    false,
  );
  assert.equal(
    result.comparisons.find((item) => item.dimension === "proposed-mutations").matches,
    false,
  );
  assert.equal(
    result.comparisons.find((item) => item.dimension === "unavailable-values").matches,
    false,
  );
});

test("blocks paths that are not bound to the reviewed target manifest", () => {
  const value = input();
  const changed = manifest("other.synthetic");
  value.paths.v2.targetManifest = changed;
  value.paths.v2.observations.creators[0].accountKey = "other.synthetic";
  value.paths.v2.dryRunPlan = plan(changed, value.paths.v2.observations);
  value.paths.v2.dryRunPlan.operations.creates[0].accountKey = "other.synthetic";
  value.paths.v2.dryRunPlan.planSha256 = refreshPlanSha256(value.paths.v2.dryRunPlan);
  const result = evaluateInvitationV2DualRun(value);
  assert.equal(result.status, "blocked");
  assert.equal(
    result.comparisons.find((item) => item.dimension === "coverage").matches,
    false,
  );
});

test("rejects a tampered private dry-run plan", () => {
  const value = input();
  value.paths.v2.dryRunPlan.counts.create = 2;
  assert.throws(() => evaluateInvitationV2DualRun(value), /hash is invalid/);
});

test("compares stopped paths by unavailable values and stop reasons", () => {
  const value = input();
  const stopped = {
    status: "stopped",
    targetManifest: value.reviewedTargetManifest,
    unavailableValues: [{ field: "eligibility", reason: "authentication-required" }],
    stopReasons: [{ code: "AUTHENTICATION_REQUIRED" }],
  };
  value.paths.v1 = structuredClone(stopped);
  value.paths.v2 = structuredClone(stopped);
  const result = evaluateInvitationV2DualRun(value);
  assert.equal(result.status, "different");
  assert.equal(
    result.comparisons.find((item) => item.dimension === "stop-reasons").matches,
    true,
  );
  assert.equal(result.cutoverGate.routeSwitchAllowed, false);
});
