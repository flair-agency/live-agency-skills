#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import { buildCoinExpensePlan } from "./coin_expense_core.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--purchases", "--expenses", "--output-plan"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const key of ["purchases", "expenses", "outputPlan"]) {
    if (!args[key]) throw new TypeError(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const [purchaseEvidence, expenseCandidates] = await Promise.all([
      readPrivateJson(path.resolve(args.purchases)),
      readPrivateJson(path.resolve(args.expenses)),
    ]);
    const plan = buildCoinExpensePlan({ purchaseEvidence, expenseCandidates });
    await writePrivateJson(path.resolve(args.outputPlan), plan);
    console.log(JSON.stringify({ status: plan.summary.blockingIssueCount ? "blocked" : "planned", planSha256: plan.planSha256, ...plan.summary }));
    return plan.summary.blockingIssueCount ? 3 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
