#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import path from "node:path";

import { readPrivateJson, writePrivateJson } from "@live-agency-skills/private-runtime-files";

import {
  giftPlanIsBlocked,
  replayGiftHistoryPlan,
  validateGiftHistoryPlan,
} from "./gift_history_core.mjs";

export const GIFT_PLAN_MAX_BYTES = 64 * 1024 * 1024;

export function readGiftCommitInputs({ planPath, currentMasterPath }) {
  return Promise.all([
    readPrivateJson(path.resolve(planPath), { maxBytes: GIFT_PLAN_MAX_BYTES }),
    readPrivateJson(path.resolve(currentMasterPath)),
  ]);
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if ([
      "--plan",
      "--current-master",
      "--output-commit",
      "--expect-sha256",
      "--confirm-add",
      "--confirm-recipient-update",
      "--confirm-target-rows",
    ].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new TypeError(`${value} requires a value`);
      args[value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = next;
      index += 1;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  for (const name of [
    "plan",
    "currentMaster",
    "outputCommit",
    "expectSha256",
    "confirmAdd",
    "confirmRecipientUpdate",
    "confirmTargetRows",
  ]) {
    if (args[name] === undefined) throw new TypeError(`${name} is required`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const [reviewedPlan, currentMaster] = await readGiftCommitInputs({
      planPath: args.plan,
      currentMasterPath: args.currentMaster,
    });
    validateGiftHistoryPlan(reviewedPlan);
    const currentPlan = replayGiftHistoryPlan({ master: currentMaster, reviewedPlan });
    if (currentPlan.planSha256 !== reviewedPlan.planSha256) {
      throw new Error("reviewed plan is stale against the current master");
    }
    if (giftPlanIsBlocked(currentPlan)) throw new Error("blocking issues prevent commit preparation");
    if (args.expectSha256 !== currentPlan.planSha256) throw new Error("expected SHA-256 does not match");
    if (Number(args.confirmAdd) !== currentPlan.summary.additionCount) throw new Error("confirmed add count does not match");
    if (Number(args.confirmRecipientUpdate) !== currentPlan.summary.recipientUpdateCount) {
      throw new Error("confirmed recipient-update count does not match");
    }
    if (Number(args.confirmTargetRows) !== currentPlan.summary.targetRowCount) {
      throw new Error("confirmed target row count does not match");
    }
    const snapshot = currentPlan.inputs.snapshot;
    const commit = {
      version: 1,
      preparedAt: new Date().toISOString(),
      planSha256: currentPlan.planSha256,
      mode: currentPlan.mode,
      target: currentPlan.target,
      evidence: currentPlan.evidence,
      syncLogEntry: {
        accountKey: snapshot.accountKey,
        snapshotDate: snapshot.snapshotDate,
        sourceSha256: snapshot.sourceSha256,
        status: currentPlan.mode === "unchanged" ? "unchanged" : "success",
      },
      summary: currentPlan.summary,
    };
    await writePrivateJson(path.resolve(args.outputCommit), commit);
    console.log(JSON.stringify({
      status: currentPlan.mode === "unchanged" ? "unchanged" : "ready",
      outputCommit: path.resolve(args.outputCommit),
      planSha256: currentPlan.planSha256,
      ...currentPlan.summary,
    }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
