#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import path from "node:path";

import { readPrivateJson } from "@live-agency-skills/private-runtime-files";

import { validateRegistrationResult } from "./coin_expense_core.mjs";

export async function main(argv = process.argv.slice(2)) {
  try {
    const bundleIndex = argv.indexOf("--bundle");
    const resultIndex = argv.indexOf("--result");
    if (bundleIndex < 0 || !argv[bundleIndex + 1] || resultIndex < 0 || !argv[resultIndex + 1]) {
      throw new TypeError("--bundle and --result are required");
    }
    const [bundle, result] = await Promise.all([
      readPrivateJson(path.resolve(argv[bundleIndex + 1])),
      readPrivateJson(path.resolve(argv[resultIndex + 1])),
    ]);
    const summary = validateRegistrationResult(result, bundle);
    console.log(JSON.stringify({ status: summary.complete ? "verified" : "incomplete", ...summary }));
    return summary.complete ? 0 : 4;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
