#!/usr/bin/env node

import path from "node:path";

import {
  readPrivateJson,
  writePrivateJson,
} from "@live-agency-skills/private-runtime-files";

import { isMainModule } from "../../_shared/is-main.mjs";
import { evaluateInvitationV2DualRun } from "./invitation_v2_dual_run.mjs";

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!["--input", "--output"].includes(value)) {
      throw new TypeError(`unknown argument: ${value}`);
    }
    const next = argv[index + 1];
    if (!next) throw new TypeError(`${value} requires a value`);
    args[value.slice(2)] = next;
    index += 1;
  }
  if (!args.input || !args.output) throw new TypeError("--input and --output are required");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const result = evaluateInvitationV2DualRun(
      await readPrivateJson(path.resolve(args.input)),
    );
    await writePrivateJson(path.resolve(args.output), result);
    console.log(
      JSON.stringify({
        status: result.status,
        output: path.resolve(args.output),
        targetCount: result.targetCount,
        inputSha256: result.inputSha256,
        resultSha256: result.resultSha256,
        routeSwitchAllowed: result.cutoverGate.routeSwitchAllowed,
      }),
    );
    return result.status === "equivalent" ? 0 : 4;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
