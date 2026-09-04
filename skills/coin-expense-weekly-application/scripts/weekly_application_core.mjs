import { createHash } from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function assertPlainText(value, label) {
  assert(typeof value === "string" && value.length > 0 && !/[\t\r\n]/.test(value), `${label} must be non-empty single-line text`);
}

function assertIsoDateTime(value, label) {
  assert(typeof value === "string" && !Number.isNaN(Date.parse(value)), `${label} must be an ISO timestamp`);
}

function parseCalendarDate(value, label) {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), `${label} must be YYYY-MM-DD`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  assert(date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day, `${label} is not a calendar date`);
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
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

function isoWeekForDate(date) {
  const thursday = new Date(date.getTime());
  const day = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const weekOneMonday = new Date(jan4.getTime());
  weekOneMonday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const week = Math.floor((date.getTime() - weekOneMonday.getTime()) / 604800000) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function isoWeekBounds(isoWeek) {
  assertPlainText(isoWeek, "isoWeek");
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  assert(match, "isoWeek must use YYYY-Www");
  const year = Number(match[1]);
  const week = Number(match[2]);
  assert(week >= 1 && week <= 53, "isoWeek week number is invalid");
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4.getTime());
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + (week - 1) * 7);
  assert(isoWeekForDate(monday) === isoWeek, "isoWeek does not exist");
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { fromDate: formatDate(monday), toDate: formatDate(sunday) };
}

function localDateAt(nowMs, timeZone) {
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
  } catch {
    throw new TypeError("weekly application timeZone is invalid");
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const result = String(left[index]).localeCompare(String(right[index]));
    if (result) return result;
  }
  return 0;
}

export function validateWeeklyApplicationSnapshot(snapshot) {
  assert(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), "weekly application snapshot is invalid");
  assert(snapshot.version === 1, "weekly application snapshot version is invalid");
  for (const key of ["serviceKey", "expenseAccountKey", "applicationProfileKey", "timeZone", "isoWeek", "expectedTitle"]) {
    assertPlainText(snapshot[key], `weekly application ${key}`);
  }
  assertIsoDateTime(snapshot.observedAt, "weekly application observedAt");
  const bounds = isoWeekBounds(snapshot.isoWeek);
  assert(snapshot.expectedTitle.endsWith(` ${snapshot.isoWeek}`), "weekly application title must end with the ISO week");
  assert(snapshot.expectedTitle.length <= 100, "weekly application title is too long");
  assert(snapshot.coverage && typeof snapshot.coverage === "object", "weekly application coverage is invalid");
  parseCalendarDate(snapshot.coverage.fromDate, "weekly application coverage fromDate");
  parseCalendarDate(snapshot.coverage.toDate, "weekly application coverage toDate");
  assert(snapshot.coverage.fromDate <= snapshot.coverage.toDate, "weekly application coverage is reversed");
  assert(typeof snapshot.coverage.complete === "boolean", "weekly application coverage complete is invalid");
  localDateAt(Date.now(), snapshot.timeZone);

  assert(Array.isArray(snapshot.expenses), "weekly application expenses must be an array");
  assert(snapshot.expenseCount === snapshot.expenses.length, "weekly application expenseCount differs");
  const expenseKeys = new Set();
  const sourceTransactionIds = new Set();
  let previousExpenseOrder = null;
  for (const [index, expense] of snapshot.expenses.entries()) {
    const label = `weekly application expense ${index}`;
    assert(expense && typeof expense === "object" && !Array.isArray(expense), `${label} is invalid`);
    assertPlainText(expense.expenseKey, `${label} expenseKey`);
    parseCalendarDate(expense.transactionDate, `${label} transactionDate`);
    assert(Number.isSafeInteger(expense.amountJpy) && expense.amountJpy > 0, `${label} amountJpy is invalid`);
    if (expense.sourceTransactionId !== null) {
      assertPlainText(expense.sourceTransactionId, `${label} sourceTransactionId`);
      assert(!sourceTransactionIds.has(expense.sourceTransactionId), `${label} sourceTransactionId is duplicated`);
      sourceTransactionIds.add(expense.sourceTransactionId);
    }
    for (const key of ["destinationVerified", "categoryVerified", "memoTransactionIdVerified", "receiptAttached", "receiptTransactionIdVerified"]) {
      assert(typeof expense[key] === "boolean", `${label} ${key} is invalid`);
    }
    if (expense.sourceTransactionId === null) {
      assert(!expense.memoTransactionIdVerified && !expense.receiptTransactionIdVerified, `${label} cannot verify a missing sourceTransactionId`);
    }
    if (expense.applicationKey !== null) assertPlainText(expense.applicationKey, `${label} applicationKey`);
    assert(!expenseKeys.has(expense.expenseKey), `${label} expenseKey is duplicated`);
    expenseKeys.add(expense.expenseKey);
    const order = [expense.transactionDate, expense.expenseKey];
    assert(!previousExpenseOrder || compareTuple(order, previousExpenseOrder) > 0, `${label} is not strictly ordered`);
    previousExpenseOrder = order;
  }

  assert(Array.isArray(snapshot.applications), "weekly application applications must be an array");
  assert(snapshot.applicationCount === snapshot.applications.length, "weekly application applicationCount differs");
  const applicationKeys = new Set();
  let previousApplicationOrder = null;
  for (const [index, application] of snapshot.applications.entries()) {
    const label = `weekly application destination application ${index}`;
    assert(application && typeof application === "object" && !Array.isArray(application), `${label} is invalid`);
    assertPlainText(application.applicationKey, `${label} applicationKey`);
    assertPlainText(application.title, `${label} title`);
    assert(["draft", "submitted", "approved", "canceled", "rejected"].includes(application.state), `${label} state is invalid`);
    assert(typeof application.destinationVerified === "boolean", `${label} destinationVerified is invalid`);
    assert(Array.isArray(application.expenseKeys), `${label} expenseKeys is invalid`);
    let previousKey = null;
    const memberKeys = new Set();
    for (const expenseKey of application.expenseKeys) {
      assertPlainText(expenseKey, `${label} expense key`);
      assert(!memberKeys.has(expenseKey), `${label} expense key is duplicated`);
      assert(previousKey === null || expenseKey.localeCompare(previousKey) > 0, `${label} expenseKeys are not strictly ordered`);
      memberKeys.add(expenseKey);
      previousKey = expenseKey;
    }
    assert(!applicationKeys.has(application.applicationKey), `${label} applicationKey is duplicated`);
    applicationKeys.add(application.applicationKey);
    const order = [application.title, application.applicationKey];
    assert(!previousApplicationOrder || compareTuple(order, previousApplicationOrder) > 0, `${label} is not strictly ordered`);
    previousApplicationOrder = order;
  }
  for (const expense of snapshot.expenses) {
    assert(expense.applicationKey === null || applicationKeys.has(expense.applicationKey), `expense ${expense.expenseKey} references an unknown application`);
  }
  return { snapshot, bounds };
}

