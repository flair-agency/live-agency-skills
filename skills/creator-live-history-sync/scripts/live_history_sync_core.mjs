import { createHash } from "node:crypto";

import { validateLiveHistoryObservations } from "@live-agency-skills/source-provider-api";

export const LIVE_HISTORY_TARGET_INPUT_KIND =
  "application/vnd.live-agency.creator-live-history-targets+json";
const FUTURE_MARGIN_MS = 5 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableSort(value));
}

export function sha256Json(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizeAccountKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .toLocaleLowerCase("und");
}

export function isRecordId(value) {
  return /^rec[A-Za-z0-9]{7,}$/.test(String(value ?? ""));
}

export function linkedRecordIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry === "string" && isRecordId(entry)) ids.push(entry);
    if (entry && typeof entry === "object") {
      if (isRecordId(entry.record_id)) ids.push(entry.record_id);
      if (Array.isArray(entry.record_ids)) {
        for (const recordId of entry.record_ids) if (isRecordId(recordId)) ids.push(recordId);
      }
    }
  }
  return [...new Set(ids)];
}

function parseStoredCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function validateLiveTargetManifest(manifest) {
  assert(manifest?.version === 1, "live target manifest version is invalid");
  assert(
    manifest.inputKind === LIVE_HISTORY_TARGET_INPUT_KIND,
    "live target manifest inputKind is invalid",
  );
  assert(!Number.isNaN(Date.parse(manifest.generatedAt)), "live target manifest generatedAt is invalid");
  assert(["due", "selected", "all"].includes(manifest.targetMode), "live target manifest mode is invalid");
  assert(Array.isArray(manifest.rows), "live target manifest rows must be an array");
  assert(manifest.rowCount === manifest.rows.length, "live target manifest rowCount does not match");
  assert(manifest.rowsSha256 === sha256Json(manifest.rows), "live target manifest rows SHA does not match");
  const creatorIds = new Set();
  const accounts = new Set();
  for (const [index, row] of manifest.rows.entries()) {
    assert(isRecordId(row.creatorRecordId), `live target row ${index} creatorRecordId is invalid`);
    const accountKey = normalizeAccountKey(row.accountKey);
    assert(accountKey, `live target row ${index} accountKey is invalid`);
    assert(!creatorIds.has(row.creatorRecordId), `live target creatorRecordId is duplicated: ${row.creatorRecordId}`);
    assert(!accounts.has(accountKey), `live target accountKey is duplicated: ${accountKey}`);
    creatorIds.add(row.creatorRecordId);
    accounts.add(accountKey);
    assert(row.liveContext && typeof row.liveContext === "object", `live target row ${index} liveContext is invalid`);
    assert(!Number.isNaN(Date.parse(row.liveContext.cutoffAt)), `live target row ${index} cutoffAt is invalid`);
    assert(Array.isArray(row.liveContext.knownEvents), `live target row ${index} knownEvents is invalid`);
    const eventKeys = new Set();
    for (const event of row.liveContext.knownEvents) {
      const startMs = Date.parse(event.startAt);
      const endMs = Date.parse(event.endAt);
      assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs, `live target row ${index} known event is invalid`);
      const key = `${startMs}:${endMs}`;
      assert(!eventKeys.has(key), `live target row ${index} known event is duplicated`);
      eventKeys.add(key);
    }
  }
  return manifest;
}

function normalizeObservations(snapshot, nowMs) {
  validateLiveHistoryObservations(snapshot);
  const normalized = structuredClone(snapshot);
  const seenAccounts = new Set();
  for (const creator of normalized.creators) {
    creator.accountKey = normalizeAccountKey(creator.accountKey);
    assert(
      creator.accountKey && !seenAccounts.has(creator.accountKey),
      `live observation account is invalid or duplicated: ${creator.accountKey}`,
    );
    seenAccounts.add(creator.accountKey);
    creator.observedAtMs = Date.parse(creator.observedAt);
    assert(
      creator.observedAtMs <= nowMs + FUTURE_MARGIN_MS,
      `live observation is in the future: ${creator.accountKey}`,
    );
    creator.lives = creator.lives.map((live) => ({
      ...live,
      startMs: Date.parse(live.startAt),
      endMs: Date.parse(live.endAt),
    }));
  }
  return normalized;
}

