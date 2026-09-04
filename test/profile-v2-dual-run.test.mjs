import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main as compareProfileV2DualRun } from "../skills/creator-profile-sync/scripts/compare_profile_v2_dual_run.mjs";
import {
  evaluateProfileV2DualRun,
  toCreatorScoutingProfileTargetManifest,
} from "../skills/creator-profile-sync/scripts/profile_v2_dual_run.mjs";
import {
  PROFILE_TARGET_INPUT_KIND,
  sha256Json,
} from "../skills/creator-profile-sync/scripts/profile_sync_core.mjs";

const OBSERVED_AT = "2030-01-02T03:05:00.000Z";
const BUILT_AT = "2030-01-02T03:06:00.000Z";
const CREATOR_ID = "recSyntheticCreator";

function manifest(accountKey = "synthetic.creator") {
  const rows = [{ creatorRecordId: CREATOR_ID, accountKey }];
  return {
    version: 2,
    inputKind: PROFILE_TARGET_INPUT_KIND,
    generatedAt: "2030-01-02T03:04:05.000Z",
    targetMode: "due",
    rowCount: rows.length,
    rows,
    rowsSha256: sha256Json(rows),
  };
}

function observations({ accountKey = "synthetic.creator", followerCount = 12300, avatarPath = "/private/v1/avatar.png", avatarName = "avatar.png" } = {}) {
  return {
    observedAt: OBSERVED_AT,
    rowCount: 1,
    creators: [{
      creatorRecordId: CREATOR_ID,
      accountKey,
      observedAt: OBSERVED_AT,
      profile: {
        followerCount,
        followerStatus: "observed_exact",
        followerDisplay: null,
        recentPostCount30d: 8,
        recentPostStatus: "observed_exact",
        latestPostAt: "2030-01-01T12:00:00.000Z",
        latestPostStatus: "observed_exact",
        nickname: "Synthetic Creator",
        nicknameStatus: "observed_exact",
        avatar: {
          path: avatarPath,
          sha256: "a".repeat(64),
          size: 1234,
          name: avatarName,
          mimeType: "image/png",
        },
        avatarStatus: "observed_exact",
        featureObservationData: {
          schema_version: 1,
          profile: { display_name: "Synthetic Creator" },
          posts: { last_30_days_count: 8 },
          observation: { observed_at: OBSERVED_AT },
        },
        featureObservationStatus: "observed_exact",
      },
    }],
  };
}

function rehashPlan(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  plan.planSha256 = sha256Json(unsigned);
  return plan;
}

