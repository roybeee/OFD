import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const FORMAT_VERSION = "ofd-legacy-export/v1";
const SOURCE_SYSTEM = "ofd-sqlite-v1";
const STORE_FIELDS = ["id", "name", "type", "region", "addr", "phone", "open_date", "mt", "del"];
const PRODUCT_FIELDS = ["id", "sku", "name", "price", "supply", "category", "store_id", "mt", "del"];
const ORDER_FIELDS = ["id", "store_id", "date", "status", "memo", "items", "mt", "del", "deliver_date"];
const DETAIL_FIELDS = [
  "order_id", "order_number", "source", "lines_snapshot", "created_by", "created_at", "submitted_at",
  "approved_by", "approved_at", "change_reason", "change_requested_by", "change_requested_at", "cancelled_by",
  "cancelled_at", "cancellation_reason", "version",
];
const EXPORT_ENTITIES = ["stores", "products", "orders", "orderDetails"];
const EXPORT_CONTRACTS = {
  stores: { entity: "store", sourceField: "id", fields: STORE_FIELDS },
  products: { entity: "product", sourceField: "id", fields: PRODUCT_FIELDS },
  orders: { entity: "order", sourceField: "id", fields: ORDER_FIELDS },
  orderDetails: { entity: "order_detail", sourceField: "order_id", fields: DETAIL_FIELDS },
};

export function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, sortCanonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function assertSigningKey(signingKey) {
  if (typeof signingKey !== "string" || Buffer.byteLength(signingKey) < 32) {
    throw new Error("Legacy export signing key must contain at least 32 bytes");
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnsFor(db, name) {
  return new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name));
}

function exportTable(db, tableName, logicalEntity, sourceIdField, allowlist) {
  if (!tableExists(db, tableName)) return [];
  const available = columnsFor(db, tableName);
  const fields = allowlist.filter((field) => available.has(field));
  if (!fields.includes(sourceIdField)) throw new Error(`Legacy ${tableName} table is missing ${sourceIdField}`);
  const activeClause = available.has("del") ? " WHERE COALESCE(del, 0) = 0" : "";
  const sql = `SELECT ${fields.map((field) => `"${field}"`).join(",")} FROM "${tableName}"${activeClause} ORDER BY "${sourceIdField}"`;
  return db.prepare(sql).all().map((sourceRow) => {
    const row = Object.fromEntries(fields.map((field) => [field, sourceRow[field]]));
    return {
      entity: logicalEntity,
      sourceId: String(row[sourceIdField]),
      rowHashSha256: sha256(row),
      row,
    };
  });
}

export function buildSignedExport({ sqlitePath, signingKey, keyId = "legacy-export" }) {
  assertSigningKey(signingKey);
  if (!sqlitePath) throw new Error("sqlitePath is required");
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const productTable = tableExists(db, "products") ? "products" : "skus";
    const rows = {
      stores: exportTable(db, "stores", "store", "id", STORE_FIELDS),
      products: exportTable(db, productTable, "product", "id", PRODUCT_FIELDS),
      orders: exportTable(db, "orders", "order", "id", ORDER_FIELDS),
      orderDetails: exportTable(db, "v2_order_details", "order_detail", "order_id", DETAIL_FIELDS),
    };
    const sourceCounts = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length]));
    const tableHashes = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, sha256(values)]));
    const datasetHashSha256 = sha256({ rows, sourceCounts, tableHashes });
    const unsigned = {
      formatVersion: FORMAT_VERSION,
      sourceSystem: SOURCE_SYSTEM,
      sourceSnapshotId: `sqlite:${datasetHashSha256}`,
      datasetHashSha256,
      sourceCounts,
      tableHashes,
      rows,
    };
    const contentHashSha256 = sha256(unsigned);
    const value = createHmac("sha256", signingKey).update(contentHashSha256).digest("hex");
    return { ...unsigned, signature: { algorithm: "hmac-sha256", keyId, contentHashSha256, value } };
  } finally {
    db.close();
  }
}

