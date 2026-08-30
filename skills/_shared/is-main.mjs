import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}
