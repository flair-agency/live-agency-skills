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

function parseStoredDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(number) ? number : null;
}

function sameDateTimeMinute(leftMs, rightMs) {
  return Math.floor(leftMs / 60_000) === Math.floor(rightMs / 60_000);
}

function parseStoredText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return null;
}

function parseStoredJson(value) {
  const text = parseStoredText(value);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? stableStringify(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateTargetManifest(manifest) {
  assert(manifest?.version === 2, "target manifest version is invalid");
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
    assert(Object.keys(row).length === 2, `target row ${index} contains unsupported context`);
  }
  return manifest;
}

function normalizeObservations(snapshot, nowMs) {
  validateProfileObservations(snapshot);
  const normalized = structuredClone(snapshot);
  const seenAccounts = new Set();
  for (const creator of normalized.creators) {
    creator.accountKey = normalizeAccountKey(creator.accountKey);
    assert(
      creator.accountKey && !seenAccounts.has(creator.accountKey),
      `observation account is invalid or duplicated: ${creator.accountKey}`,
    );
    seenAccounts.add(creator.accountKey);
    const observedAtMs = Date.parse(creator.observedAt);
    assert(observedAtMs <= nowMs + FUTURE_MARGIN_MS, `observation is in the future: ${creator.accountKey}`);
    creator.observedAtMs = observedAtMs;
    creator.profile.latestPostAtMs = creator.profile.latestPostAt === null
      ? null
      : Date.parse(creator.profile.latestPostAt);
    creator.profile.featureObservationJson = creator.profile.featureObservationData === null
      ? null
      : stableStringify(creator.profile.featureObservationData);
  }
  return normalized;
}

async function hydrateProfileRecord(record, bindings, resolveAttachmentHash) {
  const reasons = [];
  const recordId = String(record?.record_id ?? "");
  if (!isRecordId(recordId)) reasons.push("invalid_record_id");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.profile.creator.name]);
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  const timestampMs = Number(fields[bindings.profile.timestamp.name]);
  if (!Number.isFinite(timestampMs)) reasons.push("invalid_timestamp");

  const rawFollower = fields[bindings.profile.followerCount.name];
  const rawRecentPosts = fields[bindings.profile.recentPostCount30d.name];
  const rawLatestPost = fields[bindings.profile.latestPostAt.name];
  const rawNickname = fields[bindings.profile.nickname.name];
  const rawFeatureData = fields[bindings.profile.featureObservationData.name];
  const followerCount = parseStoredCount(rawFollower);
  const recentPostCount30d = parseStoredCount(rawRecentPosts);
  const latestPostAtMs = parseStoredDate(rawLatestPost);
  const nickname = parseStoredText(rawNickname);
  const featureObservationJson = parseStoredJson(rawFeatureData);
  if (rawFollower !== null && rawFollower !== undefined && rawFollower !== "" && followerCount === null) {
    reasons.push("invalid_follower_count");
  }
  if (rawRecentPosts !== null && rawRecentPosts !== undefined && rawRecentPosts !== "" && recentPostCount30d === null) {
    reasons.push("invalid_recent_post_count");
  }
  if (rawLatestPost !== null && rawLatestPost !== undefined && rawLatestPost !== "" && latestPostAtMs === null) {
    reasons.push("invalid_latest_post_at");
  }
  if (rawNickname !== null && rawNickname !== undefined && rawNickname !== "" && nickname === null) {
    reasons.push("invalid_nickname");
  }
  if (rawFeatureData !== null && rawFeatureData !== undefined && rawFeatureData !== "" && featureObservationJson === undefined) {
    reasons.push("invalid_feature_observation_json");
  }

  const attachments = Array.isArray(fields[bindings.profile.avatar.name])
    ? fields[bindings.profile.avatar.name]
    : [];
  const avatarHashes = [];
  try {
    for (const attachment of attachments) avatarHashes.push(await resolveAttachmentHash(attachment));
  } catch {
    reasons.push("invalid_avatar_attachment");
  }

  if (reasons.length) return { valid: false, recordId, reasons: [...new Set(reasons)].sort() };
  return {
    valid: true,
    recordId,
    creatorRecordId: creatorIds[0],
    timestampMs,
    followerCount,
    recentPostCount30d,
    latestPostAtMs,
    nickname,
    featureObservationJson: featureObservationJson ?? null,
    avatarHashes: [...new Set(avatarHashes)].sort(),
  };
}

function nonAvatarFieldsMatch(record, creator) {
  const profile = creator.profile;
  if (profile.followerCount !== null && record.followerCount !== profile.followerCount) return false;
  if (
    profile.recentPostCount30d !== null &&
    record.recentPostCount30d !== profile.recentPostCount30d
  ) return false;
  if (
    profile.latestPostAtMs !== null &&
    (record.latestPostAtMs === null ||
      !sameDateTimeMinute(record.latestPostAtMs, profile.latestPostAtMs))
  ) return false;
  if (profile.nickname !== null && record.nickname !== profile.nickname) return false;
  if (
    profile.featureObservationJson !== null &&
    record.featureObservationJson !== profile.featureObservationJson
  ) return false;
  return true;
}

