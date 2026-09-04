import { createHash } from "node:crypto";

import { validateProfileObservations } from "@live-agency-skills/source-provider-api";

import {
  normalizeAccountKey,
  sha256Json,
  validateProfileSyncPlan,
  validateTargetManifest,
} from "./profile_sync_core.mjs";

const SKILL = "creator-profile-sync";
const PATH_NAMES = ["v1", "v2"];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Stable(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sha256JsonInOrder(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function completeManifest(value, label) {
  const manifest = validateTargetManifest(value);
  assertTimestamp(manifest.generatedAt, `${label}.generatedAt`);
  if (!/^[0-9a-f]{64}$/.test(manifest.rowsSha256 ?? "")) {
    throw new TypeError(`${label}.rowsSha256 is invalid`);
  }
  if (manifest.rowsSha256 !== sha256Json(manifest.rows)) {
    throw new TypeError(`${label}.rowsSha256 does not match rows`);
  }
  return manifest;
}

function manifestSignature(manifest) {
  return stableJson({
    version: manifest.version,
    inputKind: manifest.inputKind,
    generatedAt: manifest.generatedAt,
    targetMode: manifest.targetMode,
    rowCount: manifest.rowCount,
    rows: manifest.rows.map((row) => ({
      creatorRecordId: row.creatorRecordId,
      accountKey: normalizeAccountKey(row.accountKey),
    })),
    rowsSha256: manifest.rowsSha256,
  });
}

function targetSetSignature(manifest) {
  return stableJson({
    generatedAt: new Date(manifest.generatedAt).toISOString(),
    targetMode: manifest.targetMode,
    rowCount: manifest.rowCount,
    rows: manifest.rows.map((row) => ({
      creatorRecordId: row.creatorRecordId,
      accountKey: normalizeAccountKey(row.accountKey),
    })),
  });
}

export function toCreatorScoutingProfileTargetManifest(value) {
  const manifest = completeManifest(value, "profile target manifest");
  if (manifest.rowCount < 1) {
    throw new TypeError("profile target manifest must contain at least one row");
  }
  const rows = manifest.rows.map((row) => ({
    creatorRecordId: row.creatorRecordId,
    accountKey: normalizeAccountKey(row.accountKey),
  }));
  return {
    version: 1,
    generatedAt: new Date(manifest.generatedAt).toISOString(),
    targetMode: manifest.targetMode,
    rowCount: rows.length,
    rows,
    rowsSha256: sha256JsonInOrder(rows),
  };
}

function completeCreatorScoutingTargetManifest(value, label) {
  assertObject(value, label);
  if (value.version !== 1 || !["due", "selected", "all"].includes(value.targetMode)) {
    throw new TypeError(`${label} format is invalid`);
  }
  assertTimestamp(value.generatedAt, `${label}.generatedAt`);
  if (!Array.isArray(value.rows) || value.rowCount !== value.rows.length || value.rowCount < 1) {
    throw new TypeError(`${label}.rowCount must match a non-empty rows array`);
  }
  const creatorIds = new Set();
  const accounts = new Set();
  for (const [index, row] of value.rows.entries()) {
    assertObject(row, `${label}.rows[${index}]`);
    if (typeof row.creatorRecordId !== "string" || !row.creatorRecordId.trim()) {
      throw new TypeError(`${label}.rows[${index}].creatorRecordId is invalid`);
    }
    const accountKey = normalizeAccountKey(row.accountKey);
    if (!accountKey) throw new TypeError(`${label}.rows[${index}].accountKey is invalid`);
    if (creatorIds.has(row.creatorRecordId) || accounts.has(accountKey)) {
      throw new TypeError(`${label} contains duplicate targets`);
    }
    creatorIds.add(row.creatorRecordId);
    accounts.add(accountKey);
  }
  if (!/^[0-9a-f]{64}$/.test(value.rowsSha256 ?? "")) {
    throw new TypeError(`${label}.rowsSha256 is invalid`);
  }
  if (value.rowsSha256 !== sha256JsonInOrder(value.rows)) {
    throw new TypeError(`${label}.rowsSha256 does not match rows`);
  }
  return value;
}

function assertCreatorScoutingTargetMapping(value, profileManifest, label) {
  const manifest = completeCreatorScoutingTargetManifest(value, label);
  if (targetSetSignature(manifest) !== targetSetSignature(profileManifest)) {
    throw new TypeError(`${label} does not map to the reviewed profile target manifest`);
  }
  return manifest;
}

function avatarSignature(avatar) {
  if (!avatar) return null;
  return {
    sha256: avatar.sha256,
    size: avatar.size,
    mimeType: avatar.mimeType,
  };
}

function observationSignature(observations) {
  validateProfileObservations(observations);
  return stableJson({
    observedAt: observations.observedAt,
    rowCount: observations.rowCount,
    creators: observations.creators
      .map((creator) => ({
        creatorRecordId: creator.creatorRecordId,
        accountKey: normalizeAccountKey(creator.accountKey),
        observedAt: creator.observedAt,
        profile: {
          followerCount: creator.profile.followerCount,
          followerStatus: creator.profile.followerStatus,
          followerDisplay: creator.profile.followerDisplay ?? null,
          recentPostCount30d: creator.profile.recentPostCount30d,
          recentPostStatus: creator.profile.recentPostStatus,
          latestPostAt: creator.profile.latestPostAt,
          latestPostStatus: creator.profile.latestPostStatus,
          nickname: creator.profile.nickname,
          nicknameStatus: creator.profile.nicknameStatus,
          avatar: avatarSignature(creator.profile.avatar),
          avatarStatus: creator.profile.avatarStatus,
          featureObservationData: stableValue(creator.profile.featureObservationData),
          featureObservationStatus: creator.profile.featureObservationStatus,
        },
      }))
      .sort((left, right) =>
        left.accountKey.localeCompare(right.accountKey, "en") ||
        left.creatorRecordId.localeCompare(right.creatorRecordId, "en"),
      ),
  });
}

function semanticOperationValue(value, key = "") {
  if (key === "path" || key === "name") return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => semanticOperationValue(item))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right), "en"));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([childKey, childValue]) => [
        childKey,
        semanticOperationValue(childValue, childKey),
      ])
      .filter(([, childValue]) => childValue !== undefined),
  );
}

