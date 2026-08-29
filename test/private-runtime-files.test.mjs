import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readPrivateJson,
  writePrivateJson,
} from "@live-agency-skills/private-runtime-files";

test("writes atomic owner-only JSON and reads it back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-runtime-test-"));
  try {
    const filePath = path.join(directory, "data.json");
    await writePrivateJson(filePath, { synthetic: true });
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(filePath), { synthetic: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects loose permissions and symbolic links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-runtime-test-"));
  try {
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "link.json");
    await writeFile(target, "{}\n", { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o644);
    await assert.rejects(readPrivateJson(target), /permissions must be 0600/);
    await chmod(target, 0o600);
    await symlink(target, link);
    await assert.rejects(readPrivateJson(link), /symbolic link/);
    await assert.rejects(writePrivateJson(link, { changed: true }), /symbolic link/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
