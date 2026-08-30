#!/usr/bin/env node

import { isMainModule } from "../../_shared/is-main.mjs";

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { validateActivitySnapshot } from "@live-agency-skills/source-provider-api";
import { readPrivateJson } from "@live-agency-skills/private-runtime-files";

const DEFAULT_API_ORIGIN = "https://open.larksuite.com";
const MAX_BATCH_SIZE = 200;
const SECURITY_BIN = "/usr/bin/security";

export class SyncError extends Error {
  constructor(message, exitCode = 2, report = null) {
    super(message);
    this.name = "SyncError";
    this.exitCode = exitCode;
    this.report = report;
  }
}

export class ApiError extends SyncError {
  constructor(message) {
    super(message, 3);
    this.name = "ApiError";
  }
}

export class ReconciliationError extends SyncError {
  constructor(message, report = null) {
    super(message, 4, report);
    this.name = "ReconciliationError";
  }
}

export class VerificationError extends SyncError {
  constructor(message) {
    super(message, 5);
    this.name = "VerificationError";
  }
}

export function normalizeAccountKey(value) {
  let normalized = String(value).normalize("NFKC").trim();
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  return normalized.toLocaleLowerCase("und");
}

export function normalizeMonth(value) {
  const match = String(value).trim().match(/^(\d{4})[-/]?(\d{2})$/);
  if (!match) throw new SyncError(`month must be YYYY-MM or YYYYMM: ${value}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new SyncError(`invalid month: ${value}`);
  return `${match[1]}-${match[2]}`;
}

function monthDays(month) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value, 0)).getUTCDate();
}

export function normalizeSnapshot(raw, monthOverride) {
  const snapshot = validateActivitySnapshot(raw);
  const month = normalizeMonth(snapshot.month);
  if (monthOverride && normalizeMonth(monthOverride) !== month) {
    throw new SyncError(`input month ${month} does not match requested month ${normalizeMonth(monthOverride)}`);
  }
  const seen = new Map();
  const creators = snapshot.creators.map((creator) => {
    const accountKey = normalizeAccountKey(creator.accountKey);
    if (!accountKey) throw new SyncError("accountKey must not be empty after normalization");
    if (seen.has(accountKey)) {
      throw new SyncError(`accountKey is duplicated after normalization: ${creator.accountKey}`);
    }
    seen.set(accountKey, creator.accountKey);
    if (creator.effectiveLiveDays > monthDays(month)) {
      throw new SyncError(
        `${creator.accountKey}.effectiveLiveDays exceeds the number of days in ${month}`,
      );
    }
    return { ...creator, accountKey };
  });
  return { ...snapshot, month, creators };
}

export async function loadSnapshot(filePath, monthOverride) {
  let raw;
  try {
    raw = await readPrivateJson(path.resolve(filePath));
  } catch (error) {
    throw new SyncError(`cannot read normalized input JSON: ${error.message}`);
  }
  return normalizeSnapshot(raw, monthOverride);
}

export async function loadConfig(filePath) {
  let config;
  try {
    config = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new SyncError(`cannot read Lark configuration: ${error.message}`);
  }
  for (const key of ["appToken", "tableId"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new SyncError(`Lark configuration ${key} is required`);
    }
  }
  const fieldIds = config.fieldIds;
  const keys = ["month", "account", "diamonds", "effectiveLiveDays", "liveMinutes"];
  if (!fieldIds || typeof fieldIds !== "object") {
    throw new SyncError("Lark configuration fieldIds is required");
  }
  const values = keys.map((key) => {
    const value = fieldIds[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new SyncError(`Lark configuration fieldIds.${key} is required`);
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new SyncError("Lark configuration field IDs must be distinct");
  }
  return {
    appToken: config.appToken,
    tableId: config.tableId,
    fieldIds: Object.fromEntries(keys.map((key, index) => [key, values[index]])),
    credentials: typeof config.credentials?.larkKeychainService === "string" && config.credentials.larkKeychainService.trim()
      ? { larkKeychainService: config.credentials.larkKeychainService.trim() }
      : {},
    apiOrigin: config.apiOrigin ?? DEFAULT_API_ORIGIN,
  };
}

function scalars(value) {
  if (Array.isArray(value)) return value.flatMap(scalars);
  if (value && typeof value === "object") return Object.values(value).flatMap(scalars);
  return [value];
}

export function accountKeysFromCell(value) {
  return new Set(
    scalars(value)
      .filter((item) => typeof item === "string" && item.trim())
      .map(normalizeAccountKey)
      .filter(Boolean),
  );
}

function spreadsheetSerialToMonth(value) {
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + value * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthsFromCell(value) {
  const result = new Set();
  for (const item of scalars(value)) {
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (item >= 1_000_000_000_000 && item < 10_000_000_000_000) {
        const date = new Date(item);
        result.add(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
          }).format(date),
        );
      } else if (item >= 1 && item < 1_000_000) result.add(spreadsheetSerialToMonth(item));
      continue;
    }
    if (typeof item === "string") {
      const text = item.normalize("NFKC").trim();
      const match = text.match(/(?<!\d)(\d{4})[-/.年](\d{1,2})(?:[-/.月]|月)/);
      if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
        result.add(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`);
      } else if (/^\d{13}$/.test(text)) {
        const date = new Date(Number(text));
        result.add(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
          }).format(date),
        );
      }
    }
  }
  return result;
}