function validatePlanCounts(plan, label) {
  const expected = {
    targetCount: plan.inputs.manifest.rowCount,
    observationCount: plan.inputs.observations.rowCount,
    profileCreateCount: plan.operations.profileCreates.length,
    profileAttachCount:
      plan.operations.profileAttachExisting.length +
      plan.operations.profileCreates.filter((item) => item.avatar).length,
    profileAttachExistingCount: plan.operations.profileAttachExisting.length,
    profileAlreadyAppliedCount: plan.operations.profileAlreadyApplied.length,
    profileUnavailableCount: plan.operations.profileUnavailable.length,
    profileConflictCount: plan.operations.profileConflicts.length,
    targetIssueCount: plan.operations.targetIssues.length,
    invalidStoredProfileCount: plan.operations.invalidStoredProfiles.length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!Number.isSafeInteger(plan.summary[key]) || plan.summary[key] < 0) {
      throw new TypeError(`${label}.summary.${key} must be a non-negative integer`);
    }
    if (plan.summary[key] !== value) {
      throw new TypeError(`${label}.summary.${key} does not match operations`);
    }
  }
}

function planSignature(plan, manifest, observations, label) {
  assertObject(plan, label);
  validateProfileSyncPlan(plan);
  assertObject(plan.inputs, `${label}.inputs`);
  const planManifest = completeManifest(plan.inputs.manifest, `${label}.inputs.manifest`);
  assertObject(plan.inputs.observations, `${label}.inputs.observations`);
  validateProfileObservations(plan.inputs.observations);
  if (manifestSignature(planManifest) !== manifestSignature(manifest)) {
    throw new TypeError(`${label} does not use its path target manifest`);
  }
  if (observationSignature(plan.inputs.observations) !== observationSignature(observations)) {
    throw new TypeError(`${label} does not use its path observations`);
  }
  validatePlanCounts(plan, label);
  return stableJson({
    operations: semanticOperationValue(plan.operations),
    summary: plan.summary,
  });
}

function normalizedIssueList(value, label, requiredKey) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  for (const [index, item] of value.entries()) {
    assertObject(item, `${label}[${index}]`);
    if (typeof item[requiredKey] !== "string" || !item[requiredKey].trim()) {
      throw new TypeError(`${label}[${index}].${requiredKey} is required`);
    }
  }
  return value
    .map(stableValue)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right), "en"));
}