function eligibilityReasons(expense, bounds) {
  const reasons = [];
  if (expense.transactionDate < bounds.fromDate || expense.transactionDate > bounds.toDate) reasons.push("outside_iso_week");
  if (!expense.destinationVerified) reasons.push("destination_not_verified");
  if (!expense.categoryVerified) reasons.push("category_not_verified");
  if (expense.sourceTransactionId === null) reasons.push("source_transaction_id_missing");
  if (!expense.memoTransactionIdVerified) reasons.push("memo_transaction_id_not_verified");
  if (!expense.receiptAttached) reasons.push("receipt_not_attached");
  if (!expense.receiptTransactionIdVerified) reasons.push("receipt_transaction_id_not_verified");
  return reasons;
}

function unsignedPlan(plan) {
  const { planSha256: ignored, ...unsigned } = plan;
  return unsigned;
}

export function buildWeeklyApplicationPlan({ snapshot, nowMs = Date.now() }) {
  const { bounds } = validateWeeklyApplicationSnapshot(snapshot);
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  const localDate = localDateAt(nowMs, snapshot.timeZone);
  const blockingIssues = [];
  if (!snapshot.coverage.complete) blockingIssues.push({ reason: "coverage_incomplete" });
  if (snapshot.coverage.fromDate !== bounds.fromDate || snapshot.coverage.toDate !== bounds.toDate) {
    blockingIssues.push({ reason: "coverage_not_exact_iso_week", expected: bounds, observed: snapshot.coverage });
  }
  if (localDate < bounds.fromDate) blockingIssues.push({ reason: "future_week" });

  const eligibleExpenses = [];
  const excludedExpenses = [];
  for (const expense of snapshot.expenses) {
    const reasons = eligibilityReasons(expense, bounds);
    if (reasons.length) excludedExpenses.push({ expenseKey: expense.expenseKey, reasons });
    else eligibleExpenses.push(expense);
  }
  const eligibleKeys = new Set(eligibleExpenses.map((expense) => expense.expenseKey));
  const matchingApplications = snapshot.applications.filter((application) => application.title === snapshot.expectedTitle);
  if (matchingApplications.length > 1) blockingIssues.push({ reason: "multiple_matching_applications", count: matchingApplications.length });
  const targetApplication = matchingApplications.length === 1 ? matchingApplications[0] : null;

  for (const expense of eligibleExpenses) {
    if (expense.applicationKey !== null && expense.applicationKey !== targetApplication?.applicationKey) {
      blockingIssues.push({ reason: "eligible_expense_assigned_elsewhere", expenseKey: expense.expenseKey });
    }
  }

  let mode = "none";
  let existingExpenseKeys = [];
  let addExpenseKeys = [];
  let alreadyComplete = false;
  const targetState = localDate <= bounds.toDate ? "draft" : "submitted";
  if (targetApplication) {
    if (!targetApplication.destinationVerified) blockingIssues.push({ reason: "matching_application_not_verified" });
    existingExpenseKeys = [...targetApplication.expenseKeys];
    const extraKeys = existingExpenseKeys.filter((key) => !eligibleKeys.has(key));
    if (targetApplication.state === "draft") {
      mode = "reuse";
      if (extraKeys.length) blockingIssues.push({ reason: "draft_contains_noneligible_expenses", count: extraKeys.length });
      for (const expense of eligibleExpenses) {
        const inApplication = existingExpenseKeys.includes(expense.expenseKey);
        if (inApplication !== (expense.applicationKey === targetApplication.applicationKey)) {
          blockingIssues.push({ reason: "application_membership_inconsistent", expenseKey: expense.expenseKey });
        }
      }
      addExpenseKeys = eligibleExpenses.map((expense) => expense.expenseKey).filter((key) => !existingExpenseKeys.includes(key));
    } else {
      const exactMembership = extraKeys.length === 0 && existingExpenseKeys.length === eligibleExpenses.length;
      if (["submitted", "approved"].includes(targetApplication.state) && exactMembership) {
        alreadyComplete = true;
      } else {
        blockingIssues.push({ reason: "matching_nondraft_application_conflicts", state: targetApplication.state });
      }
    }
  } else if (eligibleExpenses.length > 0) {
    mode = "create";
    addExpenseKeys = eligibleExpenses.map((expense) => expense.expenseKey);
  }

  if (eligibleExpenses.length === 0 && targetApplication?.expenseKeys.length) {
    blockingIssues.push({ reason: "matching_application_has_no_eligible_expenses" });
  }

  const totalJpy = eligibleExpenses.reduce((sum, expense) => sum + BigInt(expense.amountJpy), 0n).toString();
  const willWrite = blockingIssues.length === 0 && (
    mode === "create" ||
    (mode === "reuse" && (addExpenseKeys.length > 0 || targetState === "submitted"))
  );
  const content = {
    version: 1,
    builtAt: new Date(nowMs).toISOString(),
    builtAtMs: nowMs,
    localDate,
    input: snapshot,
    week: { isoWeek: snapshot.isoWeek, ...bounds },
    operations: {
      eligibleExpenses,
      excludedExpenses,
      blockingIssues,
      application: {
        mode,
        applicationKey: targetApplication?.applicationKey ?? null,
        observedState: targetApplication?.state ?? null,
        expectedTitle: snapshot.expectedTitle,
        targetState,
        existingExpenseKeys,
        addExpenseKeys,
        alreadyComplete,
        willWrite,
      },
    },
    summary: {
      eligibleCount: eligibleExpenses.length,
      excludedCount: excludedExpenses.length,
      eligibleTotalJpy: totalJpy,
      matchingApplicationCount: matchingApplications.length,
      addCount: addExpenseKeys.length,
      blockingIssueCount: blockingIssues.length,
      willWrite,
    },
  };
  return { ...content, planSha256: sha256Json(content) };
}

