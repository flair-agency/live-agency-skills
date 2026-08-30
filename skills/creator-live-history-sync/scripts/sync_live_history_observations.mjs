#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { LarkBaseClient } from "@live-agency-skills/lark-base-client";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { validateLiveHistoryObservations } from "@live-agency-skills/source-provider-api";

import {
  applyLiveHistoryPlan,
  loadLiveHistoryConfig,
  prepareLiveHistoryPlan,
} from "./live_history_lark_runtime.mjs";
import {
  livePlanIsBlocked,
  validateLiveHistorySyncPlan,
  validateLiveTargetManifest,
} from "./live_history_sync_core.mjs";

export function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if ([
      "--config",
      "--manifest",
      "--observations",
      "--output-plan",
      "--plan",
      "--expect-sha256",
      "--confirm-live-create",
      "--confirm-metric-create",
    ].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.config) throw new TypeError("--config is required");
  const preparing = args.manifest || args.observations || args.outputPlan;
  if (preparing && !(args.manifest && args.observations && args.outputPlan)) {
    throw new TypeError("plan preparation requires --manifest, --observations, and --output-plan");
  }
  if (!preparing && !args.plan) throw new TypeError("provide plan-preparation inputs or --plan");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const config = await loadLiveHistoryConfig(args.config);
    const client = await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
    if (args.manifest) {
      const [manifest, observations] = await Promise.all([
        readPrivateJson(path.resolve(args.manifest)),
        readPrivateJson(path.resolve(args.observations)),
      ]);
      validateLiveTargetManifest(manifest);
      validateLiveHistoryObservations(observations);
      const { plan } = await prepareLiveHistoryPlan({ client, config, manifest, observations });
      await writePrivateJson(path.resolve(args.outputPlan), plan);
      console.log(JSON.stringify({
        status: livePlanIsBlocked(plan) ? "blocked" : "success",
        outputPlan: path.resolve(args.outputPlan),
        flowVerification: "not_run",
        planSha256: plan.planSha256,
        ...plan.summary,
      }));
      return livePlanIsBlocked(plan) ? 4 : 0;
    }

    const plan = await readPrivateJson(path.resolve(args.plan));
    validateLiveHistorySyncPlan(plan);
    const result = await applyLiveHistoryPlan({
      client,
      config,
      reviewedPlan: plan,
      apply: args.apply,
      expectSha256: args.expectSha256,
      confirmLiveCreate: args.confirmLiveCreate,
      confirmMetricCreate: args.confirmMetricCreate,
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
