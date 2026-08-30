import { createHash } from "node:crypto";

import {
  validateCoinPurchaseEvidence,
  validateExpenseCandidates,
} from "@live-agency-skills/source-provider-api";

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

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(stableSort(value))).digest("hex");
}

function groupKey(row) {
  return JSON.stringify([row.transactionDate, row.amountJpy]);
}

function compareOccurrence(left, right) {
  return left.occurrence - right.occurrence ||
    (left.purchaseKey ?? left.expenseKey).localeCompare(right.purchaseKey ?? right.expenseKey);
}

function exactMatch(purchase, expense, method) {
  return {
    purchaseKey: purchase.purchaseKey,
    expenseKey: expense.expenseKey,
    transactionDate: purchase.transactionDate,
    amountJpy: purchase.amountJpy,
    coinCount: purchase.coinCount,
    transactionId: purchase.transactionId ?? null,
    receipt: purchase.receipt,
    paymentSourceKey: expense.paymentSourceKey,
    registrationProfileKey: expense.registrationProfileKey,
    method,
  };
}

function calculatePlanSha256(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return sha256Json(unsigned);
}

export function buildCoinExpensePlan({ purchaseEvidence, expenseCandidates, nowMs = Date.now() }) {
  validateCoinPurchaseEvidence(purchaseEvidence);
  validateExpenseCandidates(expenseCandidates);
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");

  const blockingIssues = [];
  if (purchaseEvidence.serviceKey !== expenseCandidates.serviceKey) {
    blockingIssues.push({ reason: "service_key_mismatch" });
  }
  if (!purchaseEvidence.coverage.complete) {
    blockingIssues.push({ reason: "purchase_coverage_incomplete", coverage: purchaseEvidence.coverage });
  }
  if (!expenseCandidates.coverage.complete) {
    blockingIssues.push({ reason: "expense_coverage_incomplete", coverage: expenseCandidates.coverage });
  }

  const sourceTransactionIds = purchaseEvidence.purchases
    .map((purchase) => purchase.transactionId ?? null)
    .filter((value) => value !== null)
    .sort();
  const missingTransactionIdCount = purchaseEvidence.purchases.length - sourceTransactionIds.length;
  const registrationLookup = expenseCandidates.registrationLookup ?? { complete: false };
  if (purchaseEvidence.purchases.length && missingTransactionIdCount) {
    blockingIssues.push({ reason: "existing_registration_lookup_unverifiable", missingTransactionIdCount });
  }
  if (
    purchaseEvidence.purchases.length &&
    (
      registrationLookup.complete !== true ||
      registrationLookup.sourceTransactionIdCount !== sourceTransactionIds.length ||
      registrationLookup.sourceTransactionIdsSha256 !== sha256Json(sourceTransactionIds)
    )
  ) {
    blockingIssues.push({ reason: "existing_registration_lookup_incomplete" });
  }

  const existingRegistrationByTransactionId = new Map(
    (expenseCandidates.existingRegistrations ?? []).map((registration) => [
      registration.sourceTransactionId,
      registration,
    ]),
  );
  const purchasesByTransactionId = new Map(
    purchaseEvidence.purchases
      .filter((purchase) => purchase.transactionId)
      .map((purchase) => [purchase.transactionId, purchase]),
  );
  for (const transactionId of existingRegistrationByTransactionId.keys()) {
    if (!purchasesByTransactionId.has(transactionId)) {
      blockingIssues.push({ reason: "existing_registration_without_purchase" });
    }
  }

  const alreadyRegistered = [];
  const actionablePurchases = [];
  for (const purchase of purchaseEvidence.purchases) {
    const registration = purchase.transactionId
      ? existingRegistrationByTransactionId.get(purchase.transactionId)
      : null;
    if (registration) {
      alreadyRegistered.push({
        purchaseKey: purchase.purchaseKey,
        transactionId: purchase.transactionId,
        registrationKey: registration.registrationKey,
        destinationVerified: registration.destinationVerified,
        evidenceMethod: registration.evidenceMethod,
      });
    } else {
      actionablePurchases.push(purchase);
    }
  }

  const purchaseGroups = new Map();
  const expenseGroups = new Map();
  for (const purchase of actionablePurchases) {
    const key = groupKey(purchase);
    if (!purchaseGroups.has(key)) purchaseGroups.set(key, []);
    purchaseGroups.get(key).push(purchase);
  }
  for (const expense of expenseCandidates.expenses) {
    const key = groupKey(expense);
    if (!expenseGroups.has(key)) expenseGroups.set(key, []);
    expenseGroups.get(key).push(expense);
  }

  const exactMatches = [];
  const unmatchedPurchases = [];
  const unmatchedExpenses = [];
  const ambiguousGroups = [];
  const receiptIssues = [];
  const allKeys = [...new Set([...purchaseGroups.keys(), ...expenseGroups.keys()])].sort();
  for (const key of allKeys) {
    const purchases = [...(purchaseGroups.get(key) ?? [])].sort(compareOccurrence);
    const expenses = [...(expenseGroups.get(key) ?? [])].sort(compareOccurrence);
    for (const purchase of purchases) {
      if (purchase.receipt.status !== "verified") {
        receiptIssues.push({
          purchaseKey: purchase.purchaseKey,
          transactionDate: purchase.transactionDate,
          amountJpy: purchase.amountJpy,
          status: purchase.receipt.status,
        });
      }
    }
    if (!purchases.length) {
      unmatchedExpenses.push(...expenses.map((expense) => ({ ...expense, reason: "no_purchase" })));
      continue;
    }
    if (!expenses.length) {
      unmatchedPurchases.push(...purchases.map((purchase) => ({
        purchaseKey: purchase.purchaseKey,
        transactionDate: purchase.transactionDate,
        amountJpy: purchase.amountJpy,
        reason: purchase.receipt.status === "verified" ? "no_expense" : `receipt_${purchase.receipt.status}`,
      })));
      continue;
    }

    const allReceiptsVerified = purchases.every((purchase) => purchase.receipt.status === "verified");
    if (purchases.length === 1 && expenses.length === 1 && allReceiptsVerified) {
      exactMatches.push(exactMatch(purchases[0], expenses[0], "unique-date-amount"));
      continue;
    }
    const profiles = new Set(
      expenses.map((expense) => JSON.stringify([expense.registrationProfileKey, expense.paymentSourceKey])),
    );
    if (purchases.length === expenses.length && allReceiptsVerified && profiles.size === 1) {
      for (let index = 0; index < purchases.length; index += 1) {
        exactMatches.push(exactMatch(purchases[index], expenses[index], "equivalent-multiset-order"));
      }
      continue;
    }
    ambiguousGroups.push({
      transactionDate: purchases[0]?.transactionDate ?? expenses[0].transactionDate,
      amountJpy: purchases[0]?.amountJpy ?? expenses[0].amountJpy,
      purchaseKeys: purchases.map((purchase) => purchase.purchaseKey),
      expenseKeys: expenses.map((expense) => expense.expenseKey),
      reasons: [
        ...(purchases.length !== expenses.length ? ["count_mismatch"] : []),
        ...(!allReceiptsVerified ? ["receipt_not_verified"] : []),
        ...(profiles.size !== 1 ? ["registration_profiles_differ"] : []),
      ],
    });
  }

  const exactTotal = exactMatches.reduce((sum, match) => sum + BigInt(match.amountJpy), 0n).toString();
  const unsigned = {
    version: 2,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    inputs: { purchaseEvidence, expenseCandidates },
    operations: {
      alreadyRegistered,
      exactMatches,
      unmatchedPurchases,
      unmatchedExpenses,
      ambiguousGroups,
      receiptIssues,
      blockingIssues,
    },
    summary: {
      purchaseCount: purchaseEvidence.rowCount,
      expenseCount: expenseCandidates.rowCount,
      alreadyRegisteredCount: alreadyRegistered.length,
      exactMatchCount: exactMatches.length,
      exactMatchTotalJpy: exactTotal,
      unmatchedPurchaseCount: unmatchedPurchases.length,
      unmatchedExpenseCount: unmatchedExpenses.length,
      ambiguousGroupCount: ambiguousGroups.length,
      receiptIssueCount: receiptIssues.length,
      blockingIssueCount: blockingIssues.length,
    },
  };
  return { ...unsigned, planSha256: sha256Json(unsigned) };
}

