import { validateInvitationObservations } from "@live-agency-skills/source-provider-api";

export function normalizeAccountKey(value) {
  let normalized = String(value).normalize("NFKC").trim();
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  return normalized.toLocaleLowerCase("und");
}

function canonicalHashes(values) {
  return [...new Set((values ?? []).map(String).filter(Boolean))].sort();
}

export function validateTargetManifest(manifest) {
  if (manifest?.version !== 1 || !["due", "selected", "all"].includes(manifest.targetMode)) {
    throw new TypeError("target manifest format is invalid");
  }
  if (!Array.isArray(manifest.rows) || manifest.rowCount !== manifest.rows.length) {
    throw new TypeError("target manifest row count is invalid");
  }
  const seenAccounts = new Set();
  const seenRecords = new Set();
  for (const [index, row] of manifest.rows.entries()) {
    const accountKey = normalizeAccountKey(row.accountKey);
    if (!accountKey) throw new TypeError(`target ${index} accountKey is invalid`);
    if (seenAccounts.has(accountKey)) throw new TypeError(`target account is duplicated: ${accountKey}`);
    if (typeof row.creatorRecordId !== "string" || !row.creatorRecordId) {
      throw new TypeError(`target ${index} creatorRecordId is invalid`);
    }
    if (seenRecords.has(row.creatorRecordId)) {
      throw new TypeError(`target creatorRecordId is duplicated: ${row.creatorRecordId}`);
    }
    seenAccounts.add(accountKey);
    seenRecords.add(row.creatorRecordId);
  }
  return manifest;
}

export function normalizeObservations(raw, manifest) {
  const observations = validateInvitationObservations(raw);
  const target = validateTargetManifest(manifest);
  const targetsByAccount = new Map(
    target.rows.map((row) => [normalizeAccountKey(row.accountKey), row]),
  );
  const seen = new Set();
  const creators = observations.creators.map((creator) => {
    const accountKey = normalizeAccountKey(creator.accountKey);
    if (!accountKey || seen.has(accountKey)) {
      throw new TypeError(`observed account is invalid or duplicated: ${creator.accountKey}`);
    }
    seen.add(accountKey);
    const targetRow = targetsByAccount.get(accountKey);
    if (!targetRow) throw new TypeError(`observation contains an unrequested account: ${accountKey}`);
    return {
      creatorRecordId: targetRow.creatorRecordId,
      accountKey,
      state: creator.state,
      externalUserId: creator.externalUserId?.trim() ?? "",
      nickname: creator.nickname?.normalize("NFKC").trim() ?? "",
      observedAtMs: Date.parse(observations.observedAt),
      avatar: creator.avatar ?? null,
      avatarHashes: creator.avatar ? [creator.avatar.sha256] : [],
    };
  });
  const missing = [...targetsByAccount.keys()].filter((accountKey) => !seen.has(accountKey));
  if (missing.length) throw new TypeError(`observations are missing requested accounts: ${missing.join(", ")}`);
  return { ...observations, creators };
}

export function stateCoreSignature(state) {
  return JSON.stringify([
    String(state.creatorRecordId ?? ""),
    String(state.state ?? ""),
    String(state.externalUserId ?? "").trim(),
    String(state.nickname ?? "").normalize("NFKC").trim(),
  ]);
}

export function stateSignature(state) {
  return JSON.stringify([stateCoreSignature(state), canonicalHashes(state.avatarHashes)]);
}

export function statesEqual(left, right) {
  return stateSignature(left) === stateSignature(right);
}

export function groupConsecutiveStates(states) {
  const ordered = [...states].sort(
    (left, right) => left.observedAtMs - right.observedAtMs || left.recordId.localeCompare(right.recordId),
  );
  const groups = [];
  for (const state of ordered) {
    const current = groups.at(-1);
    if (current && statesEqual(current.at(-1), state)) current.push(state);
    else groups.push([state]);
  }
  return groups;
}

