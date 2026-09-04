#!/usr/bin/env node

import path from "node:path";

import { readPrivateJson } from "@live-agency-skills/private-runtime-files";
import { validateApplicationResult } from "./weekly_application_core.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--bundle", "--result"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2)] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.bundle || !args.result) throw new TypeError("--bundle and --result are required");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const bundle = await readPrivateJson(path.resolve(args.bundle));
    const result = await readPrivateJson(path.resolve(args.result));
    const summary = validateApplicationResult(result, bundle);
    console.log(JSON.stringify({ status: summary.complete ? "verified" : "incomplete", ...summary }));
    return summary.complete ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

process.exitCode = await main();
