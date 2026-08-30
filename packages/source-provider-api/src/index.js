import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const API_PACKAGE_NAME = "@live-agency-skills/source-provider-api";
export const API_VERSION = "1.6.0";
export const ACTIVITY_CAPABILITY = "creator-activity-source/v1";
export const INVITATION_CAPABILITY = "creator-invitation-observation-source/v1";
export const PROFILE_OBSERVATION_CAPABILITY = "creator-profile-observation-source/v2";
export const LIVE_HISTORY_OBSERVATION_CAPABILITY = "creator-live-history-observation-source/v1";
export const GIFT_HISTORY_CAPABILITY = "gift-history-snapshot-source/v1";
export const COIN_PURCHASE_EVIDENCE_CAPABILITY = "coin-purchase-evidence-source/v1";
export const EXPENSE_CANDIDATE_CAPABILITY = "expense-candidate-source/v1";
export const EXPENSE_REGISTRATION_CAPABILITY = "expense-registration-sink/v1";

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

function validateBinding(packageName, packageDir, binding, bindingId) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} provider binding ${bindingId} is invalid`,
    );
  }
  if (
    !Array.isArray(binding.provides) ||
    binding.provides.length === 0 ||
    binding.provides.some((value) => !/^[-a-z0-9]+\/v\d+$/.test(value))
  ) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} provider binding ${bindingId} must declare at least one versioned capability`,
    );
  }
  if (
    binding.inputKinds !== undefined &&
    (!Array.isArray(binding.inputKinds) ||
      binding.inputKinds.some((value) => typeof value !== "string" || !value))
  ) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} provider binding ${bindingId} has invalid inputKinds`,
    );
  }
  if (
    binding.knowledgeVersion !== undefined &&
    (typeof binding.knowledgeVersion !== "string" || !binding.knowledgeVersion.trim())
  ) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} provider binding ${bindingId} has an invalid knowledgeVersion`,
    );
  }
  if (!binding.execution || !["module", "instructions"].includes(binding.execution.kind)) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} provider binding ${bindingId} must declare module or instructions execution`,
    );
  }
  if (binding.execution.kind === "module") {
    safePackageResource(packageDir, binding.execution.entry, `${bindingId}.execution.entry`);
  } else {
    safePackageResource(packageDir, binding.execution.resource, `${bindingId}.execution.resource`);
    if (
      binding.execution.resources !== undefined &&
      (!Array.isArray(binding.execution.resources) ||
        binding.execution.resources.some((value) => typeof value !== "string"))
    ) {
      throw new ProviderResolutionError(
        "INVALID_MANIFEST",
        `${packageName} provider binding ${bindingId} has invalid instruction resources`,
      );
    }
    for (const [index, resource] of (binding.execution.resources ?? []).entries()) {
      safePackageResource(
        packageDir,
        resource,
        `${bindingId}.execution.resources[${index}]`,
      );
    }
  }
  return { ...binding, id: bindingId };
}

export function validateProviderPackage(packageName, packageJson, packageDir) {
  const manifest = packageJson.liveAgencyProvider;
  if (!manifest) return null;

  if (![1, 2].includes(manifest.schemaVersion)) {
    throw new ProviderResolutionError(
      "INVALID_MANIFEST",
      `${packageName} uses an unsupported provider manifest version`,
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

  let bindings;
  if (manifest.schemaVersion === 1) {
    bindings = [validateBinding(packageName, packageDir, manifest, "default")];
  } else {
    if (!Array.isArray(manifest.bindings) || manifest.bindings.length === 0) {
      throw new ProviderResolutionError(
        "INVALID_MANIFEST",
        `${packageName} must declare at least one provider binding`,
      );
    }
    const ids = new Set();
    bindings = manifest.bindings.map((binding, index) => {
      const bindingId = String(binding?.id ?? "").trim();
      if (!/^[-a-z0-9]+$/.test(bindingId) || ids.has(bindingId)) {
        throw new ProviderResolutionError(
          "INVALID_MANIFEST",
          `${packageName} provider binding ${index} has an invalid or duplicate id`,
        );
      }
      ids.add(bindingId);
      return validateBinding(packageName, packageDir, binding, bindingId);
    });
  }

  return {
    packageName,
    packageDir,
    packageVersion: packageJson.version,
    manifest,
    bindings,
  };
}

export async function discoverProviders({ rootDir = process.cwd(), dependencyNames } = {}) {
  const rootPackage = await readJson(path.join(rootDir, "package.json"));
  const names = dependencyNames ?? Object.keys(rootPackage.dependencies ?? {});
  const providers = [];

  for (const packageName of names) {
    const packageDir = packagePath(rootDir, packageName);
    const packageJson = await readJson(path.join(packageDir, "package.json"));
    const providerPackage = validateProviderPackage(packageName, packageJson, packageDir);
    if (!providerPackage) continue;
    for (const binding of providerPackage.bindings) {
      providers.push({
        packageName: providerPackage.packageName,
        packageDir: providerPackage.packageDir,
        packageVersion: providerPackage.packageVersion,
        bindingId: binding.id,
        knowledgeVersion: binding.knowledgeVersion ?? null,
        manifest: binding,
      });
    }
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
    const additionalPaths = (manifest.execution.resources ?? []).map((resource, index) =>
      safePackageResource(packageDir, resource, `execution.resources[${index}]`));
    const instructionParts = [await readFile(resourcePath, "utf8")];
    for (const additionalPath of additionalPaths) {
      instructionParts.push(await readFile(additionalPath, "utf8"));
    }
    return {
      ...descriptor,
      executionKind: "instructions",
      instructions: instructionParts.join("\n\n"),
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
      {
        capability,
        providers: loaded.map((provider) => ({
          packageName: provider.packageName,
          bindingId: provider.bindingId,
        })),
      },
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

const OBSERVATION_STATUSES = new Set([
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
  if (!OBSERVATION_STATUSES.has(status)) {
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

function validateObservedValue({ value, status }, label) {
  if (!OBSERVATION_STATUSES.has(status)) throw new TypeError(`${label} status is invalid`);
  if (value === null) {
    if (["observed_exact", "observed_rounded"].includes(status)) {
      throw new TypeError(`${label} null value cannot be observed`);
    }
    return;
  }
  if (status !== "observed_exact") throw new TypeError(`${label} value requires observed_exact`);
}

function validateAvatar(avatar, label) {
  assertObject(avatar, label);
  if (typeof avatar.path !== "string" || !path.isAbsolute(avatar.path)) {
    throw new TypeError(`${label} path must be absolute`);
  }
  if (!/^[0-9a-f]{64}$/.test(avatar.sha256 ?? "")) {
    throw new TypeError(`${label} sha256 is invalid`);
  }
  if (!Number.isSafeInteger(avatar.size) || avatar.size < 1) {
    throw new TypeError(`${label} size is invalid`);
  }
  if (typeof avatar.name !== "string" || !avatar.name || /[\\/\0\r\n]/.test(avatar.name)) {
    throw new TypeError(`${label} name is invalid`);
  }
  if (typeof avatar.mimeType !== "string" || !avatar.mimeType.startsWith("image/")) {
    throw new TypeError(`${label} mimeType is invalid`);
  }
}

function validateFeatureObservationData(value, label, creator) {
  assertObject(value, label);
  if (!Number.isSafeInteger(value.schema_version) || value.schema_version < 1) {
    throw new TypeError(`${label} schema_version is invalid`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 100_000) {
    throw new TypeError(`${label} exceeds 100000 bytes`);
  }
  if (value.observation?.observed_at !== undefined) {
    assertIsoDateTime(value.observation.observed_at, `${label} observation.observed_at`);
    if (Date.parse(value.observation.observed_at) !== Date.parse(creator.observedAt)) {
      throw new TypeError(`${label} observation timestamp does not match creator observedAt`);
    }
  }
  if (
    value.profile?.display_name !== undefined &&
    creator.profile.nickname !== null &&
    value.profile.display_name !== creator.profile.nickname
  ) {
    throw new TypeError(`${label} display_name does not match profile nickname`);
  }
  if (
    value.posts?.last_30_days_count !== undefined &&
    creator.profile.recentPostCount30d !== null &&
    value.posts.last_30_days_count !== creator.profile.recentPostCount30d
  ) {
    throw new TypeError(`${label} last_30_days_count does not match profile value`);
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
        value: creator.profile.recentPostCount30d,
        status: creator.profile.recentPostStatus,
      },
      `${label} recent posts`,
      { rounded: false },
    );
    validateObservedValue(
      { value: creator.profile.latestPostAt, status: creator.profile.latestPostStatus },
      `${label} latest post`,
    );
    if (creator.profile.latestPostAt !== null) {
      assertIsoDateTime(creator.profile.latestPostAt, `${label} latestPostAt`);
    }
    validateObservedValue(
      { value: creator.profile.nickname, status: creator.profile.nicknameStatus },
      `${label} nickname`,
    );
    if (
      creator.profile.nickname !== null &&
      (typeof creator.profile.nickname !== "string" || !creator.profile.nickname.trim())
    ) {
      throw new TypeError(`${label} nickname must be non-empty text or null`);
    }
    validateObservedValue(
      { value: creator.profile.avatar, status: creator.profile.avatarStatus },
      `${label} avatar`,
    );
    if (creator.profile.avatar !== null) validateAvatar(creator.profile.avatar, `${label} avatar`);
    validateObservedValue(
      {
        value: creator.profile.featureObservationData,
        status: creator.profile.featureObservationStatus,
      },
      `${label} feature observation data`,
    );
    if (creator.profile.featureObservationData !== null) {
      validateFeatureObservationData(
        creator.profile.featureObservationData,
        `${label} feature observation data`,
        creator,
      );
    }
  }
  return snapshot;
}

export function validateLiveHistoryObservations(snapshot) {
  assertObject(snapshot, "live-history observations");
  assertIsoDateTime(snapshot.observedAt, "live-history observations observedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("live-history observations creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("live-history observations rowCount must match creators.length");
  }

  const creatorIds = new Set();
  const accountKeys = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    const label = `live-history creator ${index}`;
    assertObject(creator, label);
    for (const key of ["creatorRecordId", "accountKey"]) {
      if (typeof creator[key] !== "string" || !creator[key].trim()) {
        throw new TypeError(`${label} ${key} is required`);
      }
    }
    if (creatorIds.has(creator.creatorRecordId)) {
      throw new TypeError(`live-history creatorRecordId is duplicated: ${creator.creatorRecordId}`);
    }
    if (accountKeys.has(creator.accountKey)) {
      throw new TypeError(`live-history accountKey is duplicated: ${creator.accountKey}`);
    }
    creatorIds.add(creator.creatorRecordId);
    accountKeys.add(creator.accountKey);
    assertIsoDateTime(creator.observedAt, `${label} observedAt`);
    validateObservedCount(
      {
        value: creator.fanClubCount,
        status: creator.fanClubStatus,
        display: creator.fanClubDisplay,
      },
      `${label} fan club`,
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

function validateCoverage(coverage, label) {
  assertObject(coverage, label);
  assertCalendarDate(coverage.fromDate, `${label} fromDate`);
  assertCalendarDate(coverage.toDate, `${label} toDate`);
  if (coverage.fromDate > coverage.toDate) throw new TypeError(`${label} date range is reversed`);
  if (typeof coverage.complete !== "boolean") throw new TypeError(`${label} complete must be boolean`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertCanonicalMoney(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive JPY safe integer`);
  }
}

function compareOrderTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const compared =
      typeof left[index] === "number" && typeof right[index] === "number"
        ? left[index] - right[index]
        : String(left[index]).localeCompare(String(right[index]));
    if (compared) return compared;
  }
  return 0;
}

function validateReceipt(receipt, label) {
  assertObject(receipt, label);
  if (!["verified", "unavailable", "conflict"].includes(receipt.status)) {
    throw new TypeError(`${label} status is invalid`);
  }
  if (receipt.receiptDate !== undefined && receipt.receiptDate !== null) {
    assertCalendarDate(receipt.receiptDate, `${label} receiptDate`);
  }
  if (receipt.status !== "verified") {
    for (const key of ["filePath", "sha256", "size", "mimeType"]) {
      if (receipt[key] !== undefined && receipt[key] !== null) {
        throw new TypeError(`${label} ${key} must be absent unless verified`);
      }
    }
    return;
  }
  if (typeof receipt.filePath !== "string" || !path.isAbsolute(receipt.filePath)) {
    throw new TypeError(`${label} filePath must be absolute`);
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.sha256 ?? "")) {
    throw new TypeError(`${label} sha256 is invalid`);
  }
  assertPositiveInteger(receipt.size, `${label} size`);
  if (
    typeof receipt.mimeType !== "string" ||
    !(receipt.mimeType === "application/pdf" || receipt.mimeType.startsWith("image/"))
  ) {
    throw new TypeError(`${label} mimeType is invalid`);
  }
}

