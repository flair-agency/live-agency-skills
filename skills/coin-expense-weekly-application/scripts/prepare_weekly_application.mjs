#!/usr/bin/env node

import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import {
  buildApplicationBundle,
  replayWeeklyApplicationPlan,
  validateWeeklyApplicationPlan,
} from "./weekly_application_core.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--plan", "--fresh-input", "--approved-plan-sha", "--output"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const key of ["plan", "freshInput", "approvedPlanSha", "output"]) {
    if (!args[key]) throw new TypeError(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const reviewedPlan = validateWeeklyApplicationPlan(await readPrivateJson(path.resolve(args.plan)));
    if (args.approvedPlanSha !== reviewedPlan.planSha256) throw new TypeError("approved plan SHA does not match the reviewed plan");
    const snapshot = await readPrivateJson(path.resolve(args.freshInput));
    const replayed = replayWeeklyApplicationPlan({ snapshot, reviewedPlan });
    if (replayed.planSha256 !== reviewedPlan.planSha256) throw new TypeError("weekly application inputs changed after review");
    const bundle = buildApplicationBundle(replayed);
    await writePrivateJson(path.resolve(args.output), bundle);
    console.log(JSON.stringify({
      status: "prepared",
      planSha256: bundle.planSha256,
      bundleSha256: bundle.bundleSha256,
      isoWeek: bundle.isoWeek,
      mode: bundle.mode,
      targetState: bundle.targetState,
      itemCount: bundle.itemCount,
      totalJpy: bundle.totalJpy,
    }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

process.exitCode = await main();