export function numericFromCell(value) {
  const candidates = new Set();
  for (const item of scalars(value)) {
    if (item === null || typeof item === "boolean") continue;
    if (Number.isInteger(item)) candidates.add(item);
    else if (typeof item === "string" && /^-?\d+$/.test(item.trim().replaceAll(",", ""))) {
      candidates.add(Number(item.trim().replaceAll(",", "")));
    }
  }
  if (candidates.size === 0) return null;
  if (candidates.size > 1) {
    throw new ReconciliationError(`numeric field contains multiple values: ${[...candidates]}`);
  }
  return [...candidates][0];
}

export function resolveFields(fields, fieldIds) {
  const byId = new Map();
  for (const field of fields) {
    if (typeof field.field_id !== "string") continue;
    const entries = byId.get(field.field_id) ?? [];
    entries.push(field);
    byId.set(field.field_id, entries);
  }
  const bind = (key) => {
    const id = fieldIds[key];
    const entries = byId.get(id) ?? [];
    if (entries.length !== 1) {
      throw new ReconciliationError(
        entries.length === 0 ? `required field ID is missing: ${id}` : `field ID is duplicated: ${id}`,
      );
    }
    const field = entries[0];
    if (typeof field.field_name !== "string" || !field.field_name) {
      throw new ReconciliationError(`current field name is unavailable for ID: ${id}`);
    }
    return { id, name: field.field_name, type: field.type };
  };
  const bindings = Object.fromEntries(
    ["month", "account", "diamonds", "effectiveLiveDays", "liveMinutes"].map((key) => [
      key,
      bind(key),
    ]),
  );
  const names = Object.values(bindings).map((binding) => binding.name);
  if (new Set(names).size !== names.length) {
    throw new ReconciliationError("resolved field names are not unique");
  }
  for (const key of ["diamonds", "effectiveLiveDays", "liveMinutes"]) {
    if (Number(bindings[key].type) !== 2) {
      throw new ReconciliationError(`metric destination is not numeric: ${bindings[key].id}`);
    }
  }
  return bindings;
}

export function buildPlan(records, snapshot, bindings) {
  const monthly = records.filter((record) =>
    monthsFromCell(record.fields?.[bindings.month.name]).has(snapshot.month),
  );
  const rows = [];
  const updates = [];
  const errors = [];
  for (const creator of snapshot.creators) {
    const matches = monthly.filter((record) =>
      accountKeysFromCell(record.fields?.[bindings.account.name]).has(creator.accountKey),
    );
    if (matches.length === 0) {
      errors.push(`${creator.accountKey}: no destination record in ${snapshot.month}`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(
        `${creator.accountKey}: multiple destination records (${matches.map((row) => row.record_id).join(", ")})`,
      );
      continue;
    }
    const record = matches[0];
    if (typeof record.record_id !== "string" || !record.record_id) {
      errors.push(`${creator.accountKey}: destination record ID is missing`);
      continue;
    }
    const current = {
      diamonds: numericFromCell(record.fields?.[bindings.diamonds.name]),
      effectiveLiveDays: numericFromCell(record.fields?.[bindings.effectiveLiveDays.name]),
      liveMinutes: numericFromCell(record.fields?.[bindings.liveMinutes.name]),
    };
    const desired = {
      diamonds: creator.diamonds,
      effectiveLiveDays: creator.effectiveLiveDays,
      liveMinutes: creator.liveMinutes,
    };
    const changed = Object.keys(desired).some((key) => current[key] !== desired[key]);
    rows.push({
      accountKey: creator.accountKey,
      recordId: record.record_id,
      status: changed ? "change" : "unchanged",
      current,
      desired,
    });
    if (changed) {
      updates.push({
        record_id: record.record_id,
        fields: {
          [bindings.diamonds.name]: desired.diamonds,
          [bindings.effectiveLiveDays.name]: desired.effectiveLiveDays,
          [bindings.liveMinutes.name]: desired.liveMinutes,
        },
      });
    }
  }
  return { rows, updates, errors };
}

function report(snapshot, plan, mode, verified = false) {
  return {
    mode,
    month: snapshot.month,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    sourceCreatorCount: snapshot.rowCount,
    matchedCount: plan.rows.length,
    changeCount: plan.rows.filter((row) => row.status === "change").length,
    unchangedCount: plan.rows.filter((row) => row.status === "unchanged").length,
    verified,
    errors: plan.errors,
    rows: plan.rows,
  };
}

function parseCredentialPayload(payload) {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed.app_id && parsed.app_secret) return [parsed.app_id, parsed.app_secret];
  } catch {}
  const values = Object.fromEntries(
    payload
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim().toUpperCase(), line.slice(index + 1).trim()];
      }),
  );
  if (values.APP_ID && values.APP_SECRET) return [values.APP_ID, values.APP_SECRET];
  if (values.LARK_APP_ID && values.LARK_APP_SECRET) {
    return [values.LARK_APP_ID, values.LARK_APP_SECRET];
  }
  return null;
}

