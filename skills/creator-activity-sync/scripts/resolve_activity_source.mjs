#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTIVITY_CAPABILITY,
  ProviderResolutionError,
  discoverProviders,
  readFromProvider,
  resolveProvider,
  validateActivitySnapshot,
} from "@live-agency-skills/source-provider-api";

export function parseArgs(argv) {
  const args = { unattended: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--unattended") args.unattended = true;
    else if (["--provider-root", "--request", "--output"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace("provider-root", "providerRoot")] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const name of ["providerRoot", "request", "output"]) {
    if (!args[name]) throw new TypeError(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return args;
}

export async function resolveActivitySource(args) {
  const request = JSON.parse(await readFile(path.resolve(args.request), "utf8"));
  const providers = await discoverProviders({ rootDir: path.resolve(args.providerRoot) });
  const provider = await resolveProvider({
    providers,
    capability: ACTIVITY_CAPABILITY,
    request,
    unattended: args.unattended,
  });
  if (provider.executionKind !== "module") {
    throw new ProviderResolutionError(
      "INTERACTIVE_PROVIDER",
      "The selected provider requires private agent instructions; normalize the data interactively",
    );
  }
  const snapshot = validateActivitySnapshot(await readFromProvider(provider, request));
  await writeFile(path.resolve(args.output), `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { providerPackage: provider.packageName, providerVersion: provider.packageVersion, snapshot };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await resolveActivitySource(parseArgs(argv));
    console.log(
      JSON.stringify({
        status: "normalized",
        providerPackage: result.providerPackage,
        providerVersion: result.providerVersion,
        month: result.snapshot.month,
        rowCount: result.snapshot.rowCount,
      }),
    );
    return 0;
  } catch (error) {
    const code = error instanceof ProviderResolutionError ? error.code : "INVALID_INPUT";
    console.error(JSON.stringify({ status: "stopped", code, message: error.message }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
