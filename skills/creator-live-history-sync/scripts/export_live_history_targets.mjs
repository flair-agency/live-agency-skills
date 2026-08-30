#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLarkBaseClient } from "../../_shared/lark-base-client.mjs";

import {
  exportLiveHistoryTargets,
  loadLiveHistoryConfig,
  writePrivateJson,
} from "./live_history_lark_runtime.mjs";

export function parseArgs(argv) {
  const args = { mode: "due", selectedAccounts: [], limit: 20 };
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
    const config = await loadLiveHistoryConfig(args.config);
    const client = await createLarkBaseClient({ origin: config.apiOrigin });
    const manifest = await exportLiveHistoryTargets({
      client,
      config,
      mode: args.mode,
      selectedAccounts: args.selectedAccounts,
      limit: args.limit,
    });
    await writePrivateJson(args.output, manifest);
    console.log(JSON.stringify({
      status: manifest.rowCount ? "success" : "unchanged",
      output: path.resolve(args.output),
      targetMode: manifest.targetMode,
      rowCount: manifest.rowCount,
      rowsSha256: manifest.rowsSha256,
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
