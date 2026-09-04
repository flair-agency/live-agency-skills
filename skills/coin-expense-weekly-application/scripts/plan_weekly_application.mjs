#!/usr/bin/env node

import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { buildWeeklyApplicationPlan } from "./weekly_application_core.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--input", "--output", "--now"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2)] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.input || !args.output) throw new TypeError("--input and --output are required");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const nowMs = args.now === undefined ? Date.now() : Date.parse(args.now);
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("--now must be an ISO timestamp");
    const snapshot = await readPrivateJson(path.resolve(args.input));
    const plan = buildWeeklyApplicationPlan({ snapshot, nowMs });
    await writePrivateJson(path.resolve(args.output), plan);
    console.log(JSON.stringify({
      status: plan.operations.blockingIssues.length ? "blocked" : "planned",
      planSha256: plan.planSha256,
      isoWeek: plan.week.isoWeek,
      fromDate: plan.week.fromDate,
      toDate: plan.week.toDate,
      mode: plan.operations.application.mode,
      targetState: plan.operations.application.targetState,
      eligibleCount: plan.summary.eligibleCount,
      excludedCount: plan.summary.excludedCount,
      totalJpy: plan.summary.eligibleTotalJpy,
      blockingIssueCount: plan.summary.blockingIssueCount,
      willWrite: plan.summary.willWrite,
    }));
    return plan.operations.blockingIssues.length ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

process.exitCode = await main();
