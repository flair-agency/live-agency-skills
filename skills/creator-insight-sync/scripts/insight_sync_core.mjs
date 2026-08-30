import { createHash } from "node:crypto";

export const INSIGHT_CONTEXT_KIND =
  "application/vnd.live-agency.creator-insight-context+json";
export const INSIGHT_PROPOSAL_KIND =
  "application/vnd.live-agency.creator-insight-proposals+json";
export const INSIGHT_RULE_VERSION = "creator-live-characteristics/v1";

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

function contextContent(context) {
  return {
    version: context.version,
    inputKind: context.inputKind,
    approvedTraits: context.approvedTraits,
    rowCount: context.rowCount,
    rows: context.rows,
  };
}

export function calculateContextSha256(context) {
  return sha256Json(contextContent(context));
}

export function validateInsightContext(context) {
  assert(context?.version === 1, "insight context version is invalid");
  assert(context.inputKind === INSIGHT_CONTEXT_KIND, "insight context inputKind is invalid");
  assert(!Number.isNaN(Date.parse(context.generatedAt)), "insight context generatedAt is invalid");
  assert(Array.isArray(context.approvedTraits), "insight context approvedTraits must be an array");
  const approved = [...new Set(context.approvedTraits)];
  assert(approved.length === context.approvedTraits.length, "insight context approvedTraits are duplicated");
  assert(approved.every((value) => typeof value === "string" && value.trim()), "insight context approvedTraits are invalid");
  assert(Array.isArray(context.rows), "insight context rows must be an array");
  assert(context.rowCount === context.rows.length, "insight context rowCount does not match");
  const creatorIds = new Set();
  const accounts = new Set();
  for (const [index, row] of context.rows.entries()) {
    const label = `insight context row ${index}`;
    assert(isRecordId(row.creatorRecordId), `${label} creatorRecordId is invalid`);
    const accountKey = normalizeAccountKey(row.accountKey);
    assert(accountKey, `${label} accountKey is invalid`);
    assert(!creatorIds.has(row.creatorRecordId), `${label} creatorRecordId is duplicated`);
    assert(!accounts.has(accountKey), `${label} accountKey is duplicated`);
    creatorIds.add(row.creatorRecordId);
    accounts.add(accountKey);
    assert(typeof row.currentInsight === "string", `${label} currentInsight must be text`);
    assert(Array.isArray(row.currentTraits), `${label} currentTraits must be an array`);
    assert(row.currentTraits.every((trait) => approved.includes(trait)), `${label} currentTraits contain an unapproved value`);
    assert(["ready", "missing_profile", "invalid_profile"].includes(row.readiness), `${label} readiness is invalid`);
    if (row.latestProfile !== null) {
      assert(isRecordId(row.latestProfile.recordId), `${label} latestProfile recordId is invalid`);
      assert(!Number.isNaN(Date.parse(row.latestProfile.observedAt)), `${label} latestProfile observedAt is invalid`);
      assert(
        row.latestProfile.featureObservationData &&
        typeof row.latestProfile.featureObservationData === "object" &&
        !Array.isArray(row.latestProfile.featureObservationData),
        `${label} featureObservationData is invalid`,
      );
    }
    if (row.latestLiveMetric !== null) {
      assert(isRecordId(row.latestLiveMetric.recordId), `${label} latestLiveMetric recordId is invalid`);
      assert(!Number.isNaN(Date.parse(row.latestLiveMetric.measuredAt)), `${label} latestLiveMetric measuredAt is invalid`);
      if (row.latestLiveMetric.fanClub !== null) {
        assert(Number.isSafeInteger(row.latestLiveMetric.fanClub) && row.latestLiveMetric.fanClub >= 0, `${label} latestLiveMetric fanClub is invalid`);
      }
      for (const key of ["liveDays30d", "liveHours30d", "likes30d"]) {
        assert(typeof row.latestLiveMetric[key] === "number" && row.latestLiveMetric[key] >= 0, `${label} latestLiveMetric ${key} is invalid`);
      }
      if (row.latestLiveMetric.latestLiveAt !== null) {
        assert(!Number.isNaN(Date.parse(row.latestLiveMetric.latestLiveAt)), `${label} latestLiveAt is invalid`);
      }
    }
  }
  assert(/^[0-9a-f]{64}$/.test(context.contextSha256 ?? ""), "insight context SHA is invalid");
  assert(context.contextSha256 === calculateContextSha256(context), "insight context SHA does not match content");
  return context;
}

