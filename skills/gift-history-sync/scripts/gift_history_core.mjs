import { createHash } from "node:crypto";

import { validateGiftHistorySnapshot } from "@live-agency-skills/source-provider-api";

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

function assertCalendarDate(value, label) {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), `${label} is invalid`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  assert(
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day,
    `${label} is invalid`,
  );
}

function normalizeEvent(event, label) {
  assert(event && typeof event === "object" && !Array.isArray(event), `${label} is invalid`);
  for (const key of ["eventKey", "accountKey", "occurredAt", "amount", "recipientKey"]) {
    assert(typeof event[key] === "string" && event[key], `${label}.${key} is invalid`);
  }
  assert(!/[\t\r\n]/.test(event.eventKey), `${label}.eventKey contains control characters`);
  assert(!/[\t\r\n]/.test(event.accountKey), `${label}.accountKey contains control characters`);
  assert(!/[\t\r\n]/.test(event.recipientKey), `${label}.recipientKey contains control characters`);
  const occurredAtMs = Date.parse(event.occurredAt);
  assert(Number.isFinite(occurredAtMs), `${label}.occurredAt is invalid`);
  assert(/^(?:0|[1-9]\d*)$/.test(event.amount), `${label}.amount is invalid`);
  return {
    eventKey: event.eventKey,
    accountKey: normalizeAccountKey(event.accountKey),
    occurredAt: new Date(occurredAtMs).toISOString(),
    occurredAtMs,
    amount: event.amount,
    recipientKey: event.recipientKey.normalize("NFKC").trim(),
  };
}

export function validateGiftMaster(master) {
  assert(master?.version === 1, "gift master version is invalid");
  assert(Array.isArray(master.events), "gift master events must be an array");
  assert(Array.isArray(master.syncLog), "gift master syncLog must be an array");
  const eventKeys = new Set();
  const events = master.events.map((event, index) => {
    const normalized = normalizeEvent(event, `gift master event ${index}`);
    assert(normalized.accountKey, `gift master event ${index}.accountKey is invalid`);
    assert(normalized.recipientKey, `gift master event ${index}.recipientKey is invalid`);
    assert(!eventKeys.has(normalized.eventKey), `gift master eventKey is duplicated: ${normalized.eventKey}`);
    eventKeys.add(normalized.eventKey);
    return normalized;
  });
  const syncLog = master.syncLog.map((entry, index) => {
    assert(entry && typeof entry === "object", `gift master syncLog ${index} is invalid`);
    const accountKey = normalizeAccountKey(entry.accountKey);
    assert(accountKey, `gift master syncLog ${index}.accountKey is invalid`);
    assertCalendarDate(entry.snapshotDate, `gift master syncLog ${index}.snapshotDate`);
    assert(/^[0-9a-f]{64}$/.test(entry.sourceSha256 ?? ""), `gift master syncLog ${index}.sourceSha256 is invalid`);
    assert(["success", "unchanged"].includes(entry.status), `gift master syncLog ${index}.status is invalid`);
    return { accountKey, snapshotDate: entry.snapshotDate, sourceSha256: entry.sourceSha256, status: entry.status };
  });
  return { version: 1, events, syncLog };
}

function compatible(existing, incoming) {
  return (
    existing.accountKey === incoming.accountKey &&
    existing.occurredAtMs === incoming.occurredAtMs &&
    existing.amount === incoming.amount
  );
}

function sortEvents(events) {
  return [...events].sort(
    (left, right) =>
      left.occurredAtMs - right.occurredAtMs ||
      left.accountKey.localeCompare(right.accountKey) ||
      left.eventKey.localeCompare(right.eventKey),
  );
}

function publicEvent(event) {
  return {
    eventKey: event.eventKey,
    accountKey: event.accountKey,
    occurredAt: event.occurredAt,
    amount: event.amount,
    recipientKey: event.recipientKey,
  };
}

function buildSummary(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.recipientKey, event.accountKey]);
    let group = groups.get(key);
    if (!group) {
      group = {
        recipientKey: event.recipientKey,
        accountKey: event.accountKey,
        amount: 0n,
        firstAt: event.occurredAt,
        lastAt: event.occurredAt,
        firstAtMs: event.occurredAtMs,
        lastAtMs: event.occurredAtMs,
      };
      groups.set(key, group);
    }
    group.amount += BigInt(event.amount);
    if (event.occurredAtMs < group.firstAtMs) {
      group.firstAtMs = event.occurredAtMs;
      group.firstAt = event.occurredAt;
    }
    if (event.occurredAtMs > group.lastAtMs) {
      group.lastAtMs = event.occurredAtMs;
      group.lastAt = event.occurredAt;
    }
  }
  return [...groups.values()].map((group) => ({
    recipientKey: group.recipientKey,
    accountKey: group.accountKey,
    amount: group.amount.toString(),
    firstAt: group.firstAt,
    lastAt: group.lastAt,
  }));
}

