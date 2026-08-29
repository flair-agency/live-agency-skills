import { createHash } from "node:crypto";

import { validateProfileObservations } from "@live-agency-skills/source-provider-api";

export const PROFILE_TARGET_INPUT_KIND =
  "application/vnd.live-agency.creator-profile-targets+json";
const FUTURE_MARGIN_MS = 5 * 60 * 1000;
const PROFILE_REPLAY_MARGIN_MS = 5 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableSort(value[key])]),
    );
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
  return /^rec[A-Za-z0-9]{8,}$/.test(String(value ?? ""));
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

export function validateTargetManifest(manifest) {
  assert(manifest?.version === 1, "target manifest version is invalid");
  assert(manifest.inputKind === PROFILE_TARGET_INPUT_KIND, "target manifest inputKind is invalid");
  assert(!Number.isNaN(Date.parse(manifest.generatedAt)), "target manifest generatedAt is invalid");
  assert(["due", "selected", "all"].includes(manifest.targetMode), "target manifest mode is invalid");
  assert(Array.isArray(manifest.rows), "target manifest rows must be an array");
  assert(manifest.rowCount === manifest.rows.length, "target manifest rowCount does not match");
  assert(manifest.rowsSha256 === sha256Json(manifest.rows), "target manifest rows SHA does not match");
  const creatorIds = new Set();
  const accounts = new Set();
  for (const [index, row] of manifest.rows.entries()) {
    assert(isRecordId(row.creatorRecordId), `target row ${index} creatorRecordId is invalid`);
    const accountKey = normalizeAccountKey(row.accountKey);
    assert(accountKey, `target row ${index} accountKey is invalid`);
    assert(!creatorIds.has(row.creatorRecordId), `target creatorRecordId is duplicated: ${row.creatorRecordId}`);
    assert(!accounts.has(accountKey), `target accountKey is duplicated: ${accountKey}`);
    creatorIds.add(row.creatorRecordId);
    accounts.add(accountKey);
    assert(row.liveContext && typeof row.liveContext === "object", `target row ${index} liveContext is invalid`);
    assert(!Number.isNaN(Date.parse(row.liveContext.cutoffAt)), `target row ${index} cutoffAt is invalid`);
    assert(Array.isArray(row.liveContext.knownEvents), `target row ${index} knownEvents is invalid`);
    const eventKeys = new Set();
    for (const event of row.liveContext.knownEvents) {
      const startMs = Date.parse(event.startAt);
      const endMs = Date.parse(event.endAt);
      assert(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs, `target row ${index} known event is invalid`);
      const key = `${startMs}:${endMs}`;
      assert(!eventKeys.has(key), `target row ${index} known event is duplicated`);
      eventKeys.add(key);
    }
  }
  return manifest;
}

function normalizeObservations(snapshot, nowMs) {
  validateProfileObservations(snapshot);
  const normalized = structuredClone(snapshot);
  const seenAccounts = new Set();
  for (const creator of normalized.creators) {
    creator.accountKey = normalizeAccountKey(creator.accountKey);
    assert(creator.accountKey && !seenAccounts.has(creator.accountKey), `observation account is invalid or duplicated: ${creator.accountKey}`);
    seenAccounts.add(creator.accountKey);
    const observedAtMs = Date.parse(creator.observedAt);
    assert(observedAtMs <= nowMs + FUTURE_MARGIN_MS, `observation is in the future: ${creator.accountKey}`);
    creator.observedAtMs = observedAtMs;
    creator.lives = creator.lives.map((live) => ({
      ...live,
      startMs: Date.parse(live.startAt),
      endMs: Date.parse(live.endAt),
    }));
  }
  return normalized;
}

function profileMatches(record, creator, bindings) {
  const fields = record.fields ?? {};
  if (!linkedRecordIds(fields[bindings.profile.creator.name]).includes(creator.creatorRecordId)) return false;
  const timestampMs = Number(fields[bindings.profile.timestamp.name]);
  if (!Number.isFinite(timestampMs) || timestampMs < creator.observedAtMs - PROFILE_REPLAY_MARGIN_MS) return false;
  const follower = parseStoredCount(fields[bindings.profile.followerCount.name]);
  const community = parseStoredCount(fields[bindings.profile.communityCount.name]);
  if (creator.profile.followerCount !== null && follower !== creator.profile.followerCount) return false;
  if (creator.profile.communityCount !== null && community !== creator.profile.communityCount) return false;
  return true;
}

