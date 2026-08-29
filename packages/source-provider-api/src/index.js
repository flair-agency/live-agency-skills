import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const API_PACKAGE_NAME = "@live-agency-skills/source-provider-api";
export const API_VERSION = "1.2.0";
export const ACTIVITY_CAPABILITY = "creator-activity-source/v1";
export const INVITATION_CAPABILITY = "creator-invitation-observation-source/v1";
export const PROFILE_OBSERVATION_CAPABILITY = "creator-profile-observation-source/v1";
export const GIFT_HISTORY_CAPABILITY = "gift-history-snapshot-source/v1";

export class ProviderResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderResolutionError";
    this.code = code;
    this.details = details;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function packagePath(rootDir, packageName) {
  return path.join(rootDir, "node_modules", ...packageName.split("/"));
}

function safePackageResource(packageDir, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.startsWith("./")) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${label} must be a package-relative path beginning with ./`,
    );
  }

  const resolved = path.resolve(packageDir, relativePath);
  const packageRoot = `${path.resolve(packageDir)}${path.sep}`;
  if (!resolved.startsWith(packageRoot)) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${label} must stay inside the provider package`,
    );
  }
  return resolved;
}

function compatibleMajor(range, version) {
  const expectedMajor = Number(version.split(".")[0]);
  const match = String(range).trim().match(/^(?:\^|~)?(\d+)(?:\.|$)/);
  return Boolean(match) && Number(match[1]) === expectedMajor;
}

export function validateProviderPackage(packageName, packageJson, packageDir) {
  const manifest = packageJson.liveAgencyProvider;
  if (!manifest) return null;

  if (manifest.schemaVersion !== 1) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} uses an unsupported provider manifest version`,
    );
  }
  if (
    !Array.isArray(manifest.provides) ||
    manifest.provides.length === 0 ||
    manifest.provides.some((value) => !/^[-a-z0-9]+\/v\d+$/.test(value))
  ) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} must declare at least one versioned capability`,
    );
  }
  if (
    manifest.inputKinds !== undefined &&
    (!Array.isArray(manifest.inputKinds) ||
      manifest.inputKinds.some((value) => typeof value !== "string" || !value))
  ) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} has invalid inputKinds`,
    );
  }

  const peerRange = packageJson.peerDependencies?.[API_PACKAGE_NAME];
  if (!peerRange || !compatibleMajor(peerRange, API_VERSION)) {
    throw new ProviderResolutionError(
      "INCOMPATIBLE_API",
      `${packageName} does not support ${API_PACKAGE_NAME} ${API_VERSION}`,
      { packageName, peerRange: peerRange ?? null, apiVersion: API_VERSION },
    );
  }

  if (!manifest.execution || !["module", "instructions"].includes(manifest.execution.kind)) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} must declare module or instructions execution`,
    );
  }
  if (manifest.execution.kind === "module") {
    safePackageResource(packageDir, manifest.execution.entry, "execution.entry");
  } else {
    safePackageResource(packageDir, manifest.execution.resource, "execution.resource");
  }

  return {
    packageName,
    packageDir,
    packageVersion: packageJson.version,
    manifest,
  };
}

export async function discoverProviders({ rootDir = process.cwd(), dependencyNames } = {}) {
  const rootPackage = await readJson(path.join(rootDir, "package.json"));
  const names = dependencyNames ?? Object.keys(rootPackage.dependencies ?? {});
  const providers = [];

  for (const packageName of names) {
    const packageDir = packagePath(rootDir, packageName);
    const packageJson = await readJson(path.join(packageDir, "package.json"));
    const provider = validateProviderPackage(packageName, packageJson, packageDir);
    if (provider) providers.push(provider);
  }
  return providers;
}

