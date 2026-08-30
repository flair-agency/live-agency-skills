#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { LarkBaseClient } from "@live-agency-skills/lark-base-client";

import {
  buildInsightContext,
  loadInsightConfig,
  writePrivateJson,
} from "./insight_lark_runtime.mjs";

export function parseArgs(argv) {
  const args = { mode: "due", selectedAccounts: [], limit: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--config", "--output", "--mode", "--account", "--limit"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      if (value === "--account") args.selectedAccounts.push(next);
      else if (value === "--limit") args.limit = Number(next);
      else args[value.slice(2)] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.config || !args.output) throw new TypeError("--config and --output are required");
  if (args.mode === "selected" && args.selectedAccounts.length === 0) {
    throw new TypeError("selected mode requires at least one --account");
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const config = await loadInsightConfig(args.config);
    const client = await LarkBaseClient.fromEnvironment({ origin: config.apiOrigin });
    const { context } = await buildInsightContext({
      client,
      config,
      mode: args.mode,
      selectedAccounts: args.selectedAccounts,
      limit: args.limit,
    });
    await writePrivateJson(path.resolve(args.output), context);
    const counts = context.rows.reduce((result, row) => {
      result[row.readiness] += 1;
      return result;
    }, { ready: 0, missing_profile: 0, invalid_profile: 0 });
    console.log(JSON.stringify({
      status: context.rowCount ? "success" : "unchanged",
      output: path.resolve(args.output),
      rowCount: context.rowCount,
      contextSha256: context.contextSha256,
      readiness: counts,
    }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