export function validateWeeklyApplicationPlan(plan) {
  assert(plan?.version === 1, "weekly application plan version is invalid");
  assert(Number.isSafeInteger(plan.builtAtMs), "weekly application plan builtAtMs is invalid");
  assert(plan.builtAt === new Date(plan.builtAtMs).toISOString(), "weekly application plan timestamps differ");
  validateWeeklyApplicationSnapshot(plan.input);
  for (const key of ["eligibleExpenses", "excludedExpenses", "blockingIssues"]) {
    assert(Array.isArray(plan.operations?.[key]), `weekly application plan ${key} is invalid`);
  }
  assert(["none", "reuse", "create"].includes(plan.operations?.application?.mode), "weekly application plan mode is invalid");
  assert(["draft", "submitted"].includes(plan.operations.application.targetState), "weekly application plan targetState is invalid");
  assert(plan.summary?.eligibleCount === plan.operations.eligibleExpenses.length, "weekly application eligible count differs");
  assert(plan.summary?.excludedCount === plan.operations.excludedExpenses.length, "weekly application excluded count differs");
  assert(plan.summary?.blockingIssueCount === plan.operations.blockingIssues.length, "weekly application blocker count differs");
  const total = plan.operations.eligibleExpenses.reduce((sum, expense) => sum + BigInt(expense.amountJpy), 0n).toString();
  assert(plan.summary.eligibleTotalJpy === total, "weekly application total differs");
  assert(plan.planSha256 === sha256Json(unsignedPlan(plan)), "weekly application plan SHA does not match content");
  return plan;
}

