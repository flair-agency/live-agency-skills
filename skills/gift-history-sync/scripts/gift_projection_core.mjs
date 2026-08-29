import { createHash } from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(stableSort(value))).digest("hex");
}

function normalizeText(value, spec, label) {
  let normalized = String(value ?? "").normalize("NFKC").trim();
  if (spec.stripLeadingAt) normalized = normalized.replace(/^@+/, "");
  assert(normalized && !/[\t\r\n]/.test(normalized), `${label} is invalid`);
  return normalized;
}

function normalizeNumber(value, spec, label, { defaultZero = false } = {}) {
  const raw = value === undefined || value === null || value === "" ? (defaultZero ? 0 : value) : value;
  const number = Number(raw);
  assert(Number.isSafeInteger(number), `${label} must be a safe integer`);
  assert(spec.minimum === undefined || number >= spec.minimum, `${label} is below its minimum`);
  assert(spec.maximum === undefined || number <= spec.maximum, `${label} is above its maximum`);
  return number;
}

function normalizeValue(value, spec, label, options) {
  if (spec.uiType === "Number") return normalizeNumber(value, spec, label, options);
  if (["Text", "SingleSelect"].includes(spec.uiType)) return normalizeText(value, spec, label);
  throw new TypeError(`${label} has an unsupported configured type`);
}

function compareValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function validateProjectionConfig(config, projectionKey) {
  assert(config?.version === 1, "workspace configuration version is invalid");
  const spreadsheetId = String(config.spreadsheet?.spreadsheetId ?? "").trim();
  assert(spreadsheetId, "workspace spreadsheetId is missing");
  const projection = config.lark?.[projectionKey];
  assert(projection && typeof projection === "object", `projection is missing: ${projectionKey}`);
  for (const key of ["appToken", "tableId"]) {
    assert(typeof projection[key] === "string" && projection[key], `${projectionKey}.${key} is invalid`);
  }
  assert(Number.isSafeInteger(projection.sourceSheetId), `${projectionKey}.sourceSheetId is invalid`);
  assert(projection.fieldIds && typeof projection.fieldIds === "object", `${projectionKey}.fieldIds is invalid`);
  assert(Array.isArray(projection.keyFields) && projection.keyFields.length > 0, `${projectionKey}.keyFields is invalid`);
  assert(Array.isArray(projection.amountFields) && projection.amountFields.length > 0, `${projectionKey}.amountFields is invalid`);
  assert(projection.fieldTypes && typeof projection.fieldTypes === "object", `${projectionKey}.fieldTypes is invalid`);
  const allKeys = [...projection.keyFields, ...projection.amountFields];
  assert(new Set(allKeys).size === allKeys.length, `${projectionKey} field keys are duplicated`);
  const fields = {};
  for (const key of allKeys) {
    const fieldId = String(projection.fieldIds[key] ?? "").trim();
    assert(fieldId, `${projectionKey}.fieldIds.${key} is invalid`);
    const rawSpec = projection.fieldTypes[key];
    assert(rawSpec && typeof rawSpec === "object", `${projectionKey}.fieldTypes.${key} is invalid`);
    assert(["Text", "SingleSelect", "Number"].includes(rawSpec.uiType), `${projectionKey}.${key} uiType is invalid`);
    fields[key] = {
      fieldId,
      uiType: rawSpec.uiType,
      stripLeadingAt: rawSpec.stripLeadingAt === true,
      minimum: rawSpec.minimum,
      maximum: rawSpec.maximum,
    };
  }
  for (const key of projection.amountFields) {
    assert(fields[key].uiType === "Number", `${projectionKey}.${key} must be a Number field`);
    assert(fields[key].minimum === undefined || fields[key].minimum >= 0, `${projectionKey}.${key} minimum is invalid`);
  }
  return {
    projectionKey,
    spreadsheetId,
    appToken: projection.appToken,
    tableId: projection.tableId,
    sourceSheetId: projection.sourceSheetId,
    backupDir: projection.backupDir ? String(projection.backupDir) : null,
    keyFields: [...projection.keyFields],
    amountFields: [...projection.amountFields],
    fields,
  };
}

function normalizeRows(rows, config, labelPrefix) {
  assert(Array.isArray(rows), `${labelPrefix} rows must be an array`);
  const seen = new Set();
  const normalized = rows.map((row, index) => {
    assert(row && typeof row === "object" && !Array.isArray(row), `${labelPrefix} row ${index} is invalid`);
    const value = {};
    for (const key of config.keyFields) {
      value[key] = normalizeValue(row[key], config.fields[key], `${labelPrefix} row ${index}.${key}`);
    }
    for (const key of config.amountFields) {
      value[key] = normalizeValue(
        row[key],
        config.fields[key],
        `${labelPrefix} row ${index}.${key}`,
        { defaultZero: true },
      );
    }
    const composite = JSON.stringify(config.keyFields.map((key) => value[key]));
    assert(!seen.has(composite), `${labelPrefix} contains a duplicate composite key`);
    seen.add(composite);
    return value;
  });
  normalized.sort((left, right) => {
    for (const key of config.keyFields) {
      const compared = compareValues(left[key], right[key]);
      if (compared) return compared;
    }
    return 0;
  });
  return normalized;
}

