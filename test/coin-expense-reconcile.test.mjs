import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateCoinPurchaseEvidence,
  validateExpenseCandidates,
} from "@live-agency-skills/source-provider-api";

import {
  buildCoinExpensePlan,
  buildRegistrationBundle,
  coinExpensePlanIsBlocked,
  replayCoinExpensePlan,
  validateCoinExpensePlan,
  validateRegistrationResult,
} from "../skills/coin-expense-reconcile/scripts/coin_expense_core.mjs";
import { resolveCoinExpenseProvider } from "../skills/coin-expense-reconcile/scripts/resolve_coin_expense_provider.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const NOW = Date.parse("2030-01-04T03:04:05.000Z");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDigest(value) {
  return digest(JSON.stringify(value));
}

function purchase(overrides = {}) {
  return {
    purchaseKey: "purchase-1",
    transactionDate: "2030-01-02",
    amountJpy: 1000,
    coinCount: 500,
    transactionId: "transaction-1",
    occurrence: 1,
    receipt: {
      status: "verified",
      filePath: "/private/tmp/synthetic-receipt-1.pdf",
      sha256: digest("receipt-1"),
      size: 1234,
      mimeType: "application/pdf",
      receiptDate: "2030-01-03",
    },
    ...overrides,
  };
}

function purchaseEvidence(overrides = {}) {
  const purchases = overrides.purchases ?? [purchase()];
  return {
    version: 1,
    serviceKey: "synthetic-coin-service",
    accountKey: "synthetic-source-account",
    observedAt: "2030-01-04T00:00:00.000Z",
    coverage: { fromDate: "2030-01-01", toDate: "2030-01-03", complete: true },
    rowCount: purchases.length,
    purchases,
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    expenseKey: "expense-1",
    transactionDate: "2030-01-02",
    amountJpy: 1000,
    occurrence: 1,
    paymentSourceKey: "synthetic-card",
    registrationProfileKey: "synthetic-profile",
    ...overrides,
  };
}

function expenseCandidates(overrides = {}) {
  const {
    expenses = [expense()],
    sourceTransactionIds = ["transaction-1"],
    existingRegistrations = [],
    ...snapshotOverrides
  } = overrides;
  const sortedTransactionIds = [...sourceTransactionIds].sort();
  return {
    version: 1,
    serviceKey: "synthetic-coin-service",
    expenseAccountKey: "synthetic-expense-account",
    observedAt: "2030-01-04T00:01:00.000Z",
    coverage: { fromDate: "2030-01-01", toDate: "2030-01-03", complete: true },
    registrationLookup: {
      complete: true,
      sourceTransactionIdCount: sortedTransactionIds.length,
      sourceTransactionIdsSha256: jsonDigest(sortedTransactionIds),
    },
    existingRegistrationCount: existingRegistrations.length,
    existingRegistrations,
    rowCount: expenses.length,
    expenses,
    ...snapshotOverrides,
  };
}

test("validates purchase evidence and rejects reused receipts", () => {
  assert.equal(validateCoinPurchaseEvidence(purchaseEvidence()).rowCount, 1);
  assert.throws(
    () => validateCoinPurchaseEvidence(purchaseEvidence({ purchases: [
      purchase(),
      purchase({
        purchaseKey: "purchase-2",
        transactionId: "transaction-2",
        occurrence: 2,
      }),
    ] })),
    /receipt SHA-256 is reused/,
  );
  assert.throws(
    () => validateCoinPurchaseEvidence(purchaseEvidence({ purchases: [purchase({
      receipt: { status: "unavailable", filePath: "/private/tmp/should-not-exist.pdf" },
    })] })),
    /must be absent unless verified/,
  );
});

test("matches one exact calendar date and JPY amount", () => {
  const plan = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence(),
    expenseCandidates: expenseCandidates(),
    nowMs: NOW,
  });
  assert.equal(plan.summary.exactMatchCount, 1);
  assert.equal(plan.summary.exactMatchTotalJpy, "1000");
  assert.equal(plan.operations.exactMatches[0].method, "unique-date-amount");
  assert.equal(coinExpensePlanIsBlocked(plan), false);
  validateCoinExpensePlan(plan);
});

test("pairs only equivalent duplicate multisets and blocks differing profiles", () => {
  const purchases = [
    purchase(),
    purchase({
      purchaseKey: "purchase-2",
      transactionId: "transaction-2",
      occurrence: 2,
      receipt: {
        ...purchase().receipt,
        filePath: "/private/tmp/synthetic-receipt-2.pdf",
        sha256: digest("receipt-2"),
      },
    }),
  ];
  const expenses = [
    expense(),
    expense({ expenseKey: "expense-2", occurrence: 2 }),
  ];
  const matched = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence({ purchases }),
    expenseCandidates: expenseCandidates({ expenses, sourceTransactionIds: ["transaction-1", "transaction-2"] }),
    nowMs: NOW,
  });
  assert.equal(matched.summary.exactMatchCount, 2);
  assert.deepEqual(matched.operations.exactMatches.map((item) => item.expenseKey), ["expense-1", "expense-2"]);

  const ambiguous = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence({ purchases }),
    expenseCandidates: expenseCandidates({ expenses: [
      expense(),
      expense({ expenseKey: "expense-2", occurrence: 2, registrationProfileKey: "different-profile" }),
    ], sourceTransactionIds: ["transaction-1", "transaction-2"] }),
    nowMs: NOW,
  });
  assert.equal(ambiguous.summary.exactMatchCount, 0);
  assert.equal(ambiguous.summary.ambiguousGroupCount, 1);
  assert.deepEqual(ambiguous.operations.ambiguousGroups[0].reasons, ["registration_profiles_differ"]);
});