async function loadProvider(descriptor) {
  const { manifest, packageDir } = descriptor;
  if (manifest.execution.kind === "instructions") {
    const resourcePath = safePackageResource(
      packageDir,
      manifest.execution.resource,
      "execution.resource",
    );
    return {
      ...descriptor,
      executionKind: "instructions",
      instructions: await readFile(resourcePath, "utf8"),
    };
  }

  const entryPath = safePackageResource(packageDir, manifest.execution.entry, "execution.entry");
  const module = await import(pathToFileURL(entryPath).href);
  const implementation = module.default ?? module.provider;
  if (!implementation || typeof implementation.read !== "function") {
    throw new ProviderResolutionError(
      "INVALID_IMPLEMENTATION",
      `${descriptor.packageName} must export an object with read(request)`,
    );
  }
  return { ...descriptor, executionKind: "module", implementation };
}

export async function resolveProvider({ providers, capability, request, unattended = false }) {
  const candidates = providers.filter((provider) => {
    if (!provider.manifest.provides.includes(capability)) return false;
    if (unattended && provider.manifest.unattended !== true) return false;
    const inputKinds = provider.manifest.inputKinds;
    return !inputKinds || inputKinds.includes(request.inputKind);
  });

  const loaded = [];
  for (const candidate of candidates) {
    const provider = await loadProvider(candidate);
    if (
      provider.executionKind === "module" &&
      typeof provider.implementation.canHandle === "function" &&
      !(await provider.implementation.canHandle(request))
    ) {
      continue;
    }
    loaded.push(provider);
  }

  if (loaded.length === 0) {
    throw new ProviderResolutionError(
      "PROVIDER_NOT_FOUND",
      `No installed provider can supply ${capability} for ${request.inputKind}`,
      { capability, inputKind: request.inputKind, unattended },
    );
  }
  if (loaded.length > 1) {
    throw new ProviderResolutionError(
      "PROVIDER_AMBIGUOUS",
      `More than one installed provider can supply ${capability} for ${request.inputKind}`,
      { capability, packages: loaded.map((provider) => provider.packageName) },
    );
  }
  return loaded[0];
}

export async function readFromProvider(provider, request) {
  if (provider.executionKind !== "module") {
    throw new ProviderResolutionError(
      "INTERACTIVE_PROVIDER",
      `${provider.packageName} requires an agent to follow its private instructions`,
      { instructions: provider.instructions },
    );
  }
  return provider.implementation.read(request);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertIsoDateTime(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

export function validateActivitySnapshot(snapshot) {
  assertObject(snapshot, "activity snapshot");
  if (!/^\d{4}-\d{2}$/.test(snapshot.month)) {
    throw new TypeError("activity snapshot month must be YYYY-MM");
  }
  assertIsoDateTime(snapshot.sourceUpdatedAt, "activity snapshot sourceUpdatedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("activity snapshot creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("activity snapshot rowCount must match creators.length");
  }

  const seen = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    assertObject(creator, `activity creator ${index}`);
    if (typeof creator.accountKey !== "string" || !creator.accountKey.trim()) {
      throw new TypeError(`activity creator ${index} accountKey is required`);
    }
    if (seen.has(creator.accountKey)) {
      throw new TypeError(`activity creator accountKey is duplicated: ${creator.accountKey}`);
    }
    seen.add(creator.accountKey);
    assertNonNegativeInteger(creator.diamonds, `activity creator ${index} diamonds`);
    assertNonNegativeInteger(creator.effectiveLiveDays, `activity creator ${index} effectiveLiveDays`);
    assertNonNegativeInteger(creator.liveMinutes, `activity creator ${index} liveMinutes`);
  }
  return snapshot;
}

export function validateInvitationObservations(snapshot) {
  assertObject(snapshot, "invitation observations");
  assertIsoDateTime(snapshot.observedAt, "invitation observations observedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("invitation observations creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("invitation observations rowCount must match creators.length");
  }

  const seen = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    assertObject(creator, `invitation creator ${index}`);
    if (typeof creator.accountKey !== "string" || !creator.accountKey.trim()) {
      throw new TypeError(`invitation creator ${index} accountKey is required`);
    }
    if (seen.has(creator.accountKey)) {
      throw new TypeError(`invitation creator accountKey is duplicated: ${creator.accountKey}`);
    }
    seen.add(creator.accountKey);
    if (typeof creator.state !== "string" || !creator.state.trim()) {
      throw new TypeError(`invitation creator ${index} state is required`);
    }
    for (const key of ["externalUserId", "nickname"]) {
      if (creator[key] !== undefined && typeof creator[key] !== "string") {
        throw new TypeError(`invitation creator ${index} ${key} must be a string`);
      }
    }
    if (creator.avatar !== undefined && creator.avatar !== null) {
      assertObject(creator.avatar, `invitation creator ${index} avatar`);
      if (typeof creator.avatar.path !== "string" || !creator.avatar.path) {
        throw new TypeError(`invitation creator ${index} avatar.path is required`);
      }
      if (!/^[0-9a-f]{64}$/.test(creator.avatar.sha256 ?? "")) {
        throw new TypeError(`invitation creator ${index} avatar.sha256 is invalid`);
      }
      if (!Number.isSafeInteger(creator.avatar.size) || creator.avatar.size < 1) {
        throw new TypeError(`invitation creator ${index} avatar.size is invalid`);
      }
      if (typeof creator.avatar.name !== "string" || !creator.avatar.name) {
        throw new TypeError(`invitation creator ${index} avatar.name is required`);
      }
      if (typeof creator.avatar.mimeType !== "string" || !creator.avatar.mimeType.startsWith("image/")) {
        throw new TypeError(`invitation creator ${index} avatar.mimeType is invalid`);
      }
    }
  }
  return snapshot;
}

