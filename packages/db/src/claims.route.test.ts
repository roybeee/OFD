import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "./memory-repository.ts";

test("driver/date/route sequence is claimed atomically across different orders", async () => {
  const repository = new MemoryRepository();
  const shipment = (id: string, orderId: string) => ({
    type: "shipment" as const, id, storeId: "store-1", expectedVersion: null,
    value: { id, orderId, driverId: "driver-1", plannedDate: "2026-08-04", routeSequence: 7, version: 1 },
  });
  const results = await Promise.allSettled([
    repository.commit({ changes: [shipment("shipment-a", "order-a")] }),
    repository.commit({ changes: [shipment("shipment-b", "order-b")] }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected?.reason?.code, "BUSINESS_KEY_CONFLICT");
  assert.equal(rejected?.reason?.details?.claimType, "shipment.driver_date_sequence");
});
