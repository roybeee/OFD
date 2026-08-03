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
    case "shipment": {
      const order = claim("shipment.order", value.orderId);
      const route = typeof value.driverId === "string" && typeof value.plannedDate === "string" && Number.isInteger(value.routeSequence)
        ? claim("shipment.driver_date_sequence", `${value.driverId}:${value.plannedDate}:${String(value.routeSequence)}`) : [];
      return [...order, ...route];
    }
    case "receipt": return claim("receipt.shipment", value.shipmentId);
    case "tax_invoice": {
      const part = typeof value.invoiceGroupId === "string" && Number.isInteger(value.partNumber)
        ? claim("invoice.part", `${value.invoiceGroupId}:${String(value.partNumber)}`) : [];
      const generation = value.partNumber === 1 && value.issueType !== "modified" ? claim("invoice.settlement_generation", value.settlementId) : [];
      return [...part, ...generation];
    }
    case "payment_request": return [
      ...(value.orderId ? claim("prepayment.order", value.orderId) : []),
      ...(value.settlementId ? claim("payment.settlement", value.settlementId) : []),
    ];
    case "document": return typeof value.kind === "string" && typeof value.aggregateId === "string" && Number.isInteger(value.sourceVersion)
      ? claim("document.source", `${value.kind}:${value.aggregateId}:${String(value.sourceVersion)}`) : [];
    case "settlement": {
      const period = value.kind === "monthly" && typeof value.storeId === "string" && typeof value.periodStart === "string" && typeof value.periodEnd === "string"
        ? claim("settlement.period", `${value.storeId}:${value.periodStart}:${value.periodEnd}`) : [];
      const receipts = Array.isArray(value.receiptIds)
        ? value.receiptIds.flatMap((receiptId) => claim("settlement.receipt", receiptId)) : [];
      return [...period, ...receipts];
    }
    default: return [];
  }
}