function keychainCredentials(service) {
  const metadata = spawnSync(SECURITY_BIN, ["find-generic-password", "-s", service], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (metadata.status !== 0) throw new SyncError("cannot read the selected keychain item");
  const password = spawnSync(SECURITY_BIN, ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (password.status !== 0) throw new SyncError("cannot read the selected keychain password");
  const embedded = parseCredentialPayload(password.stdout.trim());
  if (embedded) return embedded;
  const account = metadata.stdout.match(/"acct"<blob>="([^"]*)"/)?.[1]?.trim();
  const secret = password.stdout.trim();
  if (!account || !secret) throw new SyncError("the selected keychain item lacks app credentials");
  return [account, secret];
}

export class LarkClient {
  constructor(token, { origin = DEFAULT_API_ORIGIN, fetchImpl = fetch } = {}) {
    this.token = token;
    this.origin = origin.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  static async fromEnvironment({ origin = DEFAULT_API_ORIGIN, env = process.env, fetchImpl = fetch } = {}) {
    if (env.LARK_TENANT_ACCESS_TOKEN?.trim()) {
      return new LarkClient(env.LARK_TENANT_ACCESS_TOKEN.trim(), { origin, fetchImpl });
    }
    let appId = env.LARK_APP_ID?.trim();
    let appSecret = env.LARK_APP_SECRET?.trim();
    if (Boolean(appId) !== Boolean(appSecret)) {
      throw new SyncError("LARK_APP_ID and LARK_APP_SECRET must be supplied together");
    }
    if (!appId) {
      const service = env.LARK_KEYCHAIN_SERVICE?.trim();
      if (!service) throw new SyncError("Lark credentials are not configured");
      [appId, appSecret] = keychainCredentials(service);
    }
    const client = new LarkClient("", { origin, fetchImpl });
    const response = await client.request("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
      payload: { app_id: appId, app_secret: appSecret },
      authorization: false,
      retry: true,
    });
    if (typeof response.tenant_access_token !== "string" || !response.tenant_access_token) {
      throw new ApiError("tenant access token is missing from the authentication response");
    }
    return new LarkClient(response.tenant_access_token, { origin, fetchImpl });
  }

  async request(method, apiPath, { params = {}, payload, authorization = true, retry } = {}) {
    const url = new URL(`${this.origin}${apiPath}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    const attempts = retry ?? method === "GET" ? 3 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const headers = { "Content-Type": "application/json; charset=utf-8" };
        if (authorization) headers.Authorization = `Bearer ${this.token}`;
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        const text = await response.text();
        let decoded;
        try {
          decoded = text ? JSON.parse(text) : {};
        } catch {
          throw new ApiError("Lark API returned invalid JSON");
        }
        if (!response.ok) throw new ApiError(`Lark API HTTP ${response.status}`);
        if (!decoded || typeof decoded !== "object" || decoded.code !== 0) {
          throw new ApiError(`Lark API error code=${decoded?.code} msg=${decoded?.msg ?? ""}`);
        }
        return decoded;
      } catch (error) {
        lastError = error instanceof SyncError ? error : new ApiError(`Lark API request failed: ${error.message}`);
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
      }
    }
    throw lastError;
  }

  async listFields(appToken, tableId) {
    const result = [];
    let pageToken;
    do {
      const response = await this.request(
        "GET",
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
        { params: { page_size: 100, page_token: pageToken } },
      );
      result.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
      if (response.data?.has_more && !pageToken) throw new ApiError("field page token is missing");
    } while (pageToken);
    return result;
  }

  async listRecords(appToken, tableId) {
    const result = [];
    let pageToken;
    do {
      const response = await this.request(
        "GET",
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
        { params: { page_size: 500, page_token: pageToken } },
      );
      result.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
      if (response.data?.has_more && !pageToken) throw new ApiError("record page token is missing");
    } while (pageToken);
    return result;
  }

  async batchUpdate(appToken, tableId, updates) {
    if (updates.length > MAX_BATCH_SIZE) {
      throw new ReconciliationError(`change count exceeds the safe batch limit: ${updates.length}`);
    }
    if (updates.length === 0) return;
    await this.request(
      "POST",
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_update`,
      { payload: { records: updates }, retry: false },
    );
  }
}

export async function runSync({ snapshot, config, apply = false, client }) {
  const selectedService = process.env.LARK_KEYCHAIN_SERVICE?.trim()
    || config.credentials?.larkKeychainService;
  const credentialEnv = selectedService
    ? { ...process.env, LARK_KEYCHAIN_SERVICE: selectedService }
    : process.env;
  const activeClient = client ?? (await LarkClient.fromEnvironment({
    origin: config.apiOrigin,
    env: credentialEnv,
  }));
  const bindings = resolveFields(await activeClient.listFields(config.appToken, config.tableId), config.fieldIds);
  const plan = buildPlan(
    await activeClient.listRecords(config.appToken, config.tableId),
    snapshot,
    bindings,
  );
  if (plan.errors.length) {
    const dryReport = report(snapshot, plan, "dry-run");
    throw new ReconciliationError("reconciliation did not uniquely match every source account", dryReport);
  }
  if (!apply) return report(snapshot, plan, "dry-run");
  if (plan.updates.length > MAX_BATCH_SIZE) {
    throw new ReconciliationError(`change count exceeds the safe batch limit: ${plan.updates.length}`);
  }
  try {
    await activeClient.batchUpdate(config.appToken, config.tableId, plan.updates);
  } catch (error) {
    throw new VerificationError(
      `write outcome is uncertain; do not retry before a read-only check: ${error.message}`,
    );
  }
  const verifiedBindings = resolveFields(
    await activeClient.listFields(config.appToken, config.tableId),
    config.fieldIds,
  );
  const verifiedPlan = buildPlan(
    await activeClient.listRecords(config.appToken, config.tableId),
    snapshot,
    verifiedBindings,
  );
  if (verifiedPlan.errors.length || verifiedPlan.updates.length) {
    throw new VerificationError("post-write reread does not match the requested metrics");
  }
  return report(snapshot, verifiedPlan, "apply", true);
}

export function parseArgs(argv) {
  const args = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (value === "--json") args.json = true;
    else if (["--input", "--config", "--month"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new SyncError(`${value} requires a value`);
      args[value.slice(2)] = next;
      index += 1;
    } else throw new SyncError(`unknown argument: ${value}`);
  }
  if (!args.input) throw new SyncError("--input is required");
  if (!args.config) throw new SyncError("--config is required");
  return args;
}

function printHuman(value) {
  console.log(`Month: ${value.month}`);
  console.log(`Source updated: ${value.sourceUpdatedAt}`);
  console.log(`Source creators: ${value.sourceCreatorCount}`);
  console.log(`Matched: ${value.matchedCount}`);
  console.log(`Changes: ${value.changeCount}; unchanged: ${value.unchangedCount}`);
  if (value.verified) console.log("Post-write verification: passed");
  for (const row of value.rows) {
    console.log(
      `- ${row.accountKey}: ${row.status} diamonds=${row.desired.diamonds} ` +
        `days=${row.desired.effectiveLiveDays} minutes=${row.desired.liveMinutes}`,
    );
  }
  for (const error of value.errors ?? []) console.error(`ERROR: ${error}`);
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    const snapshot = await loadSnapshot(args.input, args.month);
    const config = await loadConfig(args.config);
    const result = await runSync({ snapshot, config, apply: args.apply });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    return 0;
  } catch (error) {
    const output = error.report ?? { error: error.message };
    if (args?.json) console.log(JSON.stringify(output, null, 2));
    else if (error.report) printHuman(error.report);
    else console.error(`ERROR: ${error.message}`);
    return error instanceof SyncError ? error.exitCode : 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
