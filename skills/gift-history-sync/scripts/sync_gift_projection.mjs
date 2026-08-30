#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createLarkBaseClient } from "../../_shared/lark-base-client.mjs";
import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  buildProjectionPlan,
  normalizeProjectionTarget,
  projectionMatchesTarget,
  projectionPayload,
  resolveProjectionFields,
  validateProjectionConfig,
} from "./gift_projection_core.mjs";

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if ([
      "--config", "--projection", "--target", "--backup-dir", "--expect-sha256",
      "--confirm-create", "--confirm-update", "--confirm-delete",
    ].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const key of ["config", "projection", "target"]) assert(args[key], `--${key} is required`);
  return args;
}

async function currentState(client, config) {
  const [fields, records] = await Promise.all([
    client.listFields(config.appToken, config.tableId),
    client.listRecords(config.appToken, config.tableId),
  ]);
  const bindings = resolveProjectionFields(fields, config);
  return { bindings, records };
}

function summaryOutput(plan, status) {
  return { status, planSha256: plan.planSha256, ...plan.summary };
}

async function backupState(directory, config, target, plan, records) {
  assert(directory && path.isAbsolute(directory), "projection backup directory must be absolute");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    directory,
    `${config.projectionKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writePrivateJson(filePath, {
    version: 1,
    capturedAt: new Date().toISOString(),
    projectionKey: config.projectionKey,
    target,
    reviewedPlan: summaryOutput(plan, "reviewed"),
    rawLarkRecords: records,
  });
  return filePath;
}

async function verifyOrThrow(client, config, target) {
  const latest = await currentState(client, config);
  const verification = projectionMatchesTarget(latest.records, latest.bindings, config, target);
  if (!verification.matches) {
    throw new Error(
      `post-write verification failed: create=${verification.plan.summary.createCount} ` +
      `update=${verification.plan.summary.updateCount} delete=${verification.plan.summary.deleteCount}`,
    );
  }
  return verification.plan;
}

async function applyPlan(client, config, target, state, plan) {
  const updateRecords = plan.operations.updates.map((operation) => ({
    record_id: operation.recordId,
    fields: projectionPayload(operation.row, state.bindings, config, { includeKeys: false }),
  }));
  const createRecords = plan.operations.creates.map((row) => ({
    fields: projectionPayload(row, state.bindings, config, { includeKeys: true }),
  }));
  try {
    for (let index = 0; index < updateRecords.length; index += 500) {
      await client.batchUpdate(config.appToken, config.tableId, updateRecords.slice(index, index + 500));
    }
    for (let index = 0; index < createRecords.length; index += 500) {
      await client.batchCreate(config.appToken, config.tableId, createRecords.slice(index, index + 500));
    }
    for (let index = 0; index < plan.operations.deletes.length; index += 500) {
      await client.batchDelete(
        config.appToken,
        config.tableId,
        plan.operations.deletes.slice(index, index + 500).map((operation) => operation.recordId),
      );
    }
  } catch (error) {
    const verification = await currentState(client, config).then((latest) =>
      projectionMatchesTarget(latest.records, latest.bindings, config, target),
    ).catch(() => null);
    if (!verification?.matches) throw error;
  }
  return verifyOrThrow(client, config, target);
}

export async function run(argv = process.argv.slice(2), { client } = {}) {
  const args = parseArgs(argv);
  const workspace = await readPrivateJson(path.resolve(args.config));
  const config = validateProjectionConfig(workspace, args.projection);
  const target = normalizeProjectionTarget(await readPrivateJson(path.resolve(args.target)), config);
  const lark = client ?? await createLarkBaseClient({
    env: {
      ...process.env,
      LARK_KEYCHAIN_SERVICE:
        process.env.LARK_KEYCHAIN_SERVICE ?? workspace.credentials?.larkKeychainService,
    },
  });
  const state = await currentState(lark, config);
  const plan = buildProjectionPlan({ target, records: state.records, bindings: state.bindings, config });
  if (!args.apply) return summaryOutput(plan, plan.summary.createCount || plan.summary.updateCount || plan.summary.deleteCount ? "ready" : "unchanged");

  assert(args.expectSha256 === target.rowsSha256, "--expect-sha256 does not match the reviewed target");
  for (const [argument, summaryKey] of [
    ["confirmCreate", "createCount"],
    ["confirmUpdate", "updateCount"],
    ["confirmDelete", "deleteCount"],
  ]) {
    const number = Number(args[argument]);
    assert(Number.isSafeInteger(number) && number >= 0, `--${argument.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    assert(number === plan.summary[summaryKey], `${argument} does not match the live diff`);
  }
  if (!plan.summary.createCount && !plan.summary.updateCount && !plan.summary.deleteCount) {
    return summaryOutput(plan, "unchanged");
  }
  const backupDir = args.backupDir ?? config.backupDir;
  const backupPath = await backupState(backupDir, config, target, plan, state.records);
  const verification = await applyPlan(lark, config, target, state, plan);
  return { ...summaryOutput(plan, "applied-and-verified"), backupPath, verificationPlanSha256: verification.planSha256 };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(await run(argv)));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
