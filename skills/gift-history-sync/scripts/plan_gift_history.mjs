#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { validateGiftHistorySnapshot } from "@live-agency-skills/source-provider-api";

import {
  buildGiftHistoryPlan,
  giftPlanIsBlocked,
  validateGiftMaster,
} from "./gift_history_core.mjs";

export function parseArgs(argv) {
  const args = { allowSameDateReplacement: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-same-date-replacement") args.allowSameDateReplacement = true;
    else if (["--master", "--snapshot", "--output-plan"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const name of ["master", "snapshot", "outputPlan"]) {
    if (!args[name]) throw new TypeError(`${name} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const [master, snapshot] = await Promise.all([
      readPrivateJson(path.resolve(args.master)),
      readPrivateJson(path.resolve(args.snapshot)),
    ]);
    validateGiftMaster(master);
    validateGiftHistorySnapshot(snapshot);
    const plan = buildGiftHistoryPlan({
      master,
      snapshot,
      allowSameDateReplacement: args.allowSameDateReplacement,
    });
    await writePrivateJson(path.resolve(args.outputPlan), plan);
    console.log(JSON.stringify({
      status: giftPlanIsBlocked(plan) ? "blocked" : plan.mode === "unchanged" ? "unchanged" : "success",
      outputPlan: path.resolve(args.outputPlan),
      planSha256: plan.planSha256,
      mode: plan.mode,
      ...plan.summary,
    }));
    return giftPlanIsBlocked(plan) ? 4 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