function plan(targetManifest, normalizedObservations) {
  const creator = normalizedObservations.creators[0];
  const value = {
    version: 2,
    builtAt: BUILT_AT,
    builtAtMs: Date.parse(BUILT_AT),
    inputs: {
      manifest: targetManifest,
      observations: normalizedObservations,
    },
    operations: {
      profileCreates: [{
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        observedAtMs: Date.parse(creator.observedAt),
        followerCount: creator.profile.followerCount,
        recentPostCount30d: creator.profile.recentPostCount30d,
        latestPostAtMs: Date.parse(creator.profile.latestPostAt),
        nickname: creator.profile.nickname,
        avatar: creator.profile.avatar,
        featureObservationJson: JSON.stringify(creator.profile.featureObservationData),
      }],
      profileAttachExisting: [],
      profileAlreadyApplied: [],
      profileUnavailable: [],
      profileConflicts: [],
      targetIssues: [],
      invalidStoredProfiles: [],
    },
    summary: {
      targetCount: 1,
      observationCount: 1,
      profileCreateCount: 1,
      profileAttachCount: 1,
      profileAttachExistingCount: 0,
      profileAlreadyAppliedCount: 0,
      profileUnavailableCount: 0,
      profileConflictCount: 0,
      targetIssueCount: 0,
      invalidStoredProfileCount: 0,
    },
  };
  return rehashPlan(value);
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

function completedV2Path(targetManifest, normalizedObservations, dryRunPlan) {
  return {
    ...completedPath(targetManifest, normalizedObservations, dryRunPlan),
    mcpTargetManifest: toCreatorScoutingProfileTargetManifest(targetManifest),
  };
}

function input() {
  const targetManifest = manifest();
  const v1Observations = observations();
  const v2Observations = observations({
    avatarPath: "/private/v2/materialized-avatar.png",
    avatarName: "materialized-avatar.png",
  });
  return {
    version: 1,
    skill: "creator-profile-sync",
    generatedAt: "2030-01-02T03:07:00.000Z",
    reviewedTargetManifest: targetManifest,
    paths: {
      v1: completedPath(targetManifest, v1Observations, plan(targetManifest, v1Observations)),
      v2: completedV2Path(
        structuredClone(targetManifest),
        v2Observations,
        plan(structuredClone(targetManifest), v2Observations),
      ),
    },
  };
}

test("reports an exact synthetic profile v1/v2 comparison without authorizing cutover", () => {
  const result = evaluateProfileV2DualRun(input());
  assert.equal(result.status, "equivalent");
  assert.equal(result.targetCount, 1);
  assert.deepEqual(result.comparisons.map((item) => item.dimension), [
    "coverage",
    "normalized-values",
    "proposed-mutations",
    "unavailable-values",
    "stop-reasons",
  ]);
  assert.equal(result.comparisons.every((item) => item.matches), true);
  assert.equal(result.cutoverGate.routeSwitchAllowed, false);
  assert.deepEqual(result.cutoverGate.pending, [
    "active-domain-write-route-for-profile-history",
    "explicit-scheduled-route-approval",
    "two-successful-scheduled-v2-cycles",
  ]);
  assert.match(result.inputSha256, /^[0-9a-f]{64}$/);
  assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
});

test("reports normalized, mutation, and unavailable differences independently", () => {
  const value = input();
  value.paths.v2.observations = observations({ followerCount: 12400 });
  value.paths.v2.dryRunPlan = plan(
    value.paths.v2.targetManifest,
    value.paths.v2.observations,
  );
  value.paths.v2.unavailableValues = [{ field: "bio", reason: "not-observed" }];
  const result = evaluateProfileV2DualRun(value);
  assert.equal(result.status, "different");
  assert.equal(result.comparisons.find((item) => item.dimension === "coverage").matches, true);
  assert.equal(result.comparisons.find((item) => item.dimension === "normalized-values").matches, false);
  assert.equal(result.comparisons.find((item) => item.dimension === "proposed-mutations").matches, false);
  assert.equal(result.comparisons.find((item) => item.dimension === "unavailable-values").matches, false);
  assert.equal(result.comparisons.find((item) => item.dimension === "stop-reasons").matches, true);
});

test("blocks paths that are not bound to the reviewed target manifest", () => {
  const value = input();
  const changed = manifest("other.synthetic");
  const changedObservations = observations({ accountKey: "other.synthetic" });
  value.paths.v2.targetManifest = changed;
  value.paths.v2.mcpTargetManifest = toCreatorScoutingProfileTargetManifest(changed);
  value.paths.v2.observations = changedObservations;
  value.paths.v2.dryRunPlan = plan(changed, changedObservations);
  const result = evaluateProfileV2DualRun(value);
  assert.equal(result.status, "blocked");
  assert.equal(result.comparisons.find((item) => item.dimension === "coverage").matches, false);
});

test("rejects a Creator Scouting target envelope that drifts from the reviewed profile manifest", () => {
  const value = input();
  value.paths.v2.mcpTargetManifest = toCreatorScoutingProfileTargetManifest(
    manifest("other.synthetic"),
  );
  assert.throws(
    () => evaluateProfileV2DualRun(value),
    /does not map to the reviewed profile target manifest/,
  );
});

test("rejects a tampered private profile dry-run plan", () => {
  const value = input();
  value.paths.v2.dryRunPlan.operations.profileCreates[0].followerCount = 99999;
  assert.throws(() => evaluateProfileV2DualRun(value), /plan SHA does not match content/);
});

test("compares stopped profile paths by unavailable values and stop reasons", () => {
  const value = input();
  value.paths.v1 = {
    status: "stopped",
    targetManifest: value.reviewedTargetManifest,
    unavailableValues: [{ field: "profile", reason: "authentication-required" }],
    stopReasons: [{ code: "AUTHENTICATION_REQUIRED" }],
  };
  value.paths.v2 = {
    status: "stopped",
    targetManifest: value.reviewedTargetManifest,
    mcpTargetManifest: toCreatorScoutingProfileTargetManifest(value.reviewedTargetManifest),
    unavailableValues: [{ field: "profile", reason: "authentication-required" }],
    stopReasons: [{ code: "SCHEMA_CHANGED" }],
  };
  const result = evaluateProfileV2DualRun(value);
  assert.equal(result.status, "different");
  assert.equal(result.comparisons.find((item) => item.dimension === "unavailable-values").matches, true);
  assert.equal(result.comparisons.find((item) => item.dimension === "stop-reasons").matches, false);
  assert.equal(result.cutoverGate.routeSwitchAllowed, false);
});

test("writes an owner-only comparison report through the migration CLI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-v2-dual-run-test-"));
  try {
    const inputPath = path.join(directory, "input.json");
    const outputPath = path.join(directory, "report.json");
    await writeFile(inputPath, `${JSON.stringify(input())}\n`, { mode: 0o600 });
    const originalLog = console.log;
    console.log = () => {};
    let exitCode;
    try {
      exitCode = await compareProfileV2DualRun([
        "--input",
        inputPath,
        "--output",
        outputPath,
      ]);
    } finally {
      console.log = originalLog;
    }
    assert.equal(exitCode, 0);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.status, "equivalent");
    assert.equal(report.cutoverGate.routeSwitchAllowed, false);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