export function validateCoinPurchaseEvidence(snapshot) {
  assertObject(snapshot, "coin-purchase evidence");
  if (snapshot.version !== 1) throw new TypeError("coin-purchase evidence version is invalid");
  assertPlainText(snapshot.serviceKey, "coin-purchase evidence serviceKey");
  assertPlainText(snapshot.accountKey, "coin-purchase evidence accountKey");
  assertIsoDateTime(snapshot.observedAt, "coin-purchase evidence observedAt");
  validateCoverage(snapshot.coverage, "coin-purchase evidence coverage");
  if (!Array.isArray(snapshot.purchases)) throw new TypeError("coin-purchase evidence purchases must be an array");
  if (snapshot.rowCount !== snapshot.purchases.length) {
    throw new TypeError("coin-purchase evidence rowCount must match purchases.length");
  }
  const keys = new Set();
  const transactionIds = new Set();
  const receiptDigests = new Set();
  let previousOrder = null;
  for (const [index, purchase] of snapshot.purchases.entries()) {
    const label = `coin purchase ${index}`;
    assertObject(purchase, label);
    assertPlainText(purchase.purchaseKey, `${label} purchaseKey`);
    assertCalendarDate(purchase.transactionDate, `${label} transactionDate`);
    assertCanonicalMoney(purchase.amountJpy, `${label} amountJpy`);
    assertPositiveInteger(purchase.coinCount, `${label} coinCount`);
    assertPositiveInteger(purchase.occurrence, `${label} occurrence`);
    if (purchase.transactionId !== null && purchase.transactionId !== undefined) {
      assertPlainText(purchase.transactionId, `${label} transactionId`);
      if (transactionIds.has(purchase.transactionId)) throw new TypeError(`${label} transactionId is duplicated`);
      transactionIds.add(purchase.transactionId);
    }
    validateReceipt(purchase.receipt, `${label} receipt`);
    if (purchase.receipt.status === "verified") {
      if (receiptDigests.has(purchase.receipt.sha256)) throw new TypeError(`${label} receipt SHA-256 is reused`);
      receiptDigests.add(purchase.receipt.sha256);
    }
    if (keys.has(purchase.purchaseKey)) throw new TypeError(`${label} purchaseKey is duplicated`);
    keys.add(purchase.purchaseKey);
    const order = [purchase.transactionDate, purchase.amountJpy, purchase.occurrence, purchase.purchaseKey];
    if (previousOrder && compareOrderTuple(order, previousOrder) <= 0) {
      throw new TypeError(`${label} is not strictly ordered`);
    }
    previousOrder = order;
  }
  return snapshot;
}

