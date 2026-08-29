import crypto from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function without(value, key) {
  const { [key]: ignored, ...rest } = value;
  return rest;
}

export function calculateInvitationCompactionPlanSha256(plan) {
  return sha256(stableStringify(without(plan, "plan_sha256")));
}

export function calculateInvitationArchiveSha256(archive) {
  return sha256(stableStringify(without(archive, "archive_sha256")));
}

export function calculateInvitationArchiveReceiptSha256(receipt) {
  return sha256(stableStringify(without(receipt, "receipt_sha256")));
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.name === "string") return value.name;
  }
  return "";
}

function linkedRecordIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    if (typeof item === "string" && item) ids.push(item);
    if (item && typeof item === "object") {
      if (typeof item.record_id === "string" && item.record_id) ids.push(item.record_id);
      if (Array.isArray(item.record_ids)) {
        for (const recordId of item.record_ids) if (typeof recordId === "string" && recordId) ids.push(recordId);
      }
    }
  }
  return [...new Set(ids)];
}

function canonicalAvatarEvidence(values) {
  const byHash = new Map();
  for (const value of values ?? []) {
    assert(value && typeof value === "object", "avatar evidence is invalid");
    assert(/^[0-9a-f]{64}$/.test(String(value.sha256 ?? "")), "avatar SHA-256 is invalid");
    assert(Number.isSafeInteger(value.size) && value.size > 0, "avatar size is invalid");
    assert(typeof value.name === "string" && value.name && !/[\\/\0\r\n]/.test(value.name), "avatar name is invalid");
    assert(typeof value.mimeType === "string" && value.mimeType && !/[\r\n]/.test(value.mimeType), "avatar MIME type is invalid");
    const normalized = {
      sha256: value.sha256,
      size: value.size,
      name: value.name,
      mimeType: value.mimeType,
      ...(value.path === undefined ? {} : { path: value.path }),
    };
    const previous = byHash.get(normalized.sha256);
    if (previous) assert(previous.size === normalized.size, "avatar evidence with the same hash has inconsistent size");
    else byHash.set(normalized.sha256, normalized);
  }
  return [...byHash.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

export async function hydrateInvitationState(record, bindings, resolveAttachmentEvidence) {
  const recordId = String(record?.record_id ?? "");
  assert(recordId, "stored invitation state record ID is missing");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.creator.name]);
  assert(creatorIds.length === 1, `stored invitation state ${recordId} must link one creator`);
  const observedAtMs = Number(fields[bindings.observedAt.name]);
  assert(Number.isSafeInteger(observedAtMs) && observedAtMs > 0, `stored invitation state ${recordId} timestamp is invalid`);
  const state = textValue(fields[bindings.status.name]);
  assert(state, `stored invitation state ${recordId} status is missing`);
  const attachments = fields[bindings.avatar.name];
  assert(attachments === undefined || attachments === null || Array.isArray(attachments), `stored invitation state ${recordId} avatar field is invalid`);
  const evidence = [];
  for (const attachment of attachments ?? []) evidence.push(await resolveAttachmentEvidence(attachment));
  return {
    recordId,
    creatorRecordId: creatorIds[0],
    state,
    externalUserId: textValue(fields[bindings.externalUserId.name]).trim(),
    nickname: textValue(fields[bindings.nickname.name]).normalize("NFKC").trim(),
    observedAtMs,
    avatarEvidence: canonicalAvatarEvidence(evidence),
  };
}

function avatarHashes(state) {
  return state.avatarEvidence.map((item) => item.sha256);
}

export function invitationStateSignature(state) {
  return stableStringify({
    creator_record_id: state.creatorRecordId,
    state: state.state,
    external_user_id: state.externalUserId,
    nickname: state.nickname,
    avatar_sha256: avatarHashes(state),
  });
}

export function invitationRestoreSignature(state) {
  return stableStringify({
    observed_at_ms: state.observedAtMs,
    state_signature: invitationStateSignature(state),
  });
}

