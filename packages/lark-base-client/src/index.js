import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_ORIGIN = "https://open.larksuite.com";
const SECURITY_BIN = "/usr/bin/security";
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export class LarkApiError extends Error {
  constructor(message, { uncertainWrite = false } = {}) {
    super(message);
    this.name = "LarkApiError";
    this.uncertainWrite = uncertainWrite;
  }
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
  if (metadata.status !== 0) throw new LarkApiError("cannot read the selected keychain item");
  const password = spawnSync(SECURITY_BIN, ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (password.status !== 0) throw new LarkApiError("cannot read the selected keychain password");
  const embedded = parseCredentialPayload(password.stdout.trim());
  if (embedded) return embedded;
  const account = metadata.stdout.match(/"acct"<blob>="([^"]*)"/)?.[1]?.trim();
  const secret = password.stdout.trim();
  if (!account || !secret) throw new LarkApiError("the selected keychain item lacks app credentials");
  return [account, secret];
}

function addQuery(url, query) {
  for (const [key, rawValue] of Object.entries(query ?? {})) {
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) url.searchParams.append(key, String(value));
  }
}

export class LarkBaseClient {
  constructor(token, { origin = DEFAULT_ORIGIN, fetchImpl = fetch } = {}) {
    this.token = token;
    this.origin = origin.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  static async fromEnvironment({ origin = DEFAULT_ORIGIN, env = process.env, fetchImpl = fetch } = {}) {
    if (env.LARK_TENANT_ACCESS_TOKEN?.trim()) {
      return new LarkBaseClient(env.LARK_TENANT_ACCESS_TOKEN.trim(), { origin, fetchImpl });
    }
    let appId = env.LARK_APP_ID?.trim();
    let appSecret = env.LARK_APP_SECRET?.trim();
    if (Boolean(appId) !== Boolean(appSecret)) {
      throw new LarkApiError("LARK_APP_ID and LARK_APP_SECRET must be supplied together");
    }
    if (!appId) {
      const service = env.LARK_KEYCHAIN_SERVICE?.trim();
      if (!service) throw new LarkApiError("Lark credentials are not configured");
      [appId, appSecret] = keychainCredentials(service);
    }
    const client = new LarkBaseClient("", { origin, fetchImpl });
    const response = await client.request("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
      json: { app_id: appId, app_secret: appSecret },
      authorization: false,
      retry: true,
    });
    if (typeof response.tenant_access_token !== "string" || !response.tenant_access_token) {
      throw new LarkApiError("tenant access token is missing from the authentication response");
    }
    return new LarkBaseClient(response.tenant_access_token, { origin, fetchImpl });
  }