export function validateExpenseCandidates(snapshot) {
  assertObject(snapshot, "expense candidates");
  if (snapshot.version !== 1) throw new TypeError("expense candidates version is invalid");
  assertPlainText(snapshot.serviceKey, "expense candidates serviceKey");
  assertPlainText(snapshot.expenseAccountKey, "expense candidates expenseAccountKey");
  assertIsoDateTime(snapshot.observedAt, "expense candidates observedAt");
  validateCoverage(snapshot.coverage, "expense candidates coverage");
  if (snapshot.registrationLookup !== undefined) {
    assertObject(snapshot.registrationLookup, "expense candidates registrationLookup");
    if (typeof snapshot.registrationLookup.complete !== "boolean") {
      throw new TypeError("expense candidates registrationLookup complete must be boolean");
    }
    if (snapshot.registrationLookup.complete) {
      assertNonNegativeInteger(
        snapshot.registrationLookup.sourceTransactionIdCount,
        "expense candidates registrationLookup sourceTransactionIdCount",
      );
      if (!/^[0-9a-f]{64}$/.test(snapshot.registrationLookup.sourceTransactionIdsSha256 ?? "")) {
        throw new TypeError("expense candidates registrationLookup sourceTransactionIdsSha256 is invalid");
      }
    }
  }
  const existingRegistrations = snapshot.existingRegistrations ?? [];
  if (!Array.isArray(existingRegistrations)) {
    throw new TypeError("expense candidates existingRegistrations must be an array");
  }
  if ((snapshot.existingRegistrationCount ?? 0) !== existingRegistrations.length) {
    throw new TypeError("expense candidates existingRegistrationCount must match existingRegistrations.length");
  }
  const registrationKeys = new Set();
  const registeredTransactionIds = new Set();
  let previousRegistrationOrder = null;
  for (const [index, registration] of existingRegistrations.entries()) {
    const label = `existing registration ${index}`;
    assertObject(registration, label);
    for (const key of ["registrationKey", "sourceTransactionId"]) {
      assertPlainText(registration[key], `${label} ${key}`);
    }
    if (registration.state !== "registered") throw new TypeError(`${label} state is invalid`);
    if (registration.destinationVerified !== true) {
      throw new TypeError(`${label} must be destination-verified`);
    }
    if (!["memo_exact", "attachment_filename_exact"].includes(registration.evidenceMethod)) {
      throw new TypeError(`${label} evidenceMethod is invalid`);
    }
    if (registrationKeys.has(registration.registrationKey)) {
      throw new TypeError(`${label} registrationKey is duplicated`);
    }
    if (registeredTransactionIds.has(registration.sourceTransactionId)) {
      throw new TypeError(`${label} sourceTransactionId is duplicated`);
    }
    registrationKeys.add(registration.registrationKey);
    registeredTransactionIds.add(registration.sourceTransactionId);
    const order = [registration.sourceTransactionId, registration.registrationKey];
    if (previousRegistrationOrder && compareOrderTuple(order, previousRegistrationOrder) <= 0) {
      throw new TypeError(`${label} is not strictly ordered`);
    }
    previousRegistrationOrder = order;
  }
  if (
    snapshot.registrationLookup?.complete &&
    snapshot.registrationLookup.sourceTransactionIdCount < existingRegistrations.length
  ) {
    throw new TypeError("expense candidates existing registrations exceed lookup scope");
  }
  if (!Array.isArray(snapshot.expenses)) throw new TypeError("expense candidates expenses must be an array");
  if (snapshot.rowCount !== snapshot.expenses.length) {
    throw new TypeError("expense candidates rowCount must match expenses.length");
  }
  const keys = new Set();
  let previousOrder = null;
  for (const [index, expense] of snapshot.expenses.entries()) {
    const label = `expense candidate ${index}`;
    assertObject(expense, label);
    for (const key of ["expenseKey", "paymentSourceKey", "registrationProfileKey"]) {
      assertPlainText(expense[key], `${label} ${key}`);
    }
    assertCalendarDate(expense.transactionDate, `${label} transactionDate`);
    assertCanonicalMoney(expense.amountJpy, `${label} amountJpy`);
    assertPositiveInteger(expense.occurrence, `${label} occurrence`);
    if (keys.has(expense.expenseKey)) throw new TypeError(`${label} expenseKey is duplicated`);
    keys.add(expense.expenseKey);
    const order = [expense.transactionDate, expense.amountJpy, expense.occurrence, expense.expenseKey];
    if (previousOrder && compareOrderTuple(order, previousOrder) <= 0) {
      throw new TypeError(`${label} is not strictly ordered`);
    }
    previousOrder = order;
  }
  return snapshot;
}
