#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  buildRegistrationBundle,
  coinExpensePlanIsBlocked,
  replayCoinExpensePlan,
  validateCoinExpensePlan,
} from "./coin_expense_core.mjs";

function parseArgs(argv) {
  const args = {};
  const names = [
    "--plan", "--current-purchases", "--current-expenses", "--output-bundle",
    "--expect-sha256", "--confirm-match-count", "--confirm-total-jpy",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!names.includes(value)) throw new TypeError(`unknown argument: ${value}`);
    const next = argv[index + 1];
    if (!next) throw new TypeError(`${value} requires a value`);
    args[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    index += 1;
  }
  for (const value of names) {
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (args[key] === undefined) throw new TypeError(`${value} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const [reviewedPlan, purchaseEvidence, expenseCandidates] = await Promise.all([
      readPrivateJson(path.resolve(args.plan)),
      readPrivateJson(path.resolve(args.currentPurchases)),
      readPrivateJson(path.resolve(args.currentExpenses)),
    ]);
    validateCoinExpensePlan(reviewedPlan);
    const currentPlan = replayCoinExpensePlan({ purchaseEvidence, expenseCandidates, reviewedPlan });
    if (currentPlan.planSha256 !== reviewedPlan.planSha256) throw new Error("reviewed plan is stale");
    if (coinExpensePlanIsBlocked(currentPlan)) throw new Error("blocking issues prevent registration");
    if (args.expectSha256 !== currentPlan.planSha256) throw new Error("expected SHA-256 does not match");
    if (Number(args.confirmMatchCount) !== currentPlan.summary.exactMatchCount) {
      throw new Error("confirmed match count does not match");
    }
    if (String(args.confirmTotalJpy) !== currentPlan.summary.exactMatchTotalJpy) {
      throw new Error("confirmed JPY total does not match");
    }
    const bundle = buildRegistrationBundle(currentPlan);
    await writePrivateJson(path.resolve(args.outputBundle), bundle);
    console.log(JSON.stringify({
      status: bundle.itemCount ? "ready-for-action-confirmation" : "unchanged",
      planSha256: bundle.planSha256,
      bundleSha256: bundle.bundleSha256,
      itemCount: bundle.itemCount,
      totalJpy: bundle.totalJpy,
    }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