function jsonPointerExists(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.length > 500) return false;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(key)) return false;
    if (!current || typeof current !== "object" || !(key in current)) return false;
    current = current[key];
  }
  return true;
}

export function validateInsightProposals(proposals, context) {
  validateInsightContext(context);
  assert(proposals?.version === 1, "insight proposals version is invalid");
  assert(proposals.inputKind === INSIGHT_PROPOSAL_KIND, "insight proposals inputKind is invalid");
  assert(proposals.ruleVersion === INSIGHT_RULE_VERSION, "insight proposals ruleVersion is invalid");
  assert(proposals.contextSha256 === context.contextSha256, "insight proposals context SHA does not match");
  assert(!Number.isNaN(Date.parse(proposals.generatedAt)), "insight proposals generatedAt is invalid");
  assert(Array.isArray(proposals.proposals), "insight proposals must be an array");
  assert(proposals.rowCount === proposals.proposals.length, "insight proposal rowCount does not match");
  assert(proposals.rowCount === context.rowCount, "insight proposals must cover every context row");
  const contextById = new Map(context.rows.map((row) => [row.creatorRecordId, row]));
  const seen = new Set();
  for (const [index, proposal] of proposals.proposals.entries()) {
    const label = `insight proposal ${index}`;
    assert(isRecordId(proposal.creatorRecordId), `${label} creatorRecordId is invalid`);
    assert(contextById.has(proposal.creatorRecordId), `${label} creatorRecordId is outside context`);
    assert(!seen.has(proposal.creatorRecordId), `${label} creatorRecordId is duplicated`);
    seen.add(proposal.creatorRecordId);
    const row = contextById.get(proposal.creatorRecordId);
    assert(["proposed", "insufficient_evidence"].includes(proposal.status), `${label} status is invalid`);
    if (row.readiness !== "ready") {
      assert(proposal.status === "insufficient_evidence", `${label} cannot propose from an unready context`);
    }
    if (proposal.status === "insufficient_evidence") {
      assert(proposal.insight === null, `${label} insufficient insight must be null`);
      assert(Array.isArray(proposal.traits) && proposal.traits.length === 0, `${label} insufficient traits must be empty`);
      assert(typeof proposal.reason === "string" && proposal.reason.trim(), `${label} insufficient reason is required`);
      continue;
    }
    assert(typeof proposal.insight === "string" && proposal.insight.trim(), `${label} insight is required`);
    assert(proposal.insight.length <= 1000, `${label} insight exceeds 1000 characters`);
    assert(Array.isArray(proposal.traits), `${label} traits must be an array`);
    assert(new Set(proposal.traits).size === proposal.traits.length, `${label} traits are duplicated`);
    assert(proposal.traits.every((trait) => context.approvedTraits.includes(trait)), `${label} contains an unapproved trait`);
    assert(proposal.evidence && typeof proposal.evidence === "object", `${label} evidence is required`);
    assert(proposal.evidence.profileRecordId === row.latestProfile?.recordId, `${label} profile evidence is not latest`);
    assert(
      proposal.evidence.liveMetricRecordId === (row.latestLiveMetric?.recordId ?? null),
      `${label} LIVE metric evidence is not latest`,
    );
    assert(Array.isArray(proposal.evidence.profilePaths) && proposal.evidence.profilePaths.length > 0, `${label} profile evidence paths are required`);
    assert(
      proposal.evidence.profilePaths.every((pointer) => jsonPointerExists(row.latestProfile.featureObservationData, pointer)),
      `${label} profile evidence path does not exist`,
    );
    const allowedMetricFields = new Set(["fanClub", "latestLiveAt", "liveDays30d", "liveHours30d", "likes30d"]);
    assert(Array.isArray(proposal.evidence.liveMetricFields), `${label} liveMetricFields must be an array`);
    assert(proposal.evidence.liveMetricFields.every((field) => allowedMetricFields.has(field)), `${label} liveMetricFields are invalid`);
    if (!row.latestLiveMetric) {
      assert(proposal.evidence.liveMetricFields.length === 0, `${label} cannot cite missing LIVE metrics`);
    }
    assert(["low", "medium", "high"].includes(proposal.evidence.confidence), `${label} confidence is invalid`);
  }
  return proposals;
}

