#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { LarkBaseClient } from "@live-agency-skills/lark-base-client";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  applyInsightPlan,
  loadInsightConfig,
  prepareInsightPlan,
} from "./insight_lark_runtime.mjs";
import {
  insightPlanIsBlocked,
  validateInsightContext,
  validateInsightPlan,
  validateInsightProposals,
} from "./insight_sync_core.mjs";

export function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if ([
      "--config",
      "--context",
      "--proposals",
      "--output-plan",
      "--plan",
      "--expect-sha256",
      "--confirm-update",
    ].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.config) throw new TypeError("--config is required");
  const preparing = args.context || args.proposals || args.outputPlan;
  if (preparing && !(args.context && args.proposals && args.outputPlan)) {
    throw new TypeError("plan preparation requires --context, --proposals, and --output-plan");
  }
  if (!preparing && !args.plan) throw new TypeError("provide plan-preparation inputs or --plan");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const config = await loadInsightConfig(args.config);
    const client = await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
    if (args.context) {
      const [context, proposals] = await Promise.all([
        readPrivateJson(path.resolve(args.context)),
        readPrivateJson(path.resolve(args.proposals)),
      ]);
      validateInsightContext(context);
      validateInsightProposals(proposals, context);
      const { plan } = await prepareInsightPlan({ client, config, context, proposals });
      await writePrivateJson(path.resolve(args.outputPlan), plan);
      console.log(JSON.stringify({
        status: insightPlanIsBlocked(plan) ? "blocked" : plan.summary.updateCount ? "success" : "unchanged",
        outputPlan: path.resolve(args.outputPlan),
        planSha256: plan.planSha256,
        ...plan.summary,
      }));
      return insightPlanIsBlocked(plan) ? 4 : 0;
    }

    const plan = await readPrivateJson(path.resolve(args.plan));
    validateInsightPlan(plan);
    const result = await applyInsightPlan({
      client,
      config,
      reviewedPlan: plan,
      apply: args.apply,
      expectSha256: args.expectSha256,
      confirmUpdate: args.confirmUpdate,
    });
    console.log(JSON.stringify(result));
    return result.status === "blocked" ? 4 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