function validatePath(value, label, pathName) {
  assertObject(value, label);
  if (!["completed", "stopped"].includes(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  const targetManifest = completeManifest(value.targetManifest, `${label}.targetManifest`);
  if (pathName === "v2") {
    assertCreatorScoutingTargetMapping(
      value.mcpTargetManifest,
      targetManifest,
      `${label}.mcpTargetManifest`,
    );
  } else if (value.mcpTargetManifest !== undefined) {
    throw new TypeError(`${label}.mcpTargetManifest is only valid for the v2 path`);
  }
  const unavailableValues = normalizedIssueList(
    value.unavailableValues,
    `${label}.unavailableValues`,
    "field",
  );
  const stopReasons = normalizedIssueList(value.stopReasons, `${label}.stopReasons`, "code");
  if (value.status === "stopped") {
    if (stopReasons.length === 0) throw new TypeError(`${label} stopped without a stop reason`);
    if (value.observations !== undefined || value.dryRunPlan !== undefined) {
      throw new TypeError(`${label} stopped path must not contain observations or a dry-run plan`);
    }
    return {
      status: value.status,
      targetManifest,
      unavailableValues,
      stopReasons,
      observationSignature: null,
      planSignature: null,
    };
  }
  if (stopReasons.length !== 0) throw new TypeError(`${label} completed with stop reasons`);
  assertObject(value.observations, `${label}.observations`);
  assertObject(value.dryRunPlan, `${label}.dryRunPlan`);
  return {
    status: value.status,
    targetManifest,
    unavailableValues,
    stopReasons,
    observationSignature: observationSignature(value.observations),
    planSignature: planSignature(
      value.dryRunPlan,
      targetManifest,
      value.observations,
      `${label}.dryRunPlan`,
    ),
  };
}

function comparison(name, left, right) {
  const matches = left === right;
  return {
    dimension: name,
    matches,
    v1Sha256: sha256Stable(left),
    v2Sha256: sha256Stable(right),
  };
}

export function evaluateProfileV2DualRun(input) {
  assertObject(input, "dual-run input");
  if (input.version !== 1 || input.skill !== SKILL) {
    throw new TypeError("dual-run input identity is invalid");
  }
  assertTimestamp(input.generatedAt, "dual-run input generatedAt");
  const reviewedTargetManifest = completeManifest(
    input.reviewedTargetManifest,
    "dual-run input reviewedTargetManifest",
  );
  assertObject(input.paths, "dual-run input paths");
  const paths = Object.fromEntries(
    PATH_NAMES.map((name) => [
      name,
      validatePath(input.paths[name], `dual-run input paths.${name}`, name),
    ]),
  );

  const reviewedSignature = manifestSignature(reviewedTargetManifest);
  const coverage = comparison(
    "coverage",
    stableJson({ reviewed: reviewedSignature, path: manifestSignature(paths.v1.targetManifest) }),
    stableJson({ reviewed: reviewedSignature, path: manifestSignature(paths.v2.targetManifest) }),
  );
  const bothUseReviewedManifest = PATH_NAMES.every(
    (name) => manifestSignature(paths[name].targetManifest) === reviewedSignature,
  );
  coverage.matches = coverage.matches && bothUseReviewedManifest;

  const comparisons = [
    coverage,
    comparison("normalized-values", paths.v1.observationSignature, paths.v2.observationSignature),
    comparison("proposed-mutations", paths.v1.planSignature, paths.v2.planSignature),
    comparison(
      "unavailable-values",
      stableJson(paths.v1.unavailableValues),
      stableJson(paths.v2.unavailableValues),
    ),
    comparison("stop-reasons", stableJson(paths.v1.stopReasons), stableJson(paths.v2.stopReasons)),
  ];
  const allMatch = comparisons.every((item) => item.matches);
  const bothCompleted = PATH_NAMES.every((name) => paths[name].status === "completed");
  const status = !bothUseReviewedManifest
    ? "blocked"
    : allMatch && bothCompleted
      ? "equivalent"
      : "different";
  const inputSha256 = sha256Stable(input);
  const result = {
    version: 1,
    skill: SKILL,
    status,
    generatedAt: input.generatedAt,
    reviewedTargetManifestSha256: reviewedTargetManifest.rowsSha256,
    targetCount: reviewedTargetManifest.rowCount,
    inputSha256,
    comparisons,
    cutoverGate: {
      routeSwitchAllowed: false,
      reason: "comparison-only; no scheduled-route activation authority",
      pending: [
        "active-domain-write-route-for-profile-history",
        "explicit-scheduled-route-approval",
        "two-successful-scheduled-v2-cycles",
      ],
    },
  };
  result.resultSha256 = sha256Stable(result);
  return result;
}
