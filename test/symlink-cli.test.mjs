import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a skill CLI starts when invoked through an installed skill symlink", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "live-agency-symlink-cli-"));
  try {
    const installedSkill = path.join(temporaryRoot, "creator-invitation-status-sync");
    await symlink(
      path.join(repositoryRoot, "skills", "creator-invitation-status-sync"),
      installedSkill,
      "dir",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(installedSkill, "scripts", "export_invitation_targets.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--config and --output are required/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