export function normalizeProjectionTarget(target, config) {
  assert(target?.version === 1, "projection target version is invalid");
  assert(target.projectionKey === config.projectionKey, "projection target key does not match configuration");
  assert(target.source?.spreadsheetId === config.spreadsheetId, "projection source spreadsheet does not match");
  assert(target.source?.sheetId === config.sourceSheetId, "projection source sheet does not match");
  const rows = normalizeRows(target.rows, config, "target");
  const rowsSha256 = sha256Json(rows);
  assert(target.rowCount === rows.length, "projection target rowCount does not match");
  assert(target.rowsSha256 === rowsSha256, "projection target rowsSha256 does not match");
  return { ...target, rows, rowCount: rows.length, rowsSha256 };
}

export function buildProjectionTarget({ config, rows }) {
  const normalizedRows = normalizeRows(rows, config, "target");
  return {
    version: 1,
    projectionKey: config.projectionKey,
    source: { spreadsheetId: config.spreadsheetId, sheetId: config.sourceSheetId },
    rowCount: normalizedRows.length,
    rowsSha256: sha256Json(normalizedRows),
    rows: normalizedRows,
  };
}

export function resolveProjectionFields(larkFields, config) {
  assert(Array.isArray(larkFields), "Lark fields must be an array");
  const byId = new Map(larkFields.map((field) => [field.field_id, field]));
  const bindings = {};
  for (const key of [...config.keyFields, ...config.amountFields]) {
    const expected = config.fields[key];
    const field = byId.get(expected.fieldId);
    assert(field, `configured Lark field ID is missing for ${key}`);
    assert(field.ui_type === expected.uiType, `configured Lark field type changed for ${key}`);
    assert(typeof field.field_name === "string" && field.field_name, `Lark field name is invalid for ${key}`);
    bindings[key] = {
      id: field.field_id,
      name: field.field_name,
      uiType: field.ui_type,
      options: field.property?.options ?? [],
    };
  }
  assert(
    new Set(Object.values(bindings).map((binding) => binding.name)).size === Object.keys(bindings).length,
    "resolved Lark field names are not unique",
  );
  return bindings;
}

function validateSelectOptions(targetRows, bindings, config) {
  for (const key of config.keyFields) {
    if (config.fields[key].uiType !== "SingleSelect") continue;
    const options = new Set(bindings[key].options.map((option) => String(option.name)));
    for (const value of new Set(targetRows.map((row) => row[key]))) {
      assert(options.has(String(value)), `Lark select option is missing for ${key}`);
    }
  }
}

function rowKey(row, config) {
  return JSON.stringify(config.keyFields.map((key) => row[key]));
}

export function normalizeProjectionRecords(records, bindings, config) {
  assert(Array.isArray(records), "Lark records must be an array");
  const byKey = new Map();
  const rows = records.map((record, index) => {
    assert(typeof record?.record_id === "string" && record.record_id, `Lark record ${index} has no ID`);
    const row = { recordId: record.record_id };
    for (const key of config.keyFields) {
      row[key] = normalizeValue(record.fields?.[bindings[key].name], config.fields[key], `Lark record ${index}.${key}`);
    }
    for (const key of config.amountFields) {
      row[key] = normalizeValue(
        record.fields?.[bindings[key].name],
        config.fields[key],
        `Lark record ${index}.${key}`,
        { defaultZero: true },
      );
    }
    const composite = rowKey(row, config);
    assert(!byKey.has(composite), "Lark contains a duplicate composite key");
    byKey.set(composite, row);
    return row;
  });
  return { rows, byKey };
}

export function buildProjectionPlan({ target, records, bindings, config }) {
  const normalizedTarget = normalizeProjectionTarget(target, config);
  validateSelectOptions(normalizedTarget.rows, bindings, config);
  const current = normalizeProjectionRecords(records, bindings, config);
  const targetByKey = new Map(normalizedTarget.rows.map((row) => [rowKey(row, config), row]));
  const creates = [];
  const updates = [];
  const deletes = [];
  const unchanged = [];
  for (const row of normalizedTarget.rows) {
    const existing = current.byKey.get(rowKey(row, config));
    if (!existing) {
      creates.push(row);
      continue;
    }
    const changedFields = config.amountFields.filter((key) => existing[key] !== row[key]);
    if (changedFields.length) updates.push({ recordId: existing.recordId, row, changedFields });
    else unchanged.push(row);
  }
  for (const row of current.rows) {
    if (!targetByKey.has(rowKey(row, config))) deletes.push({ recordId: row.recordId });
  }
  const summary = {
    projectionKey: config.projectionKey,
    targetSha256: normalizedTarget.rowsSha256,
    targetRowCount: normalizedTarget.rowCount,
    currentRowCount: current.rows.length,
    createCount: creates.length,
    updateCount: updates.length,
    deleteCount: deletes.length,
    unchangedCount: unchanged.length,
    targetAmountTotals: Object.fromEntries(
      config.amountFields.map((key) => [
        key,
        normalizedTarget.rows.reduce((sum, row) => sum + BigInt(row[key]), 0n).toString(),
      ]),
    ),
  };
  return {
    version: 1,
    summary,
    planSha256: sha256Json({ targetSha256: normalizedTarget.rowsSha256, current: current.rows, summary }),
    operations: { creates, updates, deletes, unchanged },
    target: normalizedTarget,
  };
}

export function projectionPayload(row, bindings, config, { includeKeys }) {
  const keys = includeKeys ? [...config.keyFields, ...config.amountFields] : config.amountFields;
  return Object.fromEntries(keys.map((key) => [bindings[key].name, row[key]]));
}

export function projectionMatchesTarget(records, bindings, config, target) {
  const plan = buildProjectionPlan({ target, records, bindings, config });
  return {
    matches:
      plan.summary.createCount === 0 &&
      plan.summary.updateCount === 0 &&
      plan.summary.deleteCount === 0,
    plan,
  };
}