test("reserves a destination-verified existing registration before date and amount matching", () => {
  const purchases = [
    purchase({ receipt: { status: "unavailable" } }),
    purchase({
      purchaseKey: "purchase-2",
      transactionId: "transaction-2",
      occurrence: 2,
      receipt: {
        ...purchase().receipt,
        filePath: "/private/tmp/synthetic-receipt-2.pdf",
        sha256: digest("receipt-2"),
      },
    }),
  ];
  const plan = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence({ purchases }),
    expenseCandidates: expenseCandidates({
      sourceTransactionIds: ["transaction-1", "transaction-2"],
      existingRegistrations: [{
        registrationKey: "registered-expense-1",
        sourceTransactionId: "transaction-1",
        state: "registered",
        destinationVerified: true,
        evidenceMethod: "attachment_filename_exact",
      }],
    }),
    nowMs: NOW,
  });
  assert.equal(plan.summary.alreadyRegisteredCount, 1);
  assert.equal(plan.summary.exactMatchCount, 1);
  assert.equal(plan.summary.ambiguousGroupCount, 0);
  assert.equal(plan.summary.receiptIssueCount, 0);
  assert.equal(plan.operations.alreadyRegistered[0].evidenceMethod, "attachment_filename_exact");
  assert.equal(coinExpensePlanIsBlocked(plan), false);
});

test("blocks legacy expense input without a complete existing-registration lookup", () => {
  const candidates = expenseCandidates();
  delete candidates.registrationLookup;
  const plan = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence(),
    expenseCandidates: candidates,
    nowMs: NOW,
  });
  assert.equal(coinExpensePlanIsBlocked(plan), true);
  assert.ok(plan.operations.blockingIssues.some((issue) => issue.reason === "existing_registration_lookup_incomplete"));
});

test("incomplete coverage blocks registration and replay detects stale candidates", () => {
  const blocked = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence({ coverage: { fromDate: "2030-01-01", toDate: "2030-01-03", complete: false } }),
    expenseCandidates: expenseCandidates(),
    nowMs: NOW,
  });
  assert.equal(coinExpensePlanIsBlocked(blocked), true);

  const reviewed = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence(),
    expenseCandidates: expenseCandidates(),
    nowMs: NOW,
  });
  const replayed = replayCoinExpensePlan({
    purchaseEvidence: purchaseEvidence(),
    expenseCandidates: expenseCandidates({ expenses: [] }),
    reviewedPlan: reviewed,
  });
  assert.notEqual(replayed.planSha256, reviewed.planSha256);
});

test("registration results are bound to the approved bundle and destination verification", () => {
  const plan = buildCoinExpensePlan({
    purchaseEvidence: purchaseEvidence(),
    expenseCandidates: expenseCandidates(),
    nowMs: NOW,
  });
  const bundle = buildRegistrationBundle(plan, "2030-01-04T00:02:00.000Z");
  const summary = validateRegistrationResult({
    version: 1,
    planSha256: bundle.planSha256,
    bundleSha256: bundle.bundleSha256,
    observedAt: "2030-01-04T00:03:00.000Z",
    rowCount: 1,
    results: [{
      purchaseKey: "purchase-1",
      expenseKey: "expense-1",
      status: "registered",
      destinationVerified: true,
    }],
  }, bundle);
  assert.equal(summary.complete, true);
  assert.throws(
    () => validateRegistrationResult({
      version: 1,
      planSha256: bundle.planSha256,
      bundleSha256: bundle.bundleSha256,
      observedAt: "2030-01-04T00:03:00.000Z",
      rowCount: 1,
      results: [{
        purchaseKey: "purchase-1",
        expenseKey: "expense-1",
        status: "registered",
        destinationVerified: false,
      }],
    }, bundle),
    /not destination-verified/,
  );
});

test("discovers separate interactive purchase and expense providers through npm", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coin-expense-provider-test-"));
  try {
    const purchaseRequest = path.join(directory, "purchase-request.json");
    const expenseRequest = path.join(directory, "expense-request.json");
    const registrationRequest = path.join(directory, "registration-request.json");
    for (const [filePath, inputKind] of [
      [purchaseRequest, "application/x.synthetic-coin-acquisition+json"],
      [expenseRequest, "application/x.synthetic-expense-candidates+json"],
      [registrationRequest, "application/x.synthetic-expense-registration+json"],
    ]) {
      await writeFile(filePath, JSON.stringify({ inputKind }), { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
    }
    const purchaseProvider = await resolveCoinExpenseProvider({
      mode: "purchases",
      providerRoot: repositoryRoot,
      request: purchaseRequest,
      output: path.join(directory, "unused-purchase.json"),
      unattended: false,
    });
    const expenseProvider = await resolveCoinExpenseProvider({
      mode: "expenses",
      providerRoot: repositoryRoot,
      request: expenseRequest,
      output: path.join(directory, "unused-expense.json"),
      unattended: false,
    });
    const registrationProvider = await resolveCoinExpenseProvider({
      mode: "registration",
      providerRoot: repositoryRoot,
      request: registrationRequest,
      output: path.join(directory, "unused-registration.json"),
      unattended: false,
    });
    assert.equal(purchaseProvider.status, "instructions-required");
    assert.equal(expenseProvider.status, "instructions-required");
    assert.equal(registrationProvider.status, "instructions-required");
    assert.notEqual(purchaseProvider.providerPackage, expenseProvider.providerPackage);
    assert.equal(expenseProvider.providerPackage, registrationProvider.providerPackage);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