export function invitationCoreTimestampSignature(state) {
  return stableStringify({
    creator_record_id: state.creatorRecordId,
    state: state.state,
    external_user_id: state.externalUserId,
    nickname: state.nickname,
    observed_at_ms: state.observedAtMs,
  });
}

export function groupAdjacentInvitationStates(states) {
  const ordered = [...states].sort(
    (left, right) => left.observedAtMs - right.observedAtMs || left.recordId.localeCompare(right.recordId),
  );
  const groups = [];
  for (const state of ordered) {
    const current = groups.at(-1);
    if (current && invitationStateSignature(current.at(-1)) === invitationStateSignature(state)) current.push(state);
    else groups.push([state]);
  }
  return groups;
}

function identityConflicts(byCreator) {
  const conflicts = [];
  for (const [creatorRecordId, states] of byCreator) {
    const ids = [...new Set(states.map((state) => state.externalUserId).filter(Boolean))].sort();
    if (ids.length > 1) conflicts.push({ creator_record_id: creatorRecordId, external_user_ids: ids });
  }
  return conflicts;
}

function timestampConflicts(byCreator) {
  const conflicts = [];
  for (const [creatorRecordId, states] of byCreator) {
    const byTimestamp = new Map();
    for (const state of states) {
      const rows = byTimestamp.get(state.observedAtMs) ?? [];
      rows.push(state);
      byTimestamp.set(state.observedAtMs, rows);
    }
    for (const [observedAtMs, rows] of byTimestamp) {
      if (new Set(rows.map(invitationStateSignature)).size > 1) {
        conflicts.push({
          creator_record_id: creatorRecordId,
          observed_at_ms: observedAtMs,
          record_ids: rows.map((row) => row.recordId).sort(),
        });
      }
    }
  }
  return conflicts.sort(
    (left, right) => left.creator_record_id.localeCompare(right.creator_record_id) || left.observed_at_ms - right.observed_at_ms,
  );
}

function stateSnapshot(state) {
  return {
    record_id: state.recordId,
    creator_record_id: state.creatorRecordId,
    state: state.state,
    external_user_id: state.externalUserId,
    nickname: state.nickname,
    observed_at_ms: state.observedAtMs,
    avatars: state.avatarEvidence,
  };
}

function deletedRecord(state) {
  return {
    original_record_id: state.recordId,
    restore_key: sha256(invitationRestoreSignature(state)),
    values: {
      creator_record_id: state.creatorRecordId,
      state: state.state,
      external_user_id: state.externalUserId,
      nickname: state.nickname,
      observed_at_ms: state.observedAtMs,
      avatars: state.avatarEvidence,
    },
  };
}