function currentRowSignature(row) {
  return {
    creatorRecordId: row.creatorRecordId,
    accountKey: normalizeAccountKey(row.accountKey),
    currentInsight: row.currentInsight,
    currentTraits: [...row.currentTraits].sort(),
  };
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export function buildInsightPlan({ context, proposals, currentContext, nowMs = Date.now() }) {
  validateInsightContext(context);
  validateInsightContext(currentContext);
  validateInsightProposals(proposals, context);
  assert(Number.isSafeInteger(nowMs), "insight plan nowMs is invalid");
  const currentById = new Map(currentContext.rows.map((row) => [row.creatorRecordId, row]));
  const proposalById = new Map(proposals.proposals.map((proposal) => [proposal.creatorRecordId, proposal]));
  const targetIssues = [];
  if (currentContext.contextSha256 !== context.contextSha256) {
    targetIssues.push({ reason: "context_changed" });
  }
  const updates = [];
  const unchanged = [];
  const insufficient = [];
  for (const row of context.rows) {
    const current = currentById.get(row.creatorRecordId);
    const proposal = proposalById.get(row.creatorRecordId);
    if (!current || stableStringify(currentRowSignature(current)) !== stableStringify(currentRowSignature(row))) {
      targetIssues.push({ creatorRecordId: row.creatorRecordId, reason: "creator_state_changed" });
      continue;
    }
    if (proposal.status === "insufficient_evidence") {
      insufficient.push({ creatorRecordId: row.creatorRecordId, reason: proposal.reason });
      continue;
    }
    const desiredTraits = [...proposal.traits].sort();
    const currentTraits = [...row.currentTraits].sort();
    if (proposal.insight === row.currentInsight && stableStringify(desiredTraits) === stableStringify(currentTraits)) {
      unchanged.push({ creatorRecordId: row.creatorRecordId });
      continue;
    }
    updates.push({
      creatorRecordId: row.creatorRecordId,
      accountKey: row.accountKey,
      currentInsight: row.currentInsight,
      currentTraits,
      proposedInsight: proposal.insight,
      proposedTraits: desiredTraits,
      evidence: proposal.evidence,
    });
  }
  const unsigned = {
    version: 1,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    inputs: { context, proposals },
    currentContextSha256: currentContext.contextSha256,
    operations: { updates, unchanged, insufficient, targetIssues },
    summary: {
      targetCount: context.rowCount,
      updateCount: updates.length,
      unchangedCount: unchanged.length,
      insufficientEvidenceCount: insufficient.length,
      targetIssueCount: targetIssues.length,
    },
  };
  return { ...unsigned, planSha256: calculatePlanSha256(unsigned) };
}

export function validateInsightPlan(plan) {
  assert(plan?.version === 1, "insight plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "insight plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "insight plan timestamps do not match");
  assert(plan.operations && plan.summary, "insight plan structure is invalid");
  for (const key of ["updates", "unchanged", "insufficient", "targetIssues"]) {
    assert(Array.isArray(plan.operations[key]), `insight plan operations.${key} is invalid`);
  }
  assert(plan.summary.updateCount === plan.operations.updates.length, "insight plan update count does not match");
  assert(plan.summary.targetIssueCount === plan.operations.targetIssues.length, "insight plan issue count does not match");
  assert(plan.planSha256 === calculatePlanSha256(plan), "insight plan SHA does not match content");
  return plan;
}

export function insightPlanIsBlocked(plan) {
  return plan.summary.targetIssueCount > 0;
}