export async function hydrateStoredState(record, bindings, resolveAttachmentHash) {
  const linked = record.fields?.[bindings.creator.name];
  const creatorIds = Array.isArray(linked)
    ? [...new Set(linked.flatMap((item) => item?.record_ids ?? []).map(String))]
    : [];
  const timestamp = Number(record.fields?.[bindings.observedAt.name]);
  if (creatorIds.length !== 1 || !Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new TypeError(`stored state is invalid: ${record.record_id ?? "unknown"}`);
  }
  const attachments = Array.isArray(record.fields?.[bindings.avatar.name])
    ? record.fields[bindings.avatar.name]
    : [];
  const avatarHashes = [];
  for (const attachment of attachments) avatarHashes.push(await resolveAttachmentHash(attachment));
  return {
    recordId: String(record.record_id ?? ""),
    creatorRecordId: creatorIds[0],
    state: String(record.fields?.[bindings.status.name] ?? ""),
    externalUserId: String(record.fields?.[bindings.externalUserId.name] ?? "").trim(),
    nickname: String(record.fields?.[bindings.nickname.name] ?? "").normalize("NFKC").trim(),
    observedAtMs: timestamp,
    avatarHashes: canonicalHashes(avatarHashes),
  };
}

export async function buildRefreshPlan({ observations, manifest, storedRecords, bindings, resolveAttachmentHash }) {
  const normalized = normalizeObservations(observations, manifest);
  const stored = [];
  const invalidStored = [];
  for (const record of storedRecords) {
    try {
      stored.push(await hydrateStoredState(record, bindings, resolveAttachmentHash));
    } catch (error) {
      invalidStored.push({ recordId: String(record?.record_id ?? ""), reason: error.message });
    }
  }
  const byCreator = new Map();
  for (const state of stored) {
    const rows = byCreator.get(state.creatorRecordId) ?? [];
    rows.push(state);
    byCreator.set(state.creatorRecordId, rows);
  }

  const plan = {
    observedAt: normalized.observedAt,
    rowCount: normalized.rowCount,
    creates: [],
    updates: [],
    attachExisting: [],
    alreadyApplied: [],
    identityConflicts: [],
    ambiguousLatest: [],
    staleObservations: [],
    invalidStored,
  };
  for (const desired of normalized.creators) {
    const history = [...(byCreator.get(desired.creatorRecordId) ?? [])].sort(
      (left, right) => left.observedAtMs - right.observedAtMs || left.recordId.localeCompare(right.recordId),
    );
    const knownIds = new Set(history.map((state) => state.externalUserId).filter(Boolean));
    if (desired.externalUserId && [...knownIds].some((value) => value !== desired.externalUserId)) {
      plan.identityConflicts.push({
        accountKey: desired.accountKey,
        observedExternalUserId: desired.externalUserId,
        knownExternalUserIds: [...knownIds].sort(),
      });
      continue;
    }
    const exactTime = history.filter((state) => state.observedAtMs === desired.observedAtMs);
    if (exactTime.length) {
      if (exactTime.length === 1 && statesEqual(exactTime[0], desired)) {
        plan.alreadyApplied.push({ ...desired, recordId: exactTime[0].recordId });
      } else if (
        exactTime.length === 1 &&
        stateCoreSignature(exactTime[0]) === stateCoreSignature(desired) &&
        desired.avatar &&
        exactTime[0].avatarHashes.length === 0
      ) {
        plan.attachExisting.push({ ...desired, recordId: exactTime[0].recordId });
      } else {
        plan.staleObservations.push({ accountKey: desired.accountKey, reason: "timestamp collision" });
      }
      continue;
    }
    const latestTimestamp = history.at(-1)?.observedAtMs;
    const latest = history.filter((state) => state.observedAtMs === latestTimestamp);
    if (latest.length > 1) {
      if (new Set(latest.map(stateSignature)).size > 1) {
        plan.ambiguousLatest.push({
          accountKey: desired.accountKey,
          recordIds: latest.map((state) => state.recordId),
        });
        continue;
      }
    }
    if (latestTimestamp !== undefined && desired.observedAtMs <= latestTimestamp) {
      plan.staleObservations.push({ accountKey: desired.accountKey, reason: "not newer than history" });
      continue;
    }
    const latestState = latest.at(-1);
    if (!latestState) plan.creates.push(desired);
    else if (statesEqual(latestState, desired)) {
      plan.updates.push({ ...desired, recordId: latestState.recordId, beforeObservedAtMs: latestTimestamp });
    } else plan.creates.push(desired);
  }
  return plan;
}

export function hasBlockingRefreshIssues(plan) {
  return Boolean(
    plan.identityConflicts.length ||
      plan.ambiguousLatest.length ||
      plan.staleObservations.length ||
      plan.invalidStored.length,
  );
}