export async function buildInvitationCompactionPlan({
  records,
  bindings,
  source,
  builtAtMs = Date.now(),
  resolveAttachmentEvidence,
}) {
  assert(Array.isArray(records), "invitation-state records must be an array");
  assert(Number.isSafeInteger(builtAtMs), "builtAtMs is invalid");
  const hydrated = [];
  const invalidRecords = [];
  for (const record of records) {
    try {
      hydrated.push(await hydrateInvitationState(record, bindings, resolveAttachmentEvidence));
    } catch (error) {
      invalidRecords.push({ record_id: String(record?.record_id ?? ""), reason: error.message });
    }
  }
  hydrated.sort((left, right) => left.recordId.localeCompare(right.recordId));
  invalidRecords.sort((left, right) => left.record_id.localeCompare(right.record_id));
  const byCreator = new Map();
  for (const state of hydrated) {
    const rows = byCreator.get(state.creatorRecordId) ?? [];
    rows.push(state);
    byCreator.set(state.creatorRecordId, rows);
  }
  const idConflicts = identityConflicts(byCreator);
  const timeConflicts = timestampConflicts(byCreator);
  const blockedCreators = new Set([
    ...idConflicts.map((item) => item.creator_record_id),
    ...timeConflicts.map((item) => item.creator_record_id),
  ]);
  const operations = [];
  for (const [creatorRecordId, states] of byCreator) {
    if (blockedCreators.has(creatorRecordId)) continue;
    for (const group of groupAdjacentInvitationStates(states)) {
      if (group.length < 2) continue;
      const keep = group.at(-1);
      const deleted = group.slice(0, -1);
      operations.push({
        creator_record_id: creatorRecordId,
        keep_record_id: keep.recordId,
        first_observed_at_ms: group[0].observedAtMs,
        last_observed_at_ms: keep.observedAtMs,
        signature_sha256: sha256(invitationStateSignature(keep)),
        delete_record_ids: deleted.map((state) => state.recordId),
        deleted_records: deleted.map(deletedRecord),
      });
    }
  }
  operations.sort(
    (left, right) => left.creator_record_id.localeCompare(right.creator_record_id) || left.first_observed_at_ms - right.first_observed_at_ms,
  );
  const deleteCount = operations.reduce((sum, operation) => sum + operation.delete_record_ids.length, 0);
  const sourceSnapshot = hydrated.map(stateSnapshot);
  const unsigned = {
    version: 1,
    plan_type: "creator-invitation-status-compaction",
    built_at: new Date(builtAtMs).toISOString(),
    built_at_ms: builtAtMs,
    source,
    source_sha256: sha256(stableStringify(sourceSnapshot)),
    source_snapshot: sourceSnapshot,
    invalid_records: invalidRecords,
    identity_conflicts: idConflicts,
    timestamp_conflicts: timeConflicts,
    operations,
    summary: {
      live_record_count: records.length,
      valid_record_count: hydrated.length,
      operation_count: operations.length,
      delete_candidate_count: deleteCount,
      keep_count: records.length - deleteCount,
      affected_creator_count: new Set(operations.map((item) => item.creator_record_id)).size,
      invalid_record_count: invalidRecords.length,
      identity_conflict_count: idConflicts.length,
      timestamp_conflict_count: timeConflicts.length,
      blocking_issue_count: invalidRecords.length + idConflicts.length + timeConflicts.length,
    },
  };
  return { ...unsigned, plan_sha256: calculateInvitationCompactionPlanSha256(unsigned) };
}

export function validateInvitationCompactionPlan(plan) {
  assert(plan?.version === 1 && plan?.plan_type === "creator-invitation-status-compaction", "invitation compaction plan is invalid");
  assert(Array.isArray(plan.source_snapshot) && Array.isArray(plan.operations), "invitation compaction plan arrays are invalid");
  assert(plan.source_sha256 === sha256(stableStringify(plan.source_snapshot)), "invitation compaction source SHA does not match");
  assert(plan.plan_sha256 === calculateInvitationCompactionPlanSha256(plan), "invitation compaction plan SHA does not match");
  const deleteIds = plan.operations.flatMap((operation) => operation.delete_record_ids ?? []);
  const keepIds = new Set(plan.operations.map((operation) => operation.keep_record_id));
  for (const operation of plan.operations) {
    assert(Array.isArray(operation.delete_record_ids) && Array.isArray(operation.deleted_records), "invitation compaction operation is invalid");
    assert(operation.delete_record_ids.length === operation.deleted_records.length, "invitation compaction operation backup count does not match");
    assert(operation.deleted_records.every((record, index) => record.original_record_id === operation.delete_record_ids[index]), "invitation compaction operation backup order does not match");
  }
  assert(new Set(deleteIds).size === deleteIds.length, "invitation compaction delete IDs are duplicated");
  assert(!deleteIds.some((recordId) => keepIds.has(recordId)), "invitation compaction plan deletes a keeper");
  assert(plan.summary?.delete_candidate_count === deleteIds.length, "invitation compaction delete count does not match");
  assert(plan.summary.keep_count === plan.summary.live_record_count - deleteIds.length, "invitation compaction keep count does not match");
  assert(plan.summary.operation_count === plan.operations.length, "invitation compaction operation count does not match");
  assert(plan.summary.invalid_record_count === plan.invalid_records?.length, "invitation compaction invalid count does not match");
  assert(plan.summary.identity_conflict_count === plan.identity_conflicts?.length, "invitation compaction identity conflict count does not match");
  assert(plan.summary.timestamp_conflict_count === plan.timestamp_conflicts?.length, "invitation compaction timestamp conflict count does not match");
  assert(
    plan.summary.blocking_issue_count ===
      plan.summary.invalid_record_count + plan.summary.identity_conflict_count + plan.summary.timestamp_conflict_count,
    "invitation compaction blocking count does not match",
  );
  return plan;
}