const PROFILE_METRIC_STATUSES = new Set([
  "observed_exact",
  "observed_rounded",
  "not_available",
  "no_history",
  "account_mismatch",
  "authentication_required",
  "blocked",
  "schema_changed",
]);
const LIVE_SCAN_MODES = new Set(["incremental", "reconcile-window", "baseline-full"]);
const LIVE_STOP_REASONS = new Set([
  "known-anchor",
  "cutoff",
  "history-end",
  "no-history",
  "unavailable",
]);

function validateObservedCount({ value, status, display }, label, { rounded = true } = {}) {
  if (!PROFILE_METRIC_STATUSES.has(status)) {
    throw new TypeError(`${label} status is invalid`);
  }
  if (value === null) {
    if (["observed_exact", "observed_rounded"].includes(status)) {
      throw new TypeError(`${label} null value cannot be observed`);
    }
    return;
  }
  assertNonNegativeInteger(value, `${label} value`);
  if (status === "observed_exact") return;
  if (status !== "observed_rounded" || !rounded) {
    throw new TypeError(`${label} value requires an observed status`);
  }
  if (typeof display !== "string" || !display.trim()) {
    throw new TypeError(`${label} rounded value requires display text`);
  }
}

export function validateProfileObservations(snapshot) {
  assertObject(snapshot, "profile observations");
  assertIsoDateTime(snapshot.observedAt, "profile observations observedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("profile observations creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("profile observations rowCount must match creators.length");
  }

  const creatorIds = new Set();
  const accountKeys = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    const label = `profile creator ${index}`;
    assertObject(creator, label);
    for (const key of ["creatorRecordId", "accountKey"]) {
      if (typeof creator[key] !== "string" || !creator[key].trim()) {
        throw new TypeError(`${label} ${key} is required`);
      }
    }
    if (creatorIds.has(creator.creatorRecordId)) {
      throw new TypeError(`profile creatorRecordId is duplicated: ${creator.creatorRecordId}`);
    }
    if (accountKeys.has(creator.accountKey)) {
      throw new TypeError(`profile accountKey is duplicated: ${creator.accountKey}`);
    }
    creatorIds.add(creator.creatorRecordId);
    accountKeys.add(creator.accountKey);
    assertIsoDateTime(creator.observedAt, `${label} observedAt`);

    assertObject(creator.profile, `${label} profile`);
    validateObservedCount(
      {
        value: creator.profile.followerCount,
        status: creator.profile.followerStatus,
        display: creator.profile.followerDisplay,
      },
      `${label} follower`,
    );
    validateObservedCount(
      {
        value: creator.profile.communityCount,
        status: creator.profile.communityStatus,
        display: creator.profile.communityDisplay,
      },
      `${label} community`,
    );

    assertObject(creator.liveScan, `${label} liveScan`);
    if (!LIVE_SCAN_MODES.has(creator.liveScan.mode)) {
      throw new TypeError(`${label} liveScan.mode is invalid`);
    }
    if (!LIVE_STOP_REASONS.has(creator.liveScan.stopReason)) {
      throw new TypeError(`${label} liveScan.stopReason is invalid`);
    }
    assertNonNegativeInteger(creator.liveScan.knownMatchCount, `${label} liveScan.knownMatchCount`);
    if (!Array.isArray(creator.lives)) throw new TypeError(`${label} lives must be an array`);
    const liveKeys = new Set();
    for (const [liveIndex, live] of creator.lives.entries()) {
      const liveLabel = `${label} live ${liveIndex}`;
      assertObject(live, liveLabel);
      assertIsoDateTime(live.startAt, `${liveLabel} startAt`);
      assertIsoDateTime(live.endAt, `${liveLabel} endAt`);
      const startMs = Date.parse(live.startAt);
      const endMs = Date.parse(live.endAt);
      if (endMs < startMs || endMs - startMs > 24 * 60 * 60 * 1000) {
        throw new TypeError(`${liveLabel} duration is invalid`);
      }
      const liveKey = `${startMs}:${endMs}`;
      if (liveKeys.has(liveKey)) throw new TypeError(`${liveLabel} is duplicated`);
      liveKeys.add(liveKey);
      validateObservedCount(
        { value: live.likeCount, status: live.likeStatus, display: live.likeDisplay },
        `${liveLabel} likes`,
      );
    }
  }
  return snapshot;
}

function assertCalendarDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label} must be YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} is not a calendar date`);
  }
}

function assertPlainText(value, label) {
  if (typeof value !== "string" || !value || /[\t\r\n]/.test(value)) {
    throw new TypeError(`${label} must be non-empty single-line text`);
  }
}

export function validateGiftHistorySnapshot(snapshot) {
  assertObject(snapshot, "gift-history snapshot");
  if (snapshot.version !== 1) throw new TypeError("gift-history snapshot version is invalid");
  assertCalendarDate(snapshot.snapshotDate, "gift-history snapshot snapshotDate");
  assertIsoDateTime(snapshot.observedAt, "gift-history snapshot observedAt");
  assertPlainText(snapshot.accountKey, "gift-history snapshot accountKey");
  if (!/^[0-9a-f]{64}$/.test(snapshot.sourceSha256 ?? "")) {
    throw new TypeError("gift-history snapshot sourceSha256 is invalid");
  }
  if (!Array.isArray(snapshot.events)) {
    throw new TypeError("gift-history snapshot events must be an array");
  }
  if (snapshot.rowCount !== snapshot.events.length) {
    throw new TypeError("gift-history snapshot rowCount must match events.length");
  }

  const keys = new Set();
  let previous = null;
  for (const [index, event] of snapshot.events.entries()) {
    const label = `gift-history event ${index}`;
    assertObject(event, label);
    assertPlainText(event.eventKey, `${label} eventKey`);
    assertPlainText(event.accountKey, `${label} accountKey`);
    assertPlainText(event.recipientKey, `${label} recipientKey`);
    assertIsoDateTime(event.occurredAt, `${label} occurredAt`);
    if (!/^(?:0|[1-9]\d*)$/.test(event.amount ?? "")) {
      throw new TypeError(`${label} amount must be a canonical non-negative integer string`);
    }
    if (event.accountKey !== snapshot.accountKey) {
      throw new TypeError(`${label} accountKey does not match the snapshot`);
    }
    if (keys.has(event.eventKey)) throw new TypeError(`${label} eventKey is duplicated`);
    keys.add(event.eventKey);
    const ordering = [Date.parse(event.occurredAt), event.eventKey];
    if (
      previous &&
      (ordering[0] < previous[0] || (ordering[0] === previous[0] && ordering[1] <= previous[1]))
    ) {
      throw new TypeError(`${label} is not strictly ordered by occurredAt and eventKey`);
    }
    previous = ordering;
  }
  return snapshot;
}
