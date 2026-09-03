import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const RESTORE_ROUTES = new Set(["browser-native-base-import"]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function requiredText(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`);
  return value.trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function normalizeBackupReceipt(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "backup receipt must be an object");
  assert(value.version === 1 && value.status === "verified", "backup receipt must be verified version 1");
  assert(value.artifact_kind === "full-base-export", "drill requires a full Base export");
  assert(value.restore_scope === "full-base", "drill requires full-base restore scope");
  for (const key of ["schema_sha256", "artifact_sha256", "receipt_sha256"]) {
    assert(SHA256.test(String(value[key] ?? "")), `backup receipt ${key} is invalid`);
  }
  return Object.freeze({
    base_alias: requiredText(value.base_alias, "backup receipt base_alias"),
    schema_sha256: value.schema_sha256,
    artifact_sha256: value.artifact_sha256,
    receipt_sha256: value.receipt_sha256,
    restore_scope: "full-base",
  });
}

function normalizeProfile(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "drill profile must be an object");
  assert(value.version === 1, "drill profile version must be 1");
  const route = requiredText(value.restore_route, "drill profile restore_route");
  assert(RESTORE_ROUTES.has(route), "drill profile restore_route is unsupported");
  const productionRef = requiredText(value.production_instance_ref, "production_instance_ref");
  const destinationRef = requiredText(value.isolated_destination_ref, "isolated_destination_ref");
  assert(productionRef !== destinationRef, "isolated destination must differ from production");
  assert(value.destination_policy === "new-non-production-base", "destination must be a new non-production Base");
  assert(value.cleanup_policy === "separate-explicit-approval", "cleanup must require separate explicit approval");
  assert(value.expected_schema_sha256 === undefined || SHA256.test(value.expected_schema_sha256), "expected_schema_sha256 is invalid");
  return Object.freeze({
    base_alias: requiredText(value.base_alias, "drill profile base_alias"),
    production_instance_ref: productionRef,
    isolated_destination_ref: destinationRef,
    destination_policy: value.destination_policy,
    restore_route: route,
    cleanup_policy: value.cleanup_policy,
    expected_schema_sha256: value.expected_schema_sha256 ?? null,
    attachment_check: value.attachment_check === "required" ? "required" : "document-limitations",
  });
}

export function buildDrillPreflight({ backupReceipt, profile, executionMode, testCreationAuthorized = false }) {
  const backup = normalizeBackupReceipt(backupReceipt);
  const drill = normalizeProfile(profile);
  assert(["interactive", "scheduled"].includes(executionMode), "executionMode is invalid");
  assert(backup.base_alias === drill.base_alias, "backup and drill profile aliases differ");
  if (drill.expected_schema_sha256) {
    assert(backup.schema_sha256 === drill.expected_schema_sha256, "backup schema does not match drill profile");
  }

  const plan = {
    version: 1,
    status: testCreationAuthorized ? "ready-for-isolated-restore" : "dry-run-complete",
    execution_mode: executionMode,
    base_alias: backup.base_alias,
    backup_receipt_sha256: backup.receipt_sha256,
    backup_artifact_sha256: backup.artifact_sha256,
    schema_sha256: backup.schema_sha256,
    restore_scope: backup.restore_scope,
    restore_route: drill.restore_route,
    destination_policy: drill.destination_policy,
    checks: ["schema-topology", "per-table-record-counts", "logical-hash-when-supported", drill.attachment_check],
    cleanup_policy: drill.cleanup_policy,
    test_creation_authorized: testCreationAuthorized === true,
  };
  return Object.freeze({ ...plan, plan_sha256: sha256Json(plan) });
}

function preflightCore(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "preflight must be an object");
  const { plan_sha256: ignored, ...core } = value;
  assert(SHA256.test(String(value.plan_sha256 ?? "")), "preflight plan_sha256 is invalid");
  assert(sha256Json(core) === value.plan_sha256, "preflight plan_sha256 does not match content");
  assert(value.status === "ready-for-isolated-restore", "preflight is not authorized for restore");
  assert(value.test_creation_authorized === true, "test creation is not authorized");
  assert(value.destination_policy === "new-non-production-base", "preflight destination is not isolated");
  assert(value.cleanup_policy === "separate-explicit-approval", "preflight cleanup policy is invalid");
  assert(SHA256.test(String(value.backup_receipt_sha256 ?? "")), "backup_receipt_sha256 is invalid");
  return value;
}

function timestamp(value, label) {
  const normalized = requiredText(value, label);
  assert(Number.isFinite(Date.parse(normalized)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized), `${label} must be an RFC3339 timestamp`);
  return normalized;
}

function drillReceiptCore(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "drill receipt must be an object");
  assert(value.version === 1 && value.status === "verified", "drill receipt must be verified version 1");
  assert(value.restore_scope === "full-base", "drill receipt restore_scope must be full-base");
  assert(value.schema_check === "matched", "schema check must be matched");
  assert(value.record_count_check === "matched", "record-count check must be matched");
  assert(["matched", "not-supported"].includes(value.logical_hash_check), "logical-hash check is invalid");
  assert(value.cleanup_status === "verified", "cleanup must be verified before completing a drill");
  const backupReceiptSha256 = requiredText(value.backup_receipt_sha256, "backup_receipt_sha256");
  assert(SHA256.test(backupReceiptSha256), "backup_receipt_sha256 is invalid");
  return {
    version: 1,
    status: "verified",
    base_alias: requiredText(value.base_alias, "base_alias"),
    backup_receipt_sha256: backupReceiptSha256,
    restore_scope: "full-base",
    schema_check: "matched",
    record_count_check: "matched",
    logical_hash_check: value.logical_hash_check,
    completed_at: timestamp(value.completed_at, "completed_at"),
    cleanup_status: "verified",
  };
}

export function calculateDrillReceiptSha256(value) {
  return sha256Json(drillReceiptCore(value));
}

export function normalizeVerifiedDrillReceipt(value) {
  const core = drillReceiptCore(value);
  const receiptSha256 = requiredText(value.receipt_sha256, "receipt_sha256");
  assert(SHA256.test(receiptSha256), "receipt_sha256 is invalid");
  assert(calculateDrillReceiptSha256(core) === receiptSha256, "receipt_sha256 does not match drill content");
  return Object.freeze({ ...core, receipt_sha256: receiptSha256 });
}

export function buildVerifiedDrillReceipt({ preflight, schemaCheck, recordCountCheck, logicalHashCheck, cleanupStatus, completedAt }) {
  const plan = preflightCore(preflight);
  const core = drillReceiptCore({
    version: 1,
    status: "verified",
    base_alias: plan.base_alias,
    backup_receipt_sha256: plan.backup_receipt_sha256,
    restore_scope: plan.restore_scope,
    schema_check: schemaCheck,
    record_count_check: recordCountCheck,
    logical_hash_check: logicalHashCheck,
    completed_at: completedAt,
    cleanup_status: cleanupStatus,
  });
  return normalizeVerifiedDrillReceipt({
    ...core,
    receipt_sha256: calculateDrillReceiptSha256(core),
  });
}
