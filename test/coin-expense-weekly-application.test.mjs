import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildApplicationBundle,
  buildWeeklyApplicationPlan,
  isoWeekBounds,
  replayWeeklyApplicationPlan,
  sha256Json,
  validateApplicationResult,
  validateWeeklyApplicationPlan,
  validateWeeklyApplicationSnapshot,
  weeklyApplicationPlanIsBlocked,
} from "../skills/coin-expense-weekly-application/scripts/weekly_application_core.mjs";
import { resolveWeeklyApplicationProvider } from "../skills/coin-expense-weekly-application/scripts/resolve_weekly_application_provider.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const DURING_WEEK = Date.parse("2030-01-03T00:00:00.000Z");
const AFTER_WEEK = Date.parse("2030-01-07T00:00:00.000Z");

function expense(overrides = {}) {
  return {
    expenseKey: "expense-1",
    transactionDate: "2030-01-02",
    amountJpy: 1000,
    sourceTransactionId: "transaction-1",
    destinationVerified: true,
    categoryVerified: true,
    memoTransactionIdVerified: true,
    receiptAttached: true,
    receiptTransactionIdVerified: true,
    applicationKey: null,
    ...overrides,
  };
}

function application(overrides = {}) {
  return {
    applicationKey: "application-1",
    title: "Synthetic coin expense 2030-W01",
    state: "draft",
    destinationVerified: true,
    expenseKeys: ["expense-1"],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const expenses = overrides.expenses ?? [expense()];
  const applications = overrides.applications ?? [];
  return {
    version: 1,
    serviceKey: "synthetic-coin-service",
    expenseAccountKey: "synthetic-expense-account",
    applicationProfileKey: "synthetic-weekly-profile",
    observedAt: "2030-01-03T00:00:00.000Z",
    timeZone: "Asia/Tokyo",
    isoWeek: "2030-W01",
    coverage: { fromDate: "2029-12-31", toDate: "2030-01-06", complete: true },
    expectedTitle: "Synthetic coin expense 2030-W01",
    expenseCount: expenses.length,
    expenses,
    applicationCount: applications.length,
    applications,
    ...overrides,
  };
}

test("derives exact Monday-through-Sunday ISO week bounds", () => {
  assert.deepEqual(isoWeekBounds("2030-W01"), { fromDate: "2029-12-31", toDate: "2030-01-06" });
  assert.deepEqual(isoWeekBounds("2026-W36"), { fromDate: "2026-08-31", toDate: "2026-09-06" });
  assert.throws(() => isoWeekBounds("2030-W53"), /does not exist/);
});

test("validates normalized snapshots and rejects unprovable IDs", () => {
  assert.equal(validateWeeklyApplicationSnapshot(snapshot()).snapshot.expenseCount, 1);
  assert.throws(
    () => validateWeeklyApplicationSnapshot(snapshot({ expenses: [expense({
      sourceTransactionId: null,
      memoTransactionIdVerified: true,
      receiptTransactionIdVerified: false,
    })] })),
    /cannot verify a missing sourceTransactionId/,
  );
});

test("creates a draft during the active ISO week", () => {
  const plan = buildWeeklyApplicationPlan({ snapshot: snapshot(), nowMs: DURING_WEEK });
  validateWeeklyApplicationPlan(plan);
  assert.equal(weeklyApplicationPlanIsBlocked(plan), false);
  assert.equal(plan.operations.application.mode, "create");
  assert.equal(plan.operations.application.targetState, "draft");
  assert.deepEqual(plan.operations.application.addExpenseKeys, ["expense-1"]);
  assert.equal(plan.summary.willWrite, true);
});

test("reuses one exact draft and adds only missing eligible expenses", () => {
  const expenses = [
    expense({ applicationKey: "application-1" }),
    expense({
      expenseKey: "expense-2",
      transactionDate: "2030-01-03",
      amountJpy: 2000,
      sourceTransactionId: "transaction-2",
    }),
  ];
  const plan = buildWeeklyApplicationPlan({
    snapshot: snapshot({ expenses, applications: [application()] }),
    nowMs: DURING_WEEK,
  });
  assert.equal(plan.operations.application.mode, "reuse");
  assert.equal(plan.operations.application.targetState, "draft");
  assert.deepEqual(plan.operations.application.existingExpenseKeys, ["expense-1"]);
  assert.deepEqual(plan.operations.application.addExpenseKeys, ["expense-2"]);
  assert.equal(plan.summary.eligibleTotalJpy, "3000");
});

test("submits a reused draft only after Sunday has ended", () => {
  const plan = buildWeeklyApplicationPlan({
    snapshot: snapshot({
      expenses: [expense({ applicationKey: "application-1" })],
      applications: [application()],
    }),
    nowMs: AFTER_WEEK,
  });
  assert.equal(plan.operations.application.mode, "reuse");
  assert.equal(plan.operations.application.targetState, "submitted");
  assert.equal(plan.operations.application.addExpenseKeys.length, 0);
  assert.equal(plan.summary.willWrite, true);
});

test("excludes rows lacking evidence without silently including them", () => {
  const plan = buildWeeklyApplicationPlan({
    snapshot: snapshot({ expenses: [expense({ receiptTransactionIdVerified: false })] }),
    nowMs: DURING_WEEK,
  });
  assert.equal(plan.summary.eligibleCount, 0);
  assert.equal(plan.summary.excludedCount, 1);
  assert.deepEqual(plan.operations.excludedExpenses[0].reasons, ["receipt_transaction_id_not_verified"]);
  assert.equal(plan.operations.application.mode, "none");
  assert.equal(plan.summary.willWrite, false);
});

test("blocks duplicate drafts, foreign membership, and noneligible draft rows", () => {
  const duplicate = buildWeeklyApplicationPlan({
    snapshot: snapshot({ applications: [
      application(),
      application({ applicationKey: "application-2", expenseKeys: [] }),
    ] }),
    nowMs: DURING_WEEK,
  });
  assert.ok(duplicate.operations.blockingIssues.some((issue) => issue.reason === "multiple_matching_applications"));

  const foreign = buildWeeklyApplicationPlan({
    snapshot: snapshot({
      expenses: [expense({ applicationKey: "other-application" })],
      applications: [application({
        applicationKey: "other-application",
        title: "Other weekly application",
      })],
    }),
    nowMs: DURING_WEEK,
  });
  assert.ok(foreign.operations.blockingIssues.some((issue) => issue.reason === "eligible_expense_assigned_elsewhere"));

  const extra = buildWeeklyApplicationPlan({
    snapshot: snapshot({
      expenses: [expense({ applicationKey: "application-1" })],
      applications: [application({ expenseKeys: ["expense-1", "unknown-expense"] })],
    }),
    nowMs: DURING_WEEK,
  });
  assert.ok(extra.operations.blockingIssues.some((issue) => issue.reason === "draft_contains_noneligible_expenses"));
});

test("treats an exact submitted application as complete but blocks changed membership", () => {
  const complete = buildWeeklyApplicationPlan({
    snapshot: snapshot({
      expenses: [expense({ applicationKey: "application-1" })],
      applications: [application({ state: "submitted" })],
    }),
    nowMs: AFTER_WEEK,
  });
  assert.equal(complete.operations.application.alreadyComplete, true);
  assert.equal(complete.summary.willWrite, false);
  assert.equal(weeklyApplicationPlanIsBlocked(complete), false);

  const conflict = buildWeeklyApplicationPlan({
    snapshot: snapshot({
      expenses: [
        expense({ applicationKey: "application-1" }),
        expense({
          expenseKey: "expense-2",
          transactionDate: "2030-01-03",
          amountJpy: 2000,
          sourceTransactionId: "transaction-2",
        }),
      ],
      applications: [application({ state: "submitted" })],
    }),
    nowMs: AFTER_WEEK,
  });
  assert.ok(conflict.operations.blockingIssues.some((issue) => issue.reason === "matching_nondraft_application_conflicts"));
});

test("replay detects changed destination inputs", () => {
  const reviewed = buildWeeklyApplicationPlan({ snapshot: snapshot(), nowMs: DURING_WEEK });
  const changed = replayWeeklyApplicationPlan({
    snapshot: snapshot({ expenses: [expense({ amountJpy: 2000 })] }),
    reviewedPlan: reviewed,
  });
  assert.notEqual(changed.planSha256, reviewed.planSha256);
});

test("binds application results to exact title, membership, total, and state", () => {
  const plan = buildWeeklyApplicationPlan({ snapshot: snapshot(), nowMs: DURING_WEEK });
  const bundle = buildApplicationBundle(plan, "2030-01-03T00:01:00.000Z");
  const positive = {
    version: 1,
    planSha256: bundle.planSha256,
    bundleSha256: bundle.bundleSha256,
    observedAt: "2030-01-03T00:02:00.000Z",
    status: "draft_saved",
    applicationKey: "application-1",
    destinationVerified: true,
    titleVerified: true,
    expenseMembershipVerified: true,
    observedExpenseKeysSha256: bundle.expenseKeysSha256,
    itemCount: 1,
    totalJpy: "1000",
    finalState: "draft",
  };
  assert.equal(validateApplicationResult(positive, bundle).complete, true);
  assert.throws(
    () => validateApplicationResult({ ...positive, observedExpenseKeysSha256: sha256Json([]) }, bundle),
    /membership differs/,
  );
  assert.throws(
    () => validateApplicationResult({ ...positive, finalState: "submitted", status: "submitted" }, bundle),
    /finalState differs/,
  );
});

test("resolves separate interactive source and sink capabilities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "weekly-application-provider-test-"));
  try {
    for (const [name, inputKind] of [
      ["source", "application/x.synthetic-weekly-expense-source+json"],
      ["application", "application/x.synthetic-weekly-expense-application+json"],
    ]) {
      const request = path.join(directory, `${name}.json`);
      await writeFile(request, JSON.stringify({ inputKind }), { encoding: "utf8", mode: 0o600 });
      await chmod(request, 0o600);
      const resolved = await resolveWeeklyApplicationProvider({
        mode: name,
        providerRoot: repositoryRoot,
        request,
        output: path.join(directory, `${name}-unused.json`),
        unattended: false,
      });
      assert.equal(resolved.status, "instructions-required");
      assert.equal(resolved.providerPackage, "@fixture/expense-instruction-provider");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