export function weeklyApplicationPlanIsBlocked(plan) {
  validateWeeklyApplicationPlan(plan);
  return plan.operations.blockingIssues.length > 0;
}

export function replayWeeklyApplicationPlan({ snapshot, reviewedPlan }) {
  validateWeeklyApplicationPlan(reviewedPlan);
  return buildWeeklyApplicationPlan({ snapshot, nowMs: reviewedPlan.builtAtMs });
}

export function buildApplicationBundle(plan, preparedAt = new Date().toISOString()) {
  validateWeeklyApplicationPlan(plan);
  assert(!weeklyApplicationPlanIsBlocked(plan), "blocking issues prevent application preparation");
  const operation = plan.operations.application;
  assert(operation.willWrite, "weekly application plan has no external write");
  const expenseKeys = plan.operations.eligibleExpenses.map((expense) => expense.expenseKey).sort();
  const content = {
    version: 1,
    preparedAt,
    planSha256: plan.planSha256,
    serviceKey: plan.input.serviceKey,
    expenseAccountKey: plan.input.expenseAccountKey,
    applicationProfileKey: plan.input.applicationProfileKey,
    isoWeek: plan.week.isoWeek,
    fromDate: plan.week.fromDate,
    toDate: plan.week.toDate,
    title: operation.expectedTitle,
    mode: operation.mode,
    existingApplicationKey: operation.applicationKey,
    targetState: operation.targetState,
    itemCount: plan.summary.eligibleCount,
    totalJpy: plan.summary.eligibleTotalJpy,
    expenseKeysSha256: sha256Json(expenseKeys),
    items: plan.operations.eligibleExpenses.map((expense) => ({
      expenseKey: expense.expenseKey,
      transactionDate: expense.transactionDate,
      amountJpy: expense.amountJpy,
      sourceTransactionId: expense.sourceTransactionId,
    })),
  };
  return { ...content, bundleSha256: sha256Json(content) };
}

export function validateApplicationResult(result, bundle) {
  assert(bundle?.version === 1, "weekly application bundle version is invalid");
  assert(result?.version === 1, "weekly application result version is invalid");
  assert(result.planSha256 === bundle.planSha256, "weekly application result plan SHA differs");
  assert(result.bundleSha256 === bundle.bundleSha256, "weekly application result bundle SHA differs");
  assertIsoDateTime(result.observedAt, "weekly application result observedAt");
  assert(["draft_saved", "submitted", "already_complete", "failed", "uncertain"].includes(result.status), "weekly application result status is invalid");
  assertPlainText(result.applicationKey, "weekly application result applicationKey");
  for (const key of ["destinationVerified", "titleVerified", "expenseMembershipVerified"]) {
    assert(typeof result[key] === "boolean", `weekly application result ${key} is invalid`);
  }
  assert(typeof result.observedExpenseKeysSha256 === "string", "weekly application result expense digest is invalid");
  assert(Number.isSafeInteger(result.itemCount) && result.itemCount >= 0, "weekly application result itemCount is invalid");
  assert(typeof result.totalJpy === "string" && /^(?:0|[1-9]\d*)$/.test(result.totalJpy), "weekly application result totalJpy is invalid");
  assert(["draft", "submitted"].includes(result.finalState), "weekly application result finalState is invalid");
  const positive = ["draft_saved", "submitted", "already_complete"].includes(result.status);
  if (positive) {
    assert(result.destinationVerified, "weekly application result was not destination-verified");
    assert(result.titleVerified, "weekly application result title was not verified");
    assert(result.expenseMembershipVerified, "weekly application result membership was not verified");
    assert(result.observedExpenseKeysSha256 === bundle.expenseKeysSha256, "weekly application result expense membership differs");
    assert(result.itemCount === bundle.itemCount, "weekly application result itemCount differs");
    assert(result.totalJpy === bundle.totalJpy, "weekly application result total differs");
    assert(result.finalState === bundle.targetState, "weekly application result finalState differs");
    if (bundle.mode === "reuse") assert(result.applicationKey === bundle.existingApplicationKey, "weekly application result reused a different application");
    if (bundle.targetState === "draft") assert(["draft_saved", "already_complete"].includes(result.status), "weekly application result status is not a draft result");
    if (bundle.targetState === "submitted") assert(["submitted", "already_complete"].includes(result.status), "weekly application result status is not a submitted result");
  }
  return {
    complete: positive,
    status: result.status,
    itemCount: result.itemCount,
    totalJpy: result.totalJpy,
    finalState: result.finalState,
  };
}
