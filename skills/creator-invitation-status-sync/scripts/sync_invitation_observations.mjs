#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LarkBaseClient } from "@live-agency-skills/lark-base-client";

import {
  applyRefresh,
  loadInvitationConfig,
  prepareRefresh,
  sha256Json,
  writePrivateJson,
} from "./invitation_lark_runtime.mjs";

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new TypeError(`cannot read ${label}: ${error.message}`);
  }
}

export function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (
      [
        "--config",
        "--manifest",
        "--observations",
        "--output-plan",
        "--plan",
        "--expect-sha256",
        "--confirm-create",
        "--confirm-update",
        "--confirm-attach",
      ].includes(value)
    ) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      const key = value
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = value.startsWith("--confirm-") ? Number(next) : next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.config) throw new TypeError("--config is required");
  if (args.apply) {
    if (!args.plan || args.manifest || args.observations || args.outputPlan) {
      throw new TypeError("apply mode requires --plan and no raw inputs");
    }
    if (!/^[0-9a-f]{64}$/.test(args.expectSha256 ?? "")) {
      throw new TypeError("apply mode requires --expect-sha256");
    }
    for (const key of ["confirmCreate", "confirmUpdate", "confirmAttach"]) {
      if (!Number.isSafeInteger(args[key]) || args[key] < 0) {
        throw new TypeError(`apply mode requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      }
    }
  } else if (!args.manifest || !args.observations || !args.outputPlan || args.plan) {
    throw new TypeError("dry-run mode requires --manifest, --observations, and --output-plan");
  }
  return args;
}

function summary(prepared) {
  return {
    planSha256: prepared.planSha256,
    blocked: prepared.blocked,
    ...prepared.counts,
    identityConflicts: prepared.corePlan.identityConflicts,
    ambiguousLatest: prepared.corePlan.ambiguousLatest,
    staleObservations: prepared.corePlan.staleObservations,
    invalidStored: prepared.corePlan.invalidStored,
  };
}

export async function dryRun({ client, config, manifest, observations, outputPlan }) {
  const prepared = await prepareRefresh({ client, config, manifest, observations });
  const plan = {
    version: 1,
    operationMode: "refresh",
    generatedAt: new Date().toISOString(),
    manifest,
    observations,
    operations: prepared.operations,
    counts: prepared.counts,
    planSha256: prepared.planSha256,
  };
  await writePrivateJson(outputPlan, plan);
  return summary(prepared);
}

export async function applyReviewed({ client, config, reviewed, args }) {
  if (reviewed?.version !== 1 || reviewed?.operationMode !== "refresh") {
    throw new TypeError("reviewed plan format is invalid");
  }
  const storedHash = sha256Json({
    manifest: reviewed.manifest,
    observations: reviewed.observations,
  });
  if (storedHash !== reviewed.planSha256 || storedHash !== args.expectSha256) {
    throw new TypeError("reviewed plan hash is invalid");
  }
  return applyRefresh({
    client,
    config,
    manifest: reviewed.manifest,
    observations: reviewed.observations,
    expectedPlanSha256: args.expectSha256,
    confirmCreate: args.confirmCreate,
    confirmUpdate: args.confirmUpdate,
    confirmAttach: args.confirmAttach,
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const config = await loadInvitationConfig(args.config);
    const client = await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
    if (!args.apply) {
      const result = await dryRun({
        client,
        config,
        manifest: await readJson(args.manifest, "target manifest"),
        observations: await readJson(args.observations, "normalized observations"),
        outputPlan: args.outputPlan,
      });
      console.log(JSON.stringify({ status: "dry-run", outputPlan: path.resolve(args.outputPlan), ...result }));
      return result.blocked ? 4 : 0;
    }
    const result = await applyReviewed({
      client,
      config,
      reviewed: await readJson(args.plan, "reviewed plan"),
      args,
    });
    console.log(JSON.stringify({ status: "success", ...result }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