export function verifySignedExport(manifest, signingKey) {
  assertSigningKey(signingKey);
  if (manifest?.formatVersion !== FORMAT_VERSION || manifest?.sourceSystem !== SOURCE_SYSTEM) {
    throw new Error("Unsupported legacy export format");
  }
  if (manifest?.signature?.algorithm !== "hmac-sha256") throw new Error("Unsupported signature algorithm");
  if (canonicalJson(Object.keys(manifest.rows ?? {})) !== canonicalJson(EXPORT_ENTITIES)) {
    throw new Error("Manifest rows violate the export allowlist");
  }
  for (const logicalEntity of EXPORT_ENTITIES) {
    const contract = EXPORT_CONTRACTS[logicalEntity];
    const values = manifest.rows[logicalEntity];
    if (!Array.isArray(values)) throw new Error(`Manifest ${logicalEntity} rows are invalid`);
    const sourceIds = new Set();
    let previousSourceId;
    for (const entry of values) {
      if (entry.entity !== contract.entity || String(entry.row?.[contract.sourceField]) !== entry.sourceId) {
        throw new Error(`Manifest entity identity mismatch for ${logicalEntity}`);
      }
      if (sourceIds.has(entry.sourceId) || (previousSourceId !== undefined && previousSourceId.localeCompare(entry.sourceId) > 0)) {
        throw new Error(`Manifest ${logicalEntity} identities are duplicated or unsorted`);
      }
      sourceIds.add(entry.sourceId);
      previousSourceId = entry.sourceId;
      if (Object.keys(entry.row).some((field) => !contract.fields.includes(field))) {
        throw new Error(`Manifest ${logicalEntity} row violates the field allowlist`);
      }
      if (sha256(entry.row) !== entry.rowHashSha256) throw new Error(`Row hash mismatch for ${entry.entity}:${entry.sourceId}`);
    }
  }
  const expectedCounts = Object.fromEntries(EXPORT_ENTITIES.map((name) => [name, manifest.rows[name].length]));
  const expectedTableHashes = Object.fromEntries(EXPORT_ENTITIES.map((name) => [name, sha256(manifest.rows[name])]));
  if (canonicalJson(expectedCounts) !== canonicalJson(manifest.sourceCounts)
    || canonicalJson(expectedTableHashes) !== canonicalJson(manifest.tableHashes)
    || sha256({ rows: manifest.rows, sourceCounts: expectedCounts, tableHashes: expectedTableHashes }) !== manifest.datasetHashSha256
    || manifest.sourceSnapshotId !== `sqlite:${manifest.datasetHashSha256}`) {
    throw new Error("Manifest count or dataset hash reconciliation failed");
  }
  const { signature, ...unsigned } = manifest;
  const contentHashSha256 = sha256(unsigned);
  if (contentHashSha256 !== signature.contentHashSha256) throw new Error("Manifest content hash mismatch");
  const expected = createHmac("sha256", signingKey).update(contentHashSha256).digest();
  const actual = Buffer.from(String(signature.value), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Manifest signature verification failed");
  return true;
}

function stableUuid(namespace, value) {
  const bytes = Buffer.from(sha256(`${namespace}\u0000${value}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isoFromMillis(value, fallbackDate) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return `${fallbackDate}T00:00:00.000Z`;
}

function normalizeOrderStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (["draft", "작성중", "임시저장"].includes(status)) return "draft";
  if (["submitted", "대기", "승인대기", "발주"].includes(status)) return "submitted";
  if (["change_requested", "변경요청"].includes(status)) return "change_requested";
  if (["rejected", "거절", "반려"].includes(status)) return "rejected";
  if (["cancelled", "취소"].includes(status)) return "cancelled";
  if (["approved", "승인", "입금확인", "출고", "완료"].includes(status)) return "approved";
  return undefined;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function completeStoreProfile(profile) {
  return profile && nonEmpty(profile.code) && /^\d{10}$/.test(profile.businessNumber ?? "")
    && ["businessNumber", "legalName", "representativeName", "address", "businessType", "businessCategory", "email", "notificationPhone"]
      .every((key) => nonEmpty(profile[key]))
    && ["monthly", "per_delivery"].includes(profile.billingCycle)
    && ["prepaid", "monthly_credit"].includes(profile.paymentMethod);
}

function estimatedOrderGross(orderRow, productBySourceId) {
  const items = parseJson(orderRow.items);
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item) => {
    const product = productBySourceId.get(String(item?.skuId));
    const quantity = Number(item?.qty);
    return total + (product && Number.isSafeInteger(quantity) && quantity > 0 ? product.aggregate.unitGross * quantity : 0);
  }, 0);
}

function quarantineRow(entry, reasons, gross = 0) {
  return {
    entity: entry.entity,
    sourceId: entry.sourceId,
    sourceRowHashSha256: entry.rowHashSha256,
    reasons: [...new Set(reasons)].sort(),
    sourcePayload: entry.row,
    gross,
  };
}

export function buildMigrationPlan({ manifest, signingKey, profiles = {}, actorId, cohort = "default" }) {
  verifySignedExport(manifest, signingKey);
  if (!/^[0-9a-f-]{36}$/i.test(actorId ?? "")) throw new Error("A pre-provisioned Postgres actorId UUID is required");
  if (!nonEmpty(cohort)) throw new Error("cohort is required");

  const quarantine = [];
  const imports = { stores: [], products: [], orders: [] };
  const codeCounts = new Map();
  const businessCounts = new Map();
  for (const entry of manifest.rows.stores) {
    const profile = profiles.stores?.[entry.sourceId];
    if (!profile) continue;
    const code = String(profile.code ?? "").trim().toUpperCase();
    const businessNumber = String(profile.businessNumber ?? "").trim();
    if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    if (businessNumber) businessCounts.set(businessNumber, (businessCounts.get(businessNumber) ?? 0) + 1);
  }

  for (const entry of manifest.rows.stores) {
    const profile = profiles.stores?.[entry.sourceId];
    const reasons = [];
    if (!nonEmpty(entry.row.name)) reasons.push("STORE_NAME_MISSING");
    if (!completeStoreProfile(profile)) reasons.push("STORE_PROFILE_INCOMPLETE");
    if (profile) {
      const code = String(profile.code ?? "").trim().toUpperCase();
      if ((codeCounts.get(code) ?? 0) > 1) reasons.push("STORE_CODE_AMBIGUOUS");
      if ((businessCounts.get(String(profile.businessNumber ?? "").trim()) ?? 0) > 1) reasons.push("BUSINESS_NUMBER_AMBIGUOUS");
    }
    if (reasons.length) {
      quarantine.push(quarantineRow(entry, reasons));
      continue;
    }
    const targetId = stableUuid("ofd:legacy:store", entry.sourceId);
    const legalEntityId = stableUuid("ofd:legacy:legal-entity", entry.sourceId);
    imports.stores.push({
      entity: "store", sourceId: entry.sourceId, sourceRowHashSha256: entry.rowHashSha256, targetId, legalEntityId,
      sourcePayload: entry.row,
      aggregate: {
        id: targetId,
        code: profile.code,
        name: entry.row.name.trim(),
        business: {
          businessNumber: profile.businessNumber,
          legalName: profile.legalName,
          representativeName: profile.representativeName,
          address: profile.address,
          businessType: profile.businessType,
          businessCategory: profile.businessCategory,
          email: profile.email,
        },
        billingCycle: profile.billingCycle,
        paymentMethod: profile.paymentMethod,
        notificationPhone: profile.notificationPhone,
        active: true,
        version: 1,
      },
    });
  }

  const skuCounts = new Map();
  for (const entry of manifest.rows.products) {
    const sku = String(entry.row.sku ?? entry.row.id ?? "").trim().toUpperCase();
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  }
  for (const entry of manifest.rows.products) {
    const reasons = [];
    const sku = String(entry.row.sku ?? entry.row.id ?? "").trim();
    const legacySupply = Number(entry.row.supply);
    const gross = Number.isSafeInteger(legacySupply) ? legacySupply + Math.round(legacySupply * 0.1) : Number.NaN;
    if (!nonEmpty(sku)) reasons.push("PRODUCT_SKU_MISSING");
    if (!nonEmpty(entry.row.name)) reasons.push("PRODUCT_NAME_MISSING");
    if (!Number.isSafeInteger(legacySupply) || legacySupply <= 0) reasons.push("PRODUCT_SUPPLY_PRICE_INVALID");
    if (nonEmpty(entry.row.store_id)) reasons.push("PRODUCT_STORE_SCOPE_UNSUPPORTED");
    const normalizedSku = sku.toUpperCase();
    if ((skuCounts.get(normalizedSku) ?? 0) > 1) reasons.push("PRODUCT_SKU_AMBIGUOUS");
    if (reasons.length) {
      quarantine.push(quarantineRow(entry, reasons));
      continue;
    }
    const targetId = stableUuid("ofd:legacy:product", entry.sourceId);
    imports.products.push({
      entity: "product", sourceId: entry.sourceId, sourceRowHashSha256: entry.rowHashSha256, targetId,
      sourcePayload: entry.row,
      aggregate: { id: targetId, sku, name: entry.row.name.trim(), unit: "박스", unitGross: gross, taxable: true, taxRate: 10, active: true },
    });
  }

  const storeBySourceId = new Map(imports.stores.map((row) => [row.sourceId, row]));
  const productBySourceId = new Map(imports.products.map((row) => [row.sourceId, row]));
  const detailByOrderId = new Map(manifest.rows.orderDetails.map((row) => [row.sourceId, row]));
  for (const entry of manifest.rows.orders) {
    const reasons = [];
    const detailEntry = detailByOrderId.get(entry.sourceId);
    const store = storeBySourceId.get(String(entry.row.store_id));
    const items = parseJson(entry.row.items);
    const lines = detailEntry ? parseJson(detailEntry.row.lines_snapshot) : undefined;
    const deliveryDate = entry.row.deliver_date;
    const normalizedStatus = normalizeOrderStatus(entry.row.status);
    if (!store) reasons.push("ORDER_STORE_UNRESOLVED");
    if (!detailEntry) reasons.push("ORDER_DETAIL_MISSING");
    if (!Array.isArray(items) || items.length === 0) reasons.push("ORDER_ITEMS_INVALID");
    if (detailEntry && (!Array.isArray(lines) || lines.length === 0)) reasons.push("ORDER_LINES_INVALID");
    if (Array.isArray(items) && Array.isArray(lines) && items.length !== lines.length) reasons.push("ORDER_LINE_COUNT_MISMATCH");
    if (!validDate(deliveryDate)) reasons.push("DELIVERY_DATE_INVALID");
    if (!normalizedStatus) reasons.push("ORDER_STATUS_UNMAPPED");
    if (detailEntry && String(detailEntry.row.order_id) !== entry.sourceId) reasons.push("ORDER_DETAIL_ID_MISMATCH");
    if (detailEntry && !nonEmpty(detailEntry.row.order_number)) reasons.push("ORDER_NUMBER_MISSING");

    const aggregateLines = [];
    if (Array.isArray(items) && Array.isArray(lines) && items.length === lines.length) {
      const productIdsSeen = new Set();
      const lineIdsSeen = new Set();
      for (let index = 0; index < lines.length; index += 1) {
        const item = items[index];
        const line = lines[index];
        const sourceProductId = String(item?.skuId ?? line?.snapshot?.productId ?? "");
        const product = productBySourceId.get(sourceProductId);
        const quantity = Number(item?.qty);
        const lineQuantity = Number(line?.quantity);
        const gross = Number(line?.gross);
        const supply = Number(line?.supply);
        const vat = Number(line?.vat);
        const unitGross = Number(line?.snapshot?.unitGross);
        if (!nonEmpty(line?.id) || lineIdsSeen.has(line?.id)) reasons.push(`ORDER_LINE_ID_INVALID:${index}`);
        else lineIdsSeen.add(line.id);
        if (!product) reasons.push(`ORDER_PRODUCT_UNRESOLVED:${index}`);
        if (productIdsSeen.has(sourceProductId)) reasons.push(`ORDER_PRODUCT_DUPLICATE:${index}`);
        else productIdsSeen.add(sourceProductId);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10_000 || quantity !== lineQuantity) reasons.push(`ORDER_QUANTITY_MISMATCH:${index}`);
        if (![gross, supply, vat, unitGross].every((value) => Number.isSafeInteger(value) && value >= 0)
          || gross !== supply + vat || gross !== unitGross * quantity) reasons.push(`ORDER_AMOUNT_MISMATCH:${index}`);
        if (product && (String(line?.snapshot?.productId) !== sourceProductId
          || String(line?.snapshot?.sku) !== product.aggregate.sku
          || String(line?.snapshot?.name) !== product.aggregate.name
          || !nonEmpty(line?.snapshot?.unit)
          || line?.snapshot?.taxable !== true
          || Number(line?.snapshot?.taxRate) !== 10
          || unitGross !== product.aggregate.unitGross)) {
          reasons.push(`ORDER_PRODUCT_SNAPSHOT_MISMATCH:${index}`);
        }
        if (product && reasons.every((reason) => !reason.endsWith(`:${index}`))) {
          aggregateLines.push({
            id: stableUuid("ofd:legacy:order-line", `${entry.sourceId}:${index}`),
            snapshot: { ...product.aggregate, productId: product.targetId },
            quantity,
            gross,
            supply,
            vat,
          });
          delete aggregateLines.at(-1).snapshot.id;
          delete aggregateLines.at(-1).snapshot.active;
        }
      }
      if (aggregateLines.length === lines.length) {
        const allocations = lines.map((line, index) => ({
          index,
          id: String(line.id),
          gross: Number(line.gross),
          base: Number((BigInt(Number(line.gross)) * 100n) / 110n),
          remainder: Number((BigInt(Number(line.gross)) * 100n) % 110n),
        }));
        const totalGross = allocations.reduce((sum, line) => sum + line.gross, 0);
        if (!Number.isSafeInteger(totalGross)) reasons.push("ORDER_TOTAL_OVERFLOW");
        else {
          const totalSupply = Number((BigInt(totalGross) * 100n + 55n) / 110n);
          const remaining = totalSupply - allocations.reduce((sum, line) => sum + line.base, 0);
          const priority = [...allocations].sort((left, right) => right.remainder - left.remainder || left.id.localeCompare(right.id) || left.index - right.index);
          const extras = new Set(priority.slice(0, remaining).map((line) => line.index));
          for (const allocation of allocations) {
            const canonicalSupply = allocation.base + (extras.has(allocation.index) ? 1 : 0);
            if (aggregateLines[allocation.index].supply !== canonicalSupply
              || aggregateLines[allocation.index].vat !== allocation.gross - canonicalSupply) {
              reasons.push(`ORDER_VAT_ALLOCATION_MISMATCH:${allocation.index}`);
            }
          }
        }
      }
    }

    const estimatedGross = estimatedOrderGross(entry.row, productBySourceId);
    if (reasons.length) {
      const combinedEntry = detailEntry
        ? { ...entry, rowHashSha256: sha256(`${entry.rowHashSha256}:${detailEntry.rowHashSha256}`), row: { order: entry.row, detail: detailEntry.row } }
        : entry;
      quarantine.push(quarantineRow(combinedEntry, reasons, estimatedGross));
      continue;
    }

    const targetId = stableUuid("ofd:legacy:order", entry.sourceId);
    const createdAt = isoFromMillis(detailEntry.row.created_at, entry.row.date);
    const status = normalizedStatus;
    const gross = aggregateLines.reduce((sum, line) => sum + line.gross, 0);
    const supply = aggregateLines.reduce((sum, line) => sum + line.supply, 0);
    const vat = aggregateLines.reduce((sum, line) => sum + line.vat, 0);
    const aggregate = {
      id: targetId,
      number: String(detailEntry.row.order_number),
      storeId: store.targetId,
      status,
      source: "legacy_unverified",
      requestedDeliveryDate: deliveryDate,
      note: String(entry.row.memo ?? ""),
      lines: aggregateLines,
      gross,
      supply,
      vat,
      createdBy: actorId,
      ...(status === "approved" ? { approvedBy: actorId, approvedAt: isoFromMillis(detailEntry.row.approved_at, entry.row.date) } : {}),
      ...(detailEntry.row.submitted_at ? { submittedAt: isoFromMillis(detailEntry.row.submitted_at, entry.row.date) } : {}),
      createdAt,
      updatedAt: createdAt,
      version: Math.max(1, Number(detailEntry.row.version) || 1),
    };
    imports.orders.push({
      entity: "order",
      sourceId: entry.sourceId,
      sourceRowHashSha256: sha256(`${entry.rowHashSha256}:${detailEntry.rowHashSha256}`),
      targetId,
      sourcePayload: { order: entry.row, detail: detailEntry.row },
      aggregate,
    });
  }

  const orderIds = new Set(manifest.rows.orders.map((entry) => entry.sourceId));
  for (const detailEntry of manifest.rows.orderDetails) {
    if (!orderIds.has(detailEntry.sourceId)) quarantine.push(quarantineRow(detailEntry, ["ORDER_MISSING"]));
  }

  const importableOrderGross = imports.orders.reduce((sum, row) => sum + row.aggregate.gross, 0);
  const quarantinedOrderGross = quarantine.filter((row) => row.entity === "order").reduce((sum, row) => sum + row.gross, 0);
  const report = {
    sourceSnapshotId: manifest.sourceSnapshotId,
    manifestSha256: manifest.signature.contentHashSha256,
    tableHashes: manifest.tableHashes,
    mappingProfileSha256: sha256(profiles),
    sourceCounts: manifest.sourceCounts,
    importableCounts: { stores: imports.stores.length, products: imports.products.length, orders: imports.orders.length },
    quarantineCounts: Object.fromEntries(["store", "product", "order"].map((entity) => [entity, quarantine.filter((row) => row.entity === entity).length])),
    amounts: {
      sourceOrderGross: importableOrderGross + quarantinedOrderGross,
      importableOrderGross,
      quarantinedOrderGross,
    },
    reconciliationSha256: sha256({ imports, quarantine }),
  };
  report.planDecisionSha256 = sha256({
    manifestSha256: report.manifestSha256,
    mappingProfileSha256: report.mappingProfileSha256,
    actorId,
    cohort,
  });
  return {
    batchId: stableUuid("ofd:legacy:batch", report.planDecisionSha256),
    planSha256: report.planDecisionSha256,
    sourceSystem: SOURCE_SYSTEM,
    manifestSha256: manifest.signature.contentHashSha256,
    signature: manifest.signature,
    sourceSnapshotId: manifest.sourceSnapshotId,
    actorId,
    cohort,
    imports,
    quarantine,
    report,
  };
}

async function existingSourceMapping(client, row) {
  const result = await client.query(
    `SELECT source_row_sha256,target_aggregate_type,target_id,outcome FROM legacy_import_row_mappings
     WHERE source_system = $1 AND entity = $2 AND source_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [SOURCE_SYSTEM, row.entity, row.sourceId],
  );
  return result.rows[0];
}

async function recordMapping(client, plan, row, outcome, reasons = []) {
  await client.query(
    `INSERT INTO legacy_import_row_mappings
     (batch_id,source_system,entity,source_id,source_row_sha256,target_aggregate_type,target_id,outcome,reason_codes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (batch_id,source_system,entity,source_id,source_row_sha256) DO NOTHING`,
    [plan.batchId, SOURCE_SYSTEM, row.entity, row.sourceId, row.sourceRowHashSha256,
      ["imported", "replayed"].includes(outcome) ? row.entity : null,
      ["imported", "replayed"].includes(outcome) ? row.targetId : null, outcome, reasons],
  );
}

async function recordQuarantine(client, plan, row, reasons = row.reasons) {
  await client.query(
    `INSERT INTO legacy_import_quarantine
     (id,batch_id,source_system,entity,source_id,source_row_sha256,reason_codes,source_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
    [stableUuid("ofd:legacy:quarantine", `${plan.batchId}:${row.entity}:${row.sourceId}:${row.sourceRowHashSha256}`), plan.batchId,
      SOURCE_SYSTEM, row.entity, row.sourceId, row.sourceRowHashSha256, reasons, JSON.stringify(row.sourcePayload ?? row.aggregate)],
  );
  await recordMapping(client, plan, row, "quarantined", reasons);
}

export async function applyMigrationPlan(client, plan, { authority, cohort, writeFreezeConfirmed }) {
  if (!client?.query) throw new Error("Postgres client is required");
  if (!writeFreezeConfirmed) throw new Error("write freeze must be confirmed before apply");
  if (!['legacy', 'shadow'].includes(authority)) throw new Error("authority must remain legacy or shadow during import");
  if (cohort !== plan.cohort) throw new Error("cohort does not match the signed migration plan");

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ofd_legacy_import'))");
    const prior = await client.query(
      `SELECT id,status,report FROM legacy_import_batches WHERE plan_sha256 = $1 FOR UPDATE`,
      [plan.planSha256],
    );
    if (prior.rows[0]?.status === "applied") {
      await client.query("COMMIT");
      return { status: "replayed", batchId: prior.rows[0].id, report: prior.rows[0].report };
    }
    const actor = await client.query("SELECT id FROM users WHERE id = $1 AND active = true", [plan.actorId]);
    if (!actor.rows[0]) throw new Error("Migration actor is not a pre-provisioned active Postgres user");
    await client.query(
      `INSERT INTO legacy_import_batches
       (id,source_system,source_snapshot_id,manifest_sha256,plan_sha256,signature_key_id,signature_value,status,authority,cohort,write_freeze_confirmed,source_counts,source_amounts,report,started_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'applying',$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)`,
      [plan.batchId, SOURCE_SYSTEM, plan.sourceSnapshotId, plan.manifestSha256, plan.planSha256, plan.signature.keyId, plan.signature.value,
        authority, cohort, true, JSON.stringify(plan.report.sourceCounts), JSON.stringify(plan.report.amounts), JSON.stringify(plan.report), plan.actorId],
    );
    await client.query(
      `INSERT INTO legacy_cutover_controls
       (cohort,authority,write_freeze_confirmed,active_batch_id,changed_by,change_reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cohort) DO UPDATE SET authority=EXCLUDED.authority,write_freeze_confirmed=EXCLUDED.write_freeze_confirmed,
       active_batch_id=EXCLUDED.active_batch_id,changed_by=EXCLUDED.changed_by,change_reason=EXCLUDED.change_reason,changed_at=now()`,
      [cohort, authority, true, plan.batchId, plan.actorId, "legacy import apply"],
    );

    for (const row of plan.imports.stores) {
      const existing = await existingSourceMapping(client, row);
      if (existing && existing.source_row_sha256 !== row.sourceRowHashSha256) {
        await recordQuarantine(client, plan, row, ["SOURCE_ID_HASH_CONFLICT"]);
        continue;
      }
      if (existing && ["imported", "replayed"].includes(existing.outcome)) {
        await recordMapping(client, plan, row, "replayed");
        continue;
      }
      const store = row.aggregate;
      await client.query(
        `INSERT INTO legal_entities
         (id,business_number,legal_name,representative_name,address,business_type,business_category,email,is_headquarters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT (id) DO NOTHING`,
        [row.legalEntityId, store.business.businessNumber, store.business.legalName, store.business.representativeName,
          store.business.address, store.business.businessType, store.business.businessCategory, store.business.email],
      );
      await client.query(
        `INSERT INTO stores (id,code,name,legal_entity_id,billing_cycle,payment_method,notification_phone,active,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [row.targetId, store.code, store.name, row.legalEntityId, store.billingCycle, store.paymentMethod, store.notificationPhone, store.active, store.version],
      );
      await client.query(
        `INSERT INTO aggregate_snapshots (aggregate_type,aggregate_id,store_id,version,payload)
         VALUES ('store',$1,$1,$2,$3::jsonb) ON CONFLICT (aggregate_type,aggregate_id) DO NOTHING`,
        [row.targetId, store.version, JSON.stringify(store)],
      );
      await recordMapping(client, plan, row, "imported");
    }

    for (const row of plan.imports.products) {
      const existing = await existingSourceMapping(client, row);
      if (existing && existing.source_row_sha256 !== row.sourceRowHashSha256) {
        await recordQuarantine(client, plan, row, ["SOURCE_ID_HASH_CONFLICT"]);
        continue;
      }
      if (existing && ["imported", "replayed"].includes(existing.outcome)) {
        await recordMapping(client, plan, row, "replayed");
        continue;
      }
      const product = row.aggregate;
      await client.query(
        `INSERT INTO products (id,sku,name,unit,taxable,tax_rate,active)
         VALUES ($1,$2,$3,$4,true,10,$5) ON CONFLICT (id) DO NOTHING`,
        [row.targetId, product.sku, product.name, product.unit, product.active],
      );
      await client.query(
        `INSERT INTO supply_price_versions (id,product_id,gross_amount,valid_from,created_by)
         VALUES ($1,$2,$3,DATE '1970-01-01',$4) ON CONFLICT (id) DO NOTHING`,
        [stableUuid("ofd:legacy:price", row.sourceId), row.targetId, product.unitGross, plan.actorId],
      );
      await client.query(
        `INSERT INTO aggregate_snapshots (aggregate_type,aggregate_id,store_id,version,payload)
         VALUES ('product',$1,NULL,1,$2::jsonb) ON CONFLICT (aggregate_type,aggregate_id) DO NOTHING`,
        [row.targetId, JSON.stringify(product)],
      );
      await recordMapping(client, plan, row, "imported");
    }

    for (const row of plan.imports.orders) {
      const existing = await existingSourceMapping(client, row);
      if (existing && existing.source_row_sha256 !== row.sourceRowHashSha256) {
        await recordQuarantine(client, plan, row, ["SOURCE_ID_HASH_CONFLICT"]);
        continue;
      }
      if (existing && ["imported", "replayed"].includes(existing.outcome)) {
        await recordMapping(client, plan, row, "replayed");
        continue;
      }
      const order = row.aggregate;
      await client.query(
        `INSERT INTO purchase_orders
         (id,order_number,store_id,status,source,requested_delivery_date,note,gross_amount,supply_amount,vat_amount,created_by,approved_by,submitted_at,approved_at,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'legacy_unverified',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO NOTHING`,
        [row.targetId, order.number, order.storeId, order.status, order.requestedDeliveryDate, order.note, order.gross, order.supply,
          order.vat, plan.actorId, order.approvedBy ?? null, order.submittedAt ?? null, order.approvedAt ?? null, order.version, order.createdAt, order.updatedAt],
      );
      for (const line of order.lines) {
        await client.query(
          `INSERT INTO purchase_order_lines
           (id,order_id,product_id,sku_snapshot,product_name_snapshot,unit_snapshot,unit_gross_snapshot,quantity,gross_amount,supply_amount,vat_amount,tax_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,10) ON CONFLICT (id) DO NOTHING`,
          [line.id, row.targetId, line.snapshot.productId, line.snapshot.sku, line.snapshot.name, line.snapshot.unit, line.snapshot.unitGross,
            line.quantity, line.gross, line.supply, line.vat],
        );
      }
      await client.query(
        `INSERT INTO aggregate_snapshots (aggregate_type,aggregate_id,store_id,version,payload)
         VALUES ('order',$1,$2,$3,$4::jsonb) ON CONFLICT (aggregate_type,aggregate_id) DO NOTHING`,
        [row.targetId, order.storeId, order.version, JSON.stringify(order)],
      );
      await recordMapping(client, plan, row, "imported");
    }

    for (const row of plan.quarantine) await recordQuarantine(client, plan, row);
    await client.query(
      `UPDATE legacy_import_batches SET status='applied',applied_counts=$2::jsonb,quarantine_counts=$3::jsonb,
       report=$4::jsonb,completed_at=now() WHERE id=$1`,
      [plan.batchId, JSON.stringify(plan.report.importableCounts), JSON.stringify(plan.report.quarantineCounts), JSON.stringify(plan.report)],
    );
    await client.query("COMMIT");
    return { status: "applied", batchId: plan.batchId, report: plan.report };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function evaluateRollbackPreconditions({ batchStatus, authority, writeFreezeConfirmed, downstreamCounts = {}, nativeWritesAfterBatch = 0 }) {
  const blockers = [];
  if (batchStatus !== "applied") blockers.push("BATCH_NOT_APPLIED");
  if (authority === "v2") blockers.push("AUTHORITY_ALREADY_V2");
  if (!writeFreezeConfirmed) blockers.push("WRITE_FREEZE_NOT_CONFIRMED");
  if (Object.values(downstreamCounts).some((count) => Number(count) > 0)) blockers.push("DOWNSTREAM_EFFECTS_EXIST");
  if (Number(nativeWritesAfterBatch) > 0) blockers.push("NATIVE_WRITES_EXIST");
  return { ready: blockers.length === 0, blockers };
}

export const legacyMigrationConstants = { FORMAT_VERSION, SOURCE_SYSTEM };