export function validateCoinExpensePlan(plan) {
  assert(plan?.version === 2, "coin-expense plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "coin-expense plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "coin-expense plan timestamps differ");
  validateCoinPurchaseEvidence(plan.inputs?.purchaseEvidence);
  validateExpenseCandidates(plan.inputs?.expenseCandidates);
  for (const key of [
    "alreadyRegistered", "exactMatches", "unmatchedPurchases", "unmatchedExpenses", "ambiguousGroups",
    "receiptIssues", "blockingIssues",
  ]) {
    assert(Array.isArray(plan.operations?.[key]), `coin-expense plan operations.${key} is invalid`);
  }
  assert(plan.summary?.alreadyRegisteredCount === plan.operations.alreadyRegistered.length, "plan already-registered count differs");
  assert(plan.summary?.exactMatchCount === plan.operations.exactMatches.length, "plan exact-match count differs");
  assert(plan.summary?.unmatchedPurchaseCount === plan.operations.unmatchedPurchases.length, "plan unmatched-purchase count differs");
  assert(plan.summary?.unmatchedExpenseCount === plan.operations.unmatchedExpenses.length, "plan unmatched-expense count differs");
  assert(plan.summary?.ambiguousGroupCount === plan.operations.ambiguousGroups.length, "plan ambiguous-group count differs");
  assert(plan.summary?.receiptIssueCount === plan.operations.receiptIssues.length, "plan receipt-issue count differs");
  assert(plan.summary?.blockingIssueCount === plan.operations.blockingIssues.length, "plan blocking-issue count differs");
  const total = plan.operations.exactMatches.reduce((sum, match) => sum + BigInt(match.amountJpy), 0n).toString();
  assert(plan.summary.exactMatchTotalJpy === total, "plan exact-match total differs");
  assert(plan.planSha256 === calculatePlanSha256(plan), "coin-expense plan SHA does not match content");
  return plan;
}