function storedLive(record, bindings) {
  const fields = record.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.live.creator.name]);
  const startMs = Number(fields[bindings.live.start.name]);
  const endMs = Number(fields[bindings.live.end.name]);
  if (creatorIds.length !== 1 || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const rawLikes = fields[bindings.live.likes.name];
  const likeCount = parseStoredCount(rawLikes);
  return {
    recordId: String(record.record_id ?? ""),
    key: `${creatorIds[0]}:${startMs}:${endMs}`,
    likeCount,
    likesInvalid: rawLikes !== null && rawLikes !== undefined && rawLikes !== "" && likeCount === null,
  };
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export function buildProfileSyncPlan({
  manifest,
  observations,
  profileRecords,
  liveRecords,
  bindings,
  nowMs = Date.now(),
}) {
  validateTargetManifest(manifest);
  assert(Array.isArray(profileRecords) && Array.isArray(liveRecords), "Lark record collections are invalid");
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
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

  const liveByKey = new Map();
  const invalidStoredLives = [];
  for (const record of liveRecords) {
    const stored = storedLive(record, bindings);
    if (!stored || !isRecordId(stored.recordId) || stored.likesInvalid) {
      invalidStoredLives.push(String(record?.record_id ?? ""));
      continue;
    }
    const matches = liveByKey.get(stored.key) ?? [];
    matches.push(stored);
    liveByKey.set(stored.key, matches);
  }

  const profileCreates = [];
  const profileAlreadyApplied = [];
  const profileUnavailable = [];
  const liveCreates = [];
  const liveAlreadyApplied = [];
  const liveConflicts = [];
  for (const creator of normalized.creators) {
    if (!targetsById.has(creator.creatorRecordId)) continue;
    const profileHasValue =
      creator.profile.followerCount !== null || creator.profile.communityCount !== null;
    if (!profileHasValue) {
      profileUnavailable.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        followerStatus: creator.profile.followerStatus,
        communityStatus: creator.profile.communityStatus,
      });
    } else if (profileRecords.some((record) => profileMatches(record, creator, bindings))) {
      profileAlreadyApplied.push({ creatorRecordId: creator.creatorRecordId, accountKey: creator.accountKey });
    } else {
      profileCreates.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        observedAtMs: creator.observedAtMs,
        followerCount: creator.profile.followerCount,
        communityCount: creator.profile.communityCount,
      });
    }

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
  }

  const unsigned = {
    version: 1,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    inputs: { manifest, observations: normalized },
    operations: {
      profileCreates,
      profileAlreadyApplied,
      profileUnavailable,
      liveCreates,
      liveAlreadyApplied,
      liveConflicts,
      targetIssues,
      invalidStoredLives: invalidStoredLives.sort(),
    },
    summary: {
      targetCount: manifest.rowCount,
      observationCount: normalized.rowCount,
      profileCreateCount: profileCreates.length,
      profileAlreadyAppliedCount: profileAlreadyApplied.length,
      profileUnavailableCount: profileUnavailable.length,
      liveObservedCount: normalized.creators.reduce((sum, creator) => sum + creator.lives.length, 0),
      liveCreateCount: liveCreates.length,
      liveAlreadyAppliedCount: liveAlreadyApplied.length,
      liveConflictCount: liveConflicts.length,
      targetIssueCount: targetIssues.length,
      invalidStoredLiveCount: invalidStoredLives.length,
    },
  };
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function validateProfileSyncPlan(plan) {
  assert(plan?.version === 1, "plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "plan timestamps do not match");
  assert(plan.operations && plan.summary, "plan structure is invalid");
  const arrays = [
    "profileCreates",
    "profileAlreadyApplied",
    "profileUnavailable",
    "liveCreates",
    "liveAlreadyApplied",
    "liveConflicts",
    "targetIssues",
    "invalidStoredLives",
  ];
  for (const key of arrays) assert(Array.isArray(plan.operations[key]), `plan operations.${key} is invalid`);
  assert(plan.summary.profileCreateCount === plan.operations.profileCreates.length, "plan profile create count does not match");
  assert(plan.summary.liveCreateCount === plan.operations.liveCreates.length, "plan live create count does not match");
  assert(plan.summary.liveConflictCount === plan.operations.liveConflicts.length, "plan live conflict count does not match");
  assert(plan.summary.targetIssueCount === plan.operations.targetIssues.length, "plan target issue count does not match");
  assert(plan.planSha256 === calculatePlanSha256(plan), "plan SHA does not match content");
  return plan;
}

export function planIsBlocked(plan) {
  return (
    plan.summary.liveConflictCount > 0 ||
    plan.summary.targetIssueCount > 0 ||
    plan.summary.invalidStoredLiveCount > 0
  );
}