function storedLive(record, bindings) {
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.live.creator.name]);
  const startMs = Number(fields[bindings.live.start.name]);
  const endMs = Number(fields[bindings.live.end.name]);
  const rawLikes = fields[bindings.live.likes.name];
  const likeCount = parseStoredCount(rawLikes);
  const reasons = [];
  const recordId = String(record?.record_id ?? "");
  if (!isRecordId(recordId)) reasons.push("invalid_record_id");
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    reasons.push("invalid_timestamps");
  }
  if (rawLikes !== null && rawLikes !== undefined && rawLikes !== "" && likeCount === null) {
    reasons.push("invalid_like_count");
  }
  if (reasons.length) return { valid: false, recordId, reasons: [...new Set(reasons)].sort() };
  return {
    valid: true,
    recordId,
    creatorRecordId: creatorIds[0],
    key: `${creatorIds[0]}:${startMs}:${endMs}`,
    startMs,
    endMs,
    likeCount,
  };
}

function storedMetric(record, bindings) {
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.metric.creator.name]);
  const timestampMs = Number(fields[bindings.metric.timestamp.name]);
  const rawFanClub = fields[bindings.metric.fanClub.name];
  const fanClubCount = parseStoredCount(rawFanClub);
  const reasons = [];
  const recordId = String(record?.record_id ?? "");
  if (!isRecordId(recordId)) reasons.push("invalid_record_id");
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  if (!Number.isFinite(timestampMs)) reasons.push("invalid_timestamp");
  if (rawFanClub !== null && rawFanClub !== undefined && rawFanClub !== "" && fanClubCount === null) {
    reasons.push("invalid_fan_club_count");
  }
  if (reasons.length) return { valid: false, recordId, reasons: [...new Set(reasons)].sort() };
  return {
    valid: true,
    recordId,
    creatorRecordId: creatorIds[0],
    timestampMs,
    key: `${creatorIds[0]}:${timestampMs}`,
    fanClubCount,
  };
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export function recalculateLivePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function buildLiveHistorySyncPlan({
  manifest,
  observations,
  liveRecords,
  metricRecords,
  bindings,
  nowMs = Date.now(),
}) {
  validateLiveTargetManifest(manifest);
  assert(Array.isArray(liveRecords), "Lark live record collection is invalid");
  assert(Array.isArray(metricRecords), "Lark metric record collection is invalid");
  const normalized = normalizeObservations(observations, nowMs);
  const targetsById = new Map(manifest.rows.map((row) => [row.creatorRecordId, row]));
  const observationsById = new Map(normalized.creators.map((creator) => [creator.creatorRecordId, creator]));
  const targetIssues = [];
  for (const row of manifest.rows) {
    const creator = observationsById.get(row.creatorRecordId);
    if (!creator) {
      targetIssues.push({ creatorRecordId: row.creatorRecordId, accountKey: row.accountKey, reason: "observation_missing" });
    } else if (normalizeAccountKey(row.accountKey) !== creator.accountKey) {
      targetIssues.push({ creatorRecordId: row.creatorRecordId, accountKey: row.accountKey, reason: "account_mismatch" });
    }
  }
  for (const creator of normalized.creators) {
    if (!targetsById.has(creator.creatorRecordId)) {
      targetIssues.push({ creatorRecordId: creator.creatorRecordId, accountKey: creator.accountKey, reason: "unexpected_observation" });
    }
  }

  const normalizedLives = liveRecords.map((record) => storedLive(record, bindings));
  const invalidStoredLives = normalizedLives.filter((record) => !record.valid);
  const liveByKey = new Map();
  for (const record of normalizedLives.filter((item) => item.valid)) {
    const matches = liveByKey.get(record.key) ?? [];
    matches.push(record);
    liveByKey.set(record.key, matches);
  }
  const normalizedMetrics = metricRecords.map((record) => storedMetric(record, bindings));
  const invalidStoredMetrics = normalizedMetrics.filter((record) => !record.valid);
  const metricByKey = new Map();
  for (const record of normalizedMetrics.filter((item) => item.valid)) {
    const matches = metricByKey.get(record.key) ?? [];
    matches.push(record);
    metricByKey.set(record.key, matches);
  }

  const liveCreates = [];
  const liveAlreadyApplied = [];
  const liveConflicts = [];
  const metricCreates = [];
  const metricAlreadyApplied = [];
  const metricUnavailable = [];
  const metricConflicts = [];
  for (const creator of normalized.creators) {
    if (!targetsById.has(creator.creatorRecordId)) continue;
    for (const live of creator.lives) {
      const key = `${creator.creatorRecordId}:${live.startMs}:${live.endMs}`;
      const matches = liveByKey.get(key) ?? [];
      if (matches.length > 1) {
        liveConflicts.push({ creatorRecordId: creator.creatorRecordId, key, reason: "duplicate_existing_records" });
      } else if (matches.length === 1 && matches[0].likeCount !== live.likeCount) {
        liveConflicts.push({
          creatorRecordId: creator.creatorRecordId,
          key,
          reason: "existing_like_count_differs",
          storedLikeCount: matches[0].likeCount,
          observedLikeCount: live.likeCount,
        });
      } else if (matches.length === 1) {
        liveAlreadyApplied.push({ creatorRecordId: creator.creatorRecordId, key, recordId: matches[0].recordId });
      } else {
        liveCreates.push({
          creatorRecordId: creator.creatorRecordId,
          accountKey: creator.accountKey,
          startMs: live.startMs,
          endMs: live.endMs,
          likeCount: live.likeCount,
        });
      }
    }

    const metricEligible = creator.fanClubCount !== null || creator.liveScan.stopReason !== "unavailable";
    if (!metricEligible) {
      metricUnavailable.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        fanClubStatus: creator.fanClubStatus,
        liveStopReason: creator.liveScan.stopReason,
      });
      continue;
    }
    const key = `${creator.creatorRecordId}:${creator.observedAtMs}`;
    const matches = metricByKey.get(key) ?? [];
    if (matches.length > 1) {
      metricConflicts.push({ creatorRecordId: creator.creatorRecordId, key, reason: "duplicate_existing_records" });
    } else if (matches.length === 1 && matches[0].fanClubCount !== creator.fanClubCount) {
      metricConflicts.push({
        creatorRecordId: creator.creatorRecordId,
        key,
        reason: "existing_fan_club_count_differs",
        storedFanClubCount: matches[0].fanClubCount,
        observedFanClubCount: creator.fanClubCount,
      });
    } else if (matches.length === 1) {
      metricAlreadyApplied.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        observedAtMs: creator.observedAtMs,
        fanClubCount: creator.fanClubCount,
        recordId: matches[0].recordId,
      });
    } else {
      metricCreates.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        observedAtMs: creator.observedAtMs,
        fanClubCount: creator.fanClubCount,
      });
    }
  }

  const unsigned = {
    version: 1,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    inputs: { manifest, observations: normalized },
    operations: {
      liveCreates,
      liveAlreadyApplied,
      liveConflicts,
      metricCreates,
      metricAlreadyApplied,
      metricUnavailable,
      metricConflicts,
      metricFlowIssues: [],
      targetIssues,
      invalidStoredLives,
      invalidStoredMetrics,
    },
    summary: {
      targetCount: manifest.rowCount,
      observationCount: normalized.rowCount,
      liveObservedCount: normalized.creators.reduce((sum, creator) => sum + creator.lives.length, 0),
      liveCreateCount: liveCreates.length,
      liveAlreadyAppliedCount: liveAlreadyApplied.length,
      liveConflictCount: liveConflicts.length,
      metricCreateCount: metricCreates.length,
      metricAlreadyAppliedCount: metricAlreadyApplied.length,
      metricUnavailableCount: metricUnavailable.length,
      metricConflictCount: metricConflicts.length,
      metricFlowIssueCount: 0,
      targetIssueCount: targetIssues.length,
      invalidStoredLiveCount: invalidStoredLives.length,
      invalidStoredMetricCount: invalidStoredMetrics.length,
    },
  };
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function validateLiveHistorySyncPlan(plan) {
  assert(plan?.version === 1, "live sync plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "live sync plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "live sync plan timestamps do not match");
  assert(plan.operations && plan.summary, "live sync plan structure is invalid");
  for (const key of [
    "liveCreates",
    "liveAlreadyApplied",
    "liveConflicts",
    "metricCreates",
    "metricAlreadyApplied",
    "metricUnavailable",
    "metricConflicts",
    "metricFlowIssues",
    "targetIssues",
    "invalidStoredLives",
    "invalidStoredMetrics",
  ]) {
    assert(Array.isArray(plan.operations[key]), `live sync plan operations.${key} is invalid`);
  }
  assert(plan.summary.liveCreateCount === plan.operations.liveCreates.length, "live sync create count does not match");
  assert(plan.summary.metricCreateCount === plan.operations.metricCreates.length, "metric create count does not match");
  assert(plan.summary.metricFlowIssueCount === plan.operations.metricFlowIssues.length, "metric flow issue count does not match");
  assert(plan.planSha256 === calculatePlanSha256(plan), "live sync plan SHA does not match content");
  return plan;
}

export function livePlanIsBlocked(plan) {
  return (
    plan.summary.liveConflictCount > 0 ||
    plan.summary.metricConflictCount > 0 ||
    plan.summary.targetIssueCount > 0 ||
    plan.summary.invalidStoredLiveCount > 0 ||
    plan.summary.invalidStoredMetricCount > 0
  );
}
