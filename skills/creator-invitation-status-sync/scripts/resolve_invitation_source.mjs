#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  INVITATION_CAPABILITY,
  ProviderResolutionError,
  discoverProviders,
  readFromProvider,
  resolveProvider,
  validateInvitationObservations,
} from "@live-agency-skills/source-provider-api";
import {
  readPrivateJson,
  writePrivateJson,
} from "@live-agency-skills/private-runtime-files";

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
    if (!args[name]) throw new TypeError(`${name} is required`);
  }
  return args;
}

export async function resolveInvitationSource(args) {
  const request = await readPrivateJson(path.resolve(args.request));
  const providers = await discoverProviders({ rootDir: path.resolve(args.providerRoot) });
  const provider = await resolveProvider({
    providers,
    capability: INVITATION_CAPABILITY,
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
  const observations = validateInvitationObservations(await readFromProvider(provider, request));
  await writePrivateJson(path.resolve(args.output), observations);
  return {
    status: "normalized",
    providerPackage: provider.packageName,
    providerVersion: provider.packageVersion,
    providerBinding: provider.bindingId,
    knowledgeVersion: provider.knowledgeVersion,
    observations,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await resolveInvitationSource(parseArgs(argv));
    if (result.status === "instructions-required") {
      console.log(result.instructions);
      console.error(
        JSON.stringify({
          status: result.status,
          providerPackage: result.providerPackage,
          providerVersion: result.providerVersion,
          providerBinding: result.providerBinding,
          knowledgeVersion: result.knowledgeVersion,
        }),
      );
      return 10;
    }
    console.log(
      JSON.stringify({
        status: result.status,
        providerPackage: result.providerPackage,
        providerVersion: result.providerVersion,
        providerBinding: result.providerBinding,
        knowledgeVersion: result.knowledgeVersion,
        observedAt: result.observations.observedAt,
        rowCount: result.observations.rowCount,
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