export function invitationCompactionPlanIsBlocked(plan) {
  validateInvitationCompactionPlan(plan);
  return plan.summary.blocking_issue_count > 0;
}

function setIsSubset(subset, superset) {
  const values = new Set(superset);
  return subset.every((value) => values.has(value));
}

function archivedState(record) {
  return {
    recordId: record.original_record_id,
    creatorRecordId: record.values.creator_record_id,
    state: record.values.state,
    externalUserId: record.values.external_user_id,
    nickname: record.values.nickname,
    observedAtMs: record.values.observed_at_ms,
    avatarEvidence: record.values.avatars.map((avatar) => ({
      sha256: avatar.sha256,
      size: avatar.size,
      name: avatar.name,
      mimeType: avatar.mimeType,
    })),
  };
}

export function inspectInvitationRestore(archive, currentStates) {
  assert(Array.isArray(archive?.records), "invitation restore archive records are invalid");
  const byTimestamp = new Map();
  for (const state of currentStates) {
    const key = `${state.creatorRecordId}:${state.observedAtMs}`;
    const rows = byTimestamp.get(key) ?? [];
    rows.push(state);
    byTimestamp.set(key, rows);
  }
  const creates = [];
  const attachments = [];
  const alreadyRestored = [];
  const conflicts = [];
  for (const record of archive.records) {
    const desired = archivedState(record);
    const rows = byTimestamp.get(`${desired.creatorRecordId}:${desired.observedAtMs}`) ?? [];
    const exact = rows.filter((row) => invitationRestoreSignature(row) === invitationRestoreSignature(desired));
    if (exact.length === 1) {
      alreadyRestored.push({ restore_key: record.restore_key, record_id: exact[0].recordId });
      continue;
    }
    if (exact.length > 1) {
      conflicts.push({ restore_key: record.restore_key, reason: "duplicate_exact_live_records" });
      continue;
    }
    const core = rows.filter(
      (row) => invitationCoreTimestampSignature(row) === invitationCoreTimestampSignature(desired),
    );
    if (core.length === 1) {
      const currentHashes = avatarHashes(core[0]);
      const desiredHashes = avatarHashes(desired);
      if (!setIsSubset(currentHashes, desiredHashes)) {
        conflicts.push({ restore_key: record.restore_key, reason: "existing_avatar_content_differs" });
        continue;
      }
      attachments.push({
        restore_key: record.restore_key,
        record_id: core[0].recordId,
        missing_avatar_sha256: desiredHashes.filter((value) => !currentHashes.includes(value)),
      });
      continue;
    }
    if (core.length > 1 || rows.length) {
      conflicts.push({ restore_key: record.restore_key, reason: core.length > 1 ? "duplicate_core_live_records" : "timestamp_content_conflict" });
      continue;
    }
    creates.push(record);
  }
  return {
    status: conflicts.length ? "blocked" : creates.length || attachments.some((item) => item.missing_avatar_sha256.length) ? "ready" : "unchanged",
    create_count: creates.length,
    attachment_record_count: attachments.filter((item) => item.missing_avatar_sha256.length).length,
    already_restored_count: alreadyRestored.length,
    conflict_count: conflicts.length,
    creates,
    attachments,
    already_restored: alreadyRestored,
    conflicts,
  };
}
