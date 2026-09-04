#!/usr/bin/env node

import path from "node:path";

import { isMainModule } from "../../_shared/is-main.mjs";

import {
  ProviderResolutionError,
  discoverProviders,
  readFromProvider,
  resolveProvider,
} from "@live-agency-skills/source-provider-api";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";
import { validateWeeklyApplicationSnapshot } from "./weekly_application_core.mjs";

const MODES = {
  source: { capability: "weekly-expense-application-source/v1", validate: (value) => validateWeeklyApplicationSnapshot(value).snapshot },
  application: { capability: "weekly-expense-application-sink/v1", validate: (value) => value },
};

function parseArgs(argv) {
  const args = { unattended: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--unattended") args.unattended = true;
    else if (["--mode", "--provider-root", "--request", "--output"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const key of ["mode", "providerRoot", "request", "output"]) {
    if (!args[key]) throw new TypeError(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!MODES[args.mode]) throw new TypeError("--mode must be source or application");
  return args;
}

export async function resolveWeeklyApplicationProvider(args) {
  const mode = MODES[args.mode];
  const request = await readPrivateJson(path.resolve(args.request));
  const providers = await discoverProviders({ rootDir: path.resolve(args.providerRoot) });
  const provider = await resolveProvider({
    providers,
    capability: mode.capability,
    request,
    unattended: args.unattended,
  });
  if (provider.executionKind === "instructions") {
    return {
      status: "instructions-required",
      providerPackage: provider.packageName,
      providerVersion: provider.packageVersion,
      providerBinding: provider.bindingId,
      knowledgeVersion: provider.knowledgeVersion,
      instructions: provider.instructions,
    };
  }
  const output = mode.validate(await readFromProvider(provider, request));
  await writePrivateJson(path.resolve(args.output), output);
  return {
    status: "normalized",
    providerPackage: provider.packageName,
    providerVersion: provider.packageVersion,
    providerBinding: provider.bindingId,
    knowledgeVersion: provider.knowledgeVersion,
    output,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await resolveWeeklyApplicationProvider(parseArgs(argv));
    if (result.status === "instructions-required") {
      console.log(result.instructions);
      console.error(JSON.stringify({
        status: result.status,
        providerPackage: result.providerPackage,
        providerVersion: result.providerVersion,
        providerBinding: result.providerBinding,
        knowledgeVersion: result.knowledgeVersion,
      }));
      return 10;
    }
    console.log(JSON.stringify({
      status: result.status,
      providerPackage: result.providerPackage,
      providerVersion: result.providerVersion,
      providerBinding: result.providerBinding,
      knowledgeVersion: result.knowledgeVersion,
    }));
    return 0;
  } catch (error) {
    const code = error instanceof ProviderResolutionError ? error.code : "INVALID_INPUT";
    console.error(JSON.stringify({ status: "stopped", code, message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