function profileHasValue(profile) {
  return [
    profile.followerCount,
    profile.recentPostCount30d,
    profile.latestPostAt,
    profile.nickname,
    profile.avatar,
    profile.featureObservationData,
  ].some((value) => value !== null);
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export async function buildProfileSyncPlan({
  manifest,
  observations,
  profileRecords,
  bindings,
  resolveAttachmentHash = async () => {
    throw new TypeError("attachment hash resolver is unavailable");
  },
  nowMs = Date.now(),
}) {
  validateTargetManifest(manifest);
  assert(Array.isArray(profileRecords), "Lark profile record collection is invalid");
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

  const hydrated = await Promise.all(
    profileRecords.map((record) => hydrateProfileRecord(record, bindings, resolveAttachmentHash)),
  );
  const invalidStoredProfiles = hydrated
    .filter((record) => !record.valid)
    .map((record) => ({ recordId: record.recordId, reasons: record.reasons }));
  const validProfiles = hydrated.filter((record) => record.valid);
  const byCreator = new Map();
  for (const record of validProfiles) {
    const rows = byCreator.get(record.creatorRecordId) ?? [];
    rows.push(record);
    byCreator.set(record.creatorRecordId, rows);
  }

  const profileCreates = [];
  const profileAttachExisting = [];
  const profileAlreadyApplied = [];
  const profileUnavailable = [];
  const profileConflicts = [];
  for (const creator of normalized.creators) {
    if (!targetsById.has(creator.creatorRecordId)) continue;
    if (!profileHasValue(creator.profile)) {
      profileUnavailable.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        statuses: {
          follower: creator.profile.followerStatus,
          recentPosts: creator.profile.recentPostStatus,
          latestPost: creator.profile.latestPostStatus,
          nickname: creator.profile.nicknameStatus,
          avatar: creator.profile.avatarStatus,
          featureObservation: creator.profile.featureObservationStatus,
        },
      });
      continue;
    }
    const candidates = (byCreator.get(creator.creatorRecordId) ?? []).filter(
      (record) =>
        record.timestampMs >= creator.observedAtMs - PROFILE_REPLAY_MARGIN_MS &&
        nonAvatarFieldsMatch(record, creator),
    );
    const avatarHash = creator.profile.avatar?.sha256 ?? null;
    const exact = candidates.filter(
      (record) => avatarHash === null || record.avatarHashes.includes(avatarHash),
    );
    if (exact.length) {
      profileAlreadyApplied.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        recordId: exact.sort((left, right) => right.timestampMs - left.timestampMs)[0].recordId,
      });
      continue;
    }
    const attachmentCandidates = avatarHash === null
      ? []
      : candidates.filter((record) => record.avatarHashes.length === 0);
    if (attachmentCandidates.length === 1) {
      profileAttachExisting.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        recordId: attachmentCandidates[0].recordId,
        avatar: creator.profile.avatar,
      });
      continue;
    }
    if (attachmentCandidates.length > 1) {
      profileConflicts.push({
        creatorRecordId: creator.creatorRecordId,
        accountKey: creator.accountKey,
        reason: "multiple_attachment_resume_candidates",
      });
      continue;
    }
    profileCreates.push({
      creatorRecordId: creator.creatorRecordId,
      accountKey: creator.accountKey,
      observedAtMs: creator.observedAtMs,
      followerCount: creator.profile.followerCount,
      recentPostCount30d: creator.profile.recentPostCount30d,
      latestPostAtMs: creator.profile.latestPostAtMs,
      nickname: creator.profile.nickname,
      avatar: creator.profile.avatar,
      featureObservationJson: creator.profile.featureObservationJson,
    });
  }

  const unsigned = {
    version: 2,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    inputs: { manifest, observations: normalized },
    operations: {
      profileCreates,
      profileAttachExisting,
      profileAlreadyApplied,
      profileUnavailable,
      profileConflicts,
      targetIssues,
      invalidStoredProfiles,
    },
    summary: {
      targetCount: manifest.rowCount,
      observationCount: normalized.rowCount,
      profileCreateCount: profileCreates.length,
      profileAttachCount:
        profileAttachExisting.length + profileCreates.filter((item) => item.avatar).length,
      profileAttachExistingCount: profileAttachExisting.length,
      profileAlreadyAppliedCount: profileAlreadyApplied.length,
      profileUnavailableCount: profileUnavailable.length,
      profileConflictCount: profileConflicts.length,
      targetIssueCount: targetIssues.length,
      invalidStoredProfileCount: invalidStoredProfiles.length,
    },
  };
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function validateProfileSyncPlan(plan) {
  assert(plan?.version === 2, "plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "plan timestamps do not match");
  assert(plan.operations && plan.summary, "plan structure is invalid");
  for (const key of [
    "profileCreates",
    "profileAttachExisting",
    "profileAlreadyApplied",
    "profileUnavailable",
    "profileConflicts",
    "targetIssues",
    "invalidStoredProfiles",
  ]) {
    assert(Array.isArray(plan.operations[key]), `plan operations.${key} is invalid`);
  }
  assert(plan.summary.profileCreateCount === plan.operations.profileCreates.length, "plan profile create count does not match");
  assert(plan.summary.profileAttachExistingCount === plan.operations.profileAttachExisting.length, "plan profile attach-existing count does not match");
  assert(plan.summary.profileConflictCount === plan.operations.profileConflicts.length, "plan profile conflict count does not match");
  assert(plan.summary.targetIssueCount === plan.operations.targetIssues.length, "plan target issue count does not match");
  assert(plan.planSha256 === calculatePlanSha256(plan), "plan SHA does not match content");
  return plan;
}

export function planIsBlocked(plan) {
  return (
    plan.summary.profileConflictCount > 0 ||
    plan.summary.targetIssueCount > 0 ||
    plan.summary.invalidStoredProfileCount > 0
  );
}
