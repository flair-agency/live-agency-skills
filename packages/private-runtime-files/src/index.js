import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;

export async function writePrivateText(filePath, text) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await lstat(resolved).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new TypeError("private output must not be a symbolic link");

  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, resolved);
    await chmod(resolved, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return resolved;
}

export function writePrivateJson(filePath, value) {
  return writePrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readPrivateText(filePath, { maxBytes = MAX_PRIVATE_JSON_BYTES } = {}) {
  const resolved = path.resolve(filePath);
  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new TypeError("private input must not be a symbolic link");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new TypeError("private input must be one regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new TypeError("private input owner is invalid");
    }
    if ((stat.mode & 0o777) !== 0o600) throw new TypeError("private input permissions must be 0600");
    if (stat.size < 1 || stat.size > maxBytes) throw new TypeError("private input size is invalid");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readPrivateJson(filePath, options) {
  const text = await readPrivateText(filePath, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`private input JSON is invalid: ${error.message}`);
  }
}

export const PRIVATE_JSON_MAX_BYTES = MAX_PRIVATE_JSON_BYTES;