function totalAmount(events) {
  return events.reduce((sum, event) => sum + BigInt(event.amount), 0n).toString();
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export function buildGiftHistoryPlan({
  master,
  snapshot,
  allowSameDateReplacement = false,
  nowMs = Date.now(),
}) {
  const normalizedMaster = validateGiftMaster(master);
  validateGiftHistorySnapshot(snapshot);
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  const accountKey = normalizeAccountKey(snapshot.accountKey);
  assert(accountKey, "snapshot accountKey is invalid after normalization");
  const incoming = snapshot.events.map((event, index) => {
    const normalized = normalizeEvent(event, `gift-history snapshot event ${index}`);
    assert(normalized.accountKey === accountKey, `snapshot event ${index} accountKey changed after normalization`);
    return normalized;
  });
  const successful = normalizedMaster.syncLog.filter((entry) => entry.accountKey === accountKey);
  const sameDate = successful.filter((entry) => entry.snapshotDate === snapshot.snapshotDate);
  const sameDigest = sameDate.some((entry) => entry.sourceSha256 === snapshot.sourceSha256);
  const latestDate = successful.reduce(
    (latest, entry) => latest === null || entry.snapshotDate > latest ? entry.snapshotDate : latest,
    null,
  );
  const blockingIssues = [];
  let mode;
  if (sameDigest) mode = "unchanged";
  else if (sameDate.length && !allowSameDateReplacement) {
    mode = "same-date-conflict";
    blockingIssues.push({ reason: "same_date_source_differs", accountKey, snapshotDate: snapshot.snapshotDate });
  } else if (sameDate.length) mode = "same-date-replacement";
  else if (latestDate === null || snapshot.snapshotDate > latestDate) mode = "newer";
  else mode = "backfill";

  const merged = new Map(normalizedMaster.events.map((event) => [event.eventKey, event]));
  const additions = [];
  const recipientUpdates = [];
  const commonUnchanged = [];
  const usernameEvidence = [];
  if (mode !== "unchanged" && mode !== "same-date-conflict") {
    for (const event of incoming) {
      const existing = merged.get(event.eventKey);
      if (!existing) {
        merged.set(event.eventKey, event);
        additions.push(publicEvent(event));
        continue;
      }
      if (!compatible(existing, event)) {
        blockingIssues.push({ reason: "incompatible_event_key_reuse", eventKey: event.eventKey });
        continue;
      }
      if (existing.recipientKey === event.recipientKey) {
        commonUnchanged.push(event.eventKey);
        continue;
      }
      const evidence = {
        eventKey: event.eventKey,
        accountKey,
        occurredAt: event.occurredAt,
        oldRecipientKey: existing.recipientKey,
        observedRecipientKey: event.recipientKey,
        currentEvidence: mode !== "backfill",
      };
      usernameEvidence.push(evidence);
      if (mode === "newer" || mode === "same-date-replacement") {
        merged.set(event.eventKey, event);
        recipientUpdates.push(evidence);
      } else commonUnchanged.push(event.eventKey);
    }
  }

  const events = sortEvents(merged.values());
  const publicEvents = events.map(publicEvent);
  const summaryRows = buildSummary(events);
  const incomingKeys = new Set(incoming.map((event) => event.eventKey));
  const retainedMasterOnlyCount = normalizedMaster.events.filter(
    (event) => !incomingKeys.has(event.eventKey),
  ).length;
  const unsigned = {
    version: 1,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    mode,
    allowSameDateReplacement,
    inputs: {
      masterSha256: sha256Json({
        version: 1,
        events: normalizedMaster.events.map(publicEvent),
        syncLog: normalizedMaster.syncLog,
      }),
      snapshot,
    },
    operations: {
      additions,
      recipientUpdates,
      commonUnchanged,
      retainedMasterOnlyCount,
      blockingIssues,
    },
    target: { events: publicEvents, summaryRows },
    evidence: { usernameChanges: usernameEvidence },
    summary: {
      masterRowCount: normalizedMaster.events.length,
      sourceRowCount: snapshot.rowCount,
      targetRowCount: publicEvents.length,
      additionCount: additions.length,
      recipientUpdateCount: recipientUpdates.length,
      commonUnchangedCount: commonUnchanged.length,
      retainedMasterOnlyCount,
      usernameEvidenceCount: usernameEvidence.length,
      blockingIssueCount: blockingIssues.length,
      masterAmount: totalAmount(normalizedMaster.events),
      sourceAmount: totalAmount(incoming),
      targetAmount: totalAmount(events),
    },
  };
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function validateGiftHistoryPlan(plan) {
  assert(plan?.version === 1, "gift-history plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "gift-history plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "gift-history plan timestamps do not match");
  assert(plan.operations && plan.target && plan.summary, "gift-history plan structure is invalid");
  for (const key of ["additions", "recipientUpdates", "commonUnchanged", "blockingIssues"]) {
    assert(Array.isArray(plan.operations[key]), `gift-history plan operations.${key} is invalid`);
  }
  assert(Array.isArray(plan.target.events), "gift-history plan target.events is invalid");
  assert(Array.isArray(plan.target.summaryRows), "gift-history plan target.summaryRows is invalid");
  assert(plan.summary.targetRowCount === plan.target.events.length, "gift-history plan target row count differs");
  assert(plan.summary.additionCount === plan.operations.additions.length, "gift-history plan addition count differs");
  assert(plan.summary.recipientUpdateCount === plan.operations.recipientUpdates.length, "gift-history plan update count differs");
  assert(plan.summary.blockingIssueCount === plan.operations.blockingIssues.length, "gift-history plan issue count differs");
  assert(plan.planSha256 === calculatePlanSha256(plan), "gift-history plan SHA does not match content");
  return plan;
}

export function giftPlanIsBlocked(plan) {
  return plan.summary.blockingIssueCount > 0;
}

export function replayGiftHistoryPlan({ master, reviewedPlan }) {
  validateGiftHistoryPlan(reviewedPlan);
  return buildGiftHistoryPlan({
    master,
    snapshot: reviewedPlan.inputs.snapshot,
    allowSameDateReplacement: reviewedPlan.allowSameDateReplacement,
    nowMs: reviewedPlan.builtAtMs,
  });
}