export function coinExpensePlanIsBlocked(plan) {
  validateCoinExpensePlan(plan);
  return plan.operations.blockingIssues.length > 0;
}

export function replayCoinExpensePlan({ purchaseEvidence, expenseCandidates, reviewedPlan }) {
  validateCoinExpensePlan(reviewedPlan);
  return buildCoinExpensePlan({
    purchaseEvidence,
    expenseCandidates,
    nowMs: reviewedPlan.builtAtMs,
  });
}

export function buildRegistrationBundle(plan, preparedAt = new Date().toISOString()) {
  validateCoinExpensePlan(plan);
  assert(!coinExpensePlanIsBlocked(plan), "blocking issues prevent registration preparation");
  const content = {
    version: 1,
    preparedAt,
    planSha256: plan.planSha256,
    serviceKey: plan.inputs.purchaseEvidence.serviceKey,
    expenseAccountKey: plan.inputs.expenseCandidates.expenseAccountKey,
    itemCount: plan.operations.exactMatches.length,
    totalJpy: plan.summary.exactMatchTotalJpy,
    items: plan.operations.exactMatches,
  };
  return { ...content, bundleSha256: sha256Json(content) };
}

export function validateRegistrationResult(result, bundle) {
  assert(result?.version === 1, "registration result version is invalid");
  assert(result.planSha256 === bundle.planSha256, "registration result plan SHA differs");
  assert(result.bundleSha256 === bundle.bundleSha256, "registration result bundle SHA differs");
  assert(typeof result.observedAt === "string" && !Number.isNaN(Date.parse(result.observedAt)), "registration result observedAt is invalid");
  assert(Array.isArray(result.results), "registration result results must be an array");
  assert(result.rowCount === result.results.length, "registration result rowCount differs");
  const expected = new Map(bundle.items.map((item) => [`${item.purchaseKey}\n${item.expenseKey}`, item]));
  const seen = new Set();
  for (const [index, item] of result.results.entries()) {
    const key = `${item.purchaseKey}\n${item.expenseKey}`;
    assert(expected.has(key), `registration result ${index} is not in the approved bundle`);
    assert(!seen.has(key), `registration result ${index} is duplicated`);
    seen.add(key);
    assert(["registered", "already_registered", "failed", "uncertain"].includes(item.status), `registration result ${index} status is invalid`);
    assert(typeof item.destinationVerified === "boolean", `registration result ${index} destinationVerified is invalid`);
    if (["registered", "already_registered"].includes(item.status)) {
      assert(item.destinationVerified, `registration result ${index} was not destination-verified`);
    }
  }
  const missingApproved = [...expected.keys()].filter((key) => !seen.has(key));
  const verifiedCount = result.results.filter(
    (item) => ["registered", "already_registered"].includes(item.status) && item.destinationVerified,
  ).length;
  return {
    complete: missingApproved.length === 0 && verifiedCount === bundle.itemCount,
    verifiedCount,
    failedCount: result.results.filter((item) => item.status === "failed").length,
    uncertainCount: result.results.filter((item) => item.status === "uncertain").length,
    missingApprovedCount: missingApproved.length,
  };
}