  async request(method, apiPath, { query, json, formData, authorization = true, retry } = {}) {
    const url = new URL(`${this.origin}${apiPath}`);
    addQuery(url, query);
    const attempts = (retry ?? method === "GET") ? 3 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const headers = {};
        if (authorization) headers.Authorization = `Bearer ${this.token}`;
        if (json !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: formData ?? (json === undefined ? undefined : JSON.stringify(json)),
        });
        const text = await response.text();
        let decoded;
        try {
          decoded = text ? JSON.parse(text) : {};
        } catch {
          throw new LarkApiError("Lark API returned invalid JSON", { uncertainWrite: method !== "GET" });
        }
        if (!response.ok) {
          throw new LarkApiError(`Lark API HTTP ${response.status}`, { uncertainWrite: method !== "GET" });
        }
        if (!decoded || typeof decoded !== "object" || decoded.code !== 0) {
          throw new LarkApiError(
            `Lark API error code=${decoded?.code} msg=${decoded?.msg ?? ""}`,
            { uncertainWrite: false },
          );
        }
        return decoded;
      } catch (error) {
        lastError = error instanceof LarkApiError
          ? error
          : new LarkApiError(`Lark API request failed: ${error.message}`, {
              uncertainWrite: method !== "GET",
            });
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
        }
      }
    }
    throw lastError;
  }

  async listAll(appToken, tableId, resource, { query = {}, pageSize } = {}) {
    const items = [];
    let pageToken;
    const size = pageSize ?? (resource === "fields" ? 100 : 500);
    do {
      const response = await this.request(
        "GET",
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/${resource}`,
        { query: { ...query, page_size: size, page_token: pageToken } },
      );
      if (!Array.isArray(response.data?.items)) throw new LarkApiError("Lark list response is invalid");
      items.push(...response.data.items);
      pageToken = response.data.has_more ? response.data.page_token : undefined;
      if (response.data.has_more && !pageToken) throw new LarkApiError("Lark page token is missing");
    } while (pageToken);
    return items;
  }

  listFields(appToken, tableId) {
    return this.listAll(appToken, tableId, "fields", { pageSize: 100 });
  }

  listRecords(appToken, tableId, query = {}) {
    return this.listAll(appToken, tableId, "records", { query, pageSize: 500 });
  }

  async batchUpdate(appToken, tableId, records) {
    if (!records.length) return [];
    const response = await this.request(
      "POST",
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_update`,
      { json: { records }, retry: false },
    );
    return response.data?.records ?? [];
  }

  async batchCreate(appToken, tableId, records) {
    if (!records.length) return [];
    const response = await this.request(
      "POST",
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
      { json: { records }, retry: false },
    );
    if (!Array.isArray(response.data?.records) || response.data.records.length !== records.length) {
      throw new LarkApiError("Lark batch-create response count does not match", { uncertainWrite: true });
    }
    return response.data.records;
  }

  async batchDelete(appToken, tableId, recordIds) {
    if (!recordIds.length) return;
    await this.request(
      "POST",
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_delete`,
      { json: { records: recordIds }, retry: false },
    );
  }

  async temporaryDownloadUrl(fileToken) {
    const response = await this.request("GET", "/open-apis/drive/v1/medias/batch_get_tmp_download_url", {
      query: { file_tokens: fileToken },
    });
    const item = response.data?.tmp_download_urls?.find((value) => value.file_token === fileToken);
    if (!item?.tmp_download_url?.startsWith("https://")) {
      throw new LarkApiError("temporary attachment URL is missing");
    }
    return item.tmp_download_url;
  }

  async downloadAttachment(attachment) {
    const fileToken = String(attachment?.file_token ?? "");
    if (!/^[-_A-Za-z0-9]+$/.test(fileToken)) throw new LarkApiError("attachment file token is invalid");
    const response = await this.fetchImpl(await this.temporaryDownloadUrl(fileToken), {
      redirect: "follow",
    });
    if (!response.ok) throw new LarkApiError(`attachment download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      throw new LarkApiError("attachment exceeds the size limit");
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length < 1 || content.length > MAX_MEDIA_BYTES) {
      throw new LarkApiError("attachment size is invalid");
    }
    const suppliedName = String(attachment?.name ?? attachment?.file_name ?? "").normalize("NFKC").trim();
    const safeName = suppliedName && !/[\\/\0\r\n]/.test(suppliedName)
      ? suppliedName.slice(0, 255)
      : `${fileToken}.bin`;
    const suppliedMime = String(response.headers.get("content-type") ?? attachment?.type ?? "").split(";", 1)[0].trim();
    const mimeType = suppliedMime && !/[\r\n]/.test(suppliedMime) ? suppliedMime : "application/octet-stream";
    return {
      fileToken,
      name: safeName,
      mimeType,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  }

  async attachmentSha256(attachment) {
    return (await this.downloadAttachment(attachment)).sha256;
  }

  async uploadMedia(appToken, avatar) {
    const content = await import("node:fs/promises").then(({ readFile }) => readFile(avatar.path));
    const form = new FormData();
    form.append("file_name", avatar.name);
    form.append("parent_type", "bitable_file");
    form.append("parent_node", appToken);
    form.append("size", String(content.length));
    form.append("file", new Blob([content], { type: avatar.mimeType }), avatar.name);
    const response = await this.request("POST", "/open-apis/drive/v1/medias/upload_all", {
      formData: form,
      retry: false,
    });
    const fileToken = String(response.data?.file_token ?? "");
    if (!fileToken) throw new LarkApiError("uploaded media token is missing", { uncertainWrite: true });
    return fileToken;
  }

  async appendAttachment(appToken, tableId, recordId, fieldId, fileToken) {
    await this.request(
      "POST",
      `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/append_attachments`,
      {
        json: { attachments: { [recordId]: { [fieldId]: [{ file_token: fileToken }] } } },
        retry: false,
      },
    );
  }
}

export const LARK_MEDIA_MAX_BYTES = MAX_MEDIA_BYTES;
