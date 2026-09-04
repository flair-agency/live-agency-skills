import { createHash } from "node:crypto";

import {
  normalizeAccountKey,
  normalizeObservations,
  validateTargetManifest,
} from "./invitation_state_core.mjs";
import { refreshPlanSha256, sha256Json } from "./invitation_lark_runtime.mjs";

const SKILL = "creator-invitation-status-sync";
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

function avatarSignature(avatar) {
  if (!avatar) return null;
  return {
    sha256: avatar.sha256,
    size: avatar.size,
    mimeType: avatar.mimeType,
  };
}

function observationSignature(observations, manifest) {
  const normalized = normalizeObservations(observations, manifest);
  return stableJson({
    observedAt: normalized.observedAt,
    rowCount: normalized.rowCount,
    creators: normalized.creators
      .map((creator) => ({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        state: creator.state,
        externalUserId: creator.externalUserId,
        nickname: creator.nickname,
        avatar: avatarSignature(creator.avatar),
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
      .filter(([childKey]) => !["generatedAt", "planSha256"].includes(childKey))
      .map(([childKey, childValue]) => [
        childKey,
        semanticOperationValue(childValue, childKey),
      ])
      .filter(([, childValue]) => childValue !== undefined),
  );
}

function validateCounts(counts, label) {
  assertObject(counts, label);
  for (const key of ["create", "update", "attach", "alreadyApplied"]) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative integer`);
    }
  }
}

function planSignature(plan, manifest, observations, label) {
  assertObject(plan, label);
  if (plan.version !== 2 || plan.operationMode !== "refresh") {
    throw new TypeError(`${label} format is invalid`);
  }
  if (refreshPlanSha256(plan) !== plan.planSha256) {
    throw new TypeError(`${label} hash is invalid`);
  }
  if (manifestSignature(completeManifest(plan.manifest, `${label}.manifest`)) !== manifestSignature(manifest)) {
    throw new TypeError(`${label} does not use its path target manifest`);
  }
  if (observationSignature(plan.observations, manifest) !== observationSignature(observations, manifest)) {
    throw new TypeError(`${label} does not use its path observations`);
  }
  assertObject(plan.operations, `${label}.operations`);
  validateCounts(plan.counts, `${label}.counts`);
  return stableJson({
    operations: semanticOperationValue(plan.operations),
    counts: plan.counts,
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
  return value.map(stableValue).sort((left, right) => stableJson(left).localeCompare(stableJson(right), "en"));
}

function validatePath(value, label) {
  assertObject(value, label);
  if (!['completed', 'stopped'].includes(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  const targetManifest = completeManifest(value.targetManifest, `${label}.targetManifest`);
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
    observationSignature: observationSignature(value.observations, targetManifest),
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

export function evaluateInvitationV2DualRun(input) {
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
    PATH_NAMES.map((name) => [name, validatePath(input.paths[name], `dual-run input paths.${name}`)]),
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
        "active-domain-write-route-for-invitation-history",
        "explicit-scheduled-route-approval",
        "two-successful-scheduled-v2-cycles",
      ],
    },
  };
  result.resultSha256 = sha256Stable(result);
  return result;
}
