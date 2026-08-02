import type { AggregateChange } from "./repository.ts";

export interface AggregateClaim {
  type: string;
  key: string;
  aggregateType: string;
  aggregateId: string;
}

export function deriveClaims(change: AggregateChange): AggregateClaim[] {
  if (change.expectedVersion !== null || !change.value || typeof change.value !== "object") return [];
  const value = change.value as Record<string, unknown>;
  const claim = (type: string, key: unknown): AggregateClaim[] => typeof key === "string" && key
    ? [{ type, key, aggregateType: change.type, aggregateId: change.id }]
    : [];
  switch (change.type) {
    case "bank_transaction": return claim("bank.provider", value.providerId);
    case "shipment": return claim("shipment.order", value.orderId);
    case "receipt": return claim("receipt.shipment", value.shipmentId);
    case "tax_invoice": {
      const part = typeof value.invoiceGroupId === "string" && Number.isInteger(value.partNumber)
        ? claim("invoice.part", `${value.invoiceGroupId}:${String(value.partNumber)}`) : [];
      const generation = value.partNumber === 1 && value.issueType !== "modified" ? claim("invoice.settlement_generation", value.settlementId) : [];
      return [...part, ...generation];
    }
    case "payment_request": return value.orderId ? claim("prepayment.order", value.orderId) : [];
    case "settlement": {
      const period = typeof value.storeId === "string" && typeof value.periodStart === "string" && typeof value.periodEnd === "string"
        ? claim("settlement.period", `${value.storeId}:${value.periodStart}:${value.periodEnd}`) : [];
      const receipts = Array.isArray(value.receiptIds)
        ? value.receiptIds.flatMap((receiptId) => claim("settlement.receipt", receiptId)) : [];
      return [...period, ...receipts];
    }
    default: return [];
  }
}
