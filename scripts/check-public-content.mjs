import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", "coverage"]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:token|secret|password)\s*[=:]\s*["'][^"']{8,}["']/i,
  /\b(?:app|client)[_-]?secret\s*[=:]/i,
];

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(target)));
    else result.push(target);
  }
  return result;
}

const findings = [];
for (const filePath of await files(rootDir)) {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) findings.push(`${path.relative(rootDir, filePath)}: ${pattern}`);
  }
}

if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public-content checks passed.");
}
