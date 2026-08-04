import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import type { Actor, PurchaseOrder, Shipment } from "@ofd/domain";
import { MockObjectStorage } from "@ofd/integrations";
import { describe, expect, it } from "vitest";
import { AuthService } from "./auth-service.ts";
import { ProcurementService } from "./service.ts";

describe("hq_master deactivation serialization", () => {
  it("blocks deactivation of a driver with a ready or active shipment", async () => {
    const repository = createDemoRepository();
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const driver = (await repository.get<Actor>("actor", DEMO_IDS.driver))!;
    const auth = new AuthService(repository, "test-session-secret-with-at-least-32-bytes", "test");
    await expect(auth.deactivateActor(master, driver.id, driver.authVersion))
      .rejects.toMatchObject({ code: "DRIVER_HAS_ACTIVE_SHIPMENTS", statusCode: 409 });
  });

  it("serializes assignment against driver deactivation so no inactive driver owns a preparing shipment", async () => {
    const repository = createDemoRepository();
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const ops = (await repository.get<Actor>("actor", DEMO_IDS.ops))!;
    const auth = new AuthService(repository, "test-session-secret-with-at-least-32-bytes", "test");
    const provisioned = await auth.provisionActor(master, {
      name: "경쟁조건 테스트 기사", role: "driver", storeIds: [], email: "driver.race@ofd.local",
      password: "OFD-driver-race-2026!",
    });
    const driver = (await repository.get<Actor>("actor", provisioned.actor.id))!;
    const order: PurchaseOrder = {
      id: "driver-race-order", number: "PO-DRIVER-RACE", storeId: DEMO_IDS.storeDoksan, status: "approved", source: "native",
      requestedDeliveryDate: "2026-08-04", note: "", gross: 11_000, supply: 10_000, vat: 1_000,
      lines: [{ id: "driver-race-line", snapshot: { productId: DEMO_IDS.productBean, sku: "BEAN-1K", name: "원두", unit: "박스",
        unitGross: 11_000, taxable: true, taxRate: 10 }, quantity: 1, gross: 11_000, supply: 10_000, vat: 1_000 }],
      createdBy: DEMO_IDS.owner, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", version: 1,
    };
    await repository.commit({ changes: [{ type: "order", id: order.id, storeId: order.storeId, expectedVersion: null, value: order }] });
    const procurement = new ProcurementService(repository, new MockObjectStorage(), "test", "ofd-main", "mock", false,
      () => new Date("2026-08-03T15:30:00.000Z"));

    const outcomes = await Promise.allSettled([
      procurement.createShipment(ops, order.id, driver.id, "2026-08-04", 1, { start: "09:00", end: "10:00" }),
      auth.deactivateActor(master, driver.id, driver.authVersion),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(["AGGREGATE_EXISTS", "VERSION_CONFLICT"]).toContain(rejection?.reason?.code);
    const persistedDriver = (await repository.get<Actor>("actor", driver.id))!;
    const activeShipments = (await repository.list<Shipment>("shipment"))
      .filter((shipment) => shipment.driverId === driver.id && shipment.status === "preparing");
    expect(persistedDriver.active || activeShipments.length === 0).toBe(true);

    if (persistedDriver.active) {
      expect(activeShipments).toHaveLength(1);
      expect(persistedDriver.authVersion).toBe(driver.authVersion);
      await expect(auth.deactivateActor(master, driver.id, persistedDriver.authVersion))
        .rejects.toMatchObject({ code: "DRIVER_HAS_ACTIVE_SHIPMENTS" });
    } else {
      expect(activeShipments).toHaveLength(0);
      await expect(procurement.createShipment(ops, order.id, driver.id, "2026-08-04", 1, { start: "09:00", end: "10:00" }))
        .rejects.toMatchObject({ code: "DRIVER_INACTIVE" });
    }
  });

  it("serializes competing master deactivations without changing the caller authVersion", async () => {
    const repository = createDemoRepository();
    const master = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const auth = new AuthService(repository, "test-session-secret-with-at-least-32-bytes", "test");
    const second = await auth.provisionActor(master, {
      name: "두 번째 최고관리자", role: "hq_master", storeIds: [], email: "master.second@ofd.local",
      password: "OFD-master-two-2026!", mfaSecret: "JBSWY3DPEHPK3PXP",
    });
    const third = await auth.provisionActor(master, {
      name: "세 번째 최고관리자", role: "hq_master", storeIds: [], email: "master.third@ofd.local",
      password: "OFD-master-three-2026!", mfaSecret: "JBSWY3DPEHPK3PXQ",
    });

    const outcomes = await Promise.allSettled([
      auth.deactivateActor(master, second.actor.id, second.actor.version),
      auth.deactivateActor(master, third.actor.id, third.actor.version),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(["AGGREGATE_EXISTS", "VERSION_CONFLICT"]).toContain(rejection?.reason?.code);

    const secondPersisted = (await repository.get<Actor>("actor", second.actor.id))!;
    const thirdPersisted = (await repository.get<Actor>("actor", third.actor.id))!;
    expect([secondPersisted, thirdPersisted].filter((candidate) => !candidate.active)).toHaveLength(1);
    expect([secondPersisted, thirdPersisted].filter((candidate) => candidate.active)).toHaveLength(1);
    expect(await repository.get<Actor>("actor", master.id)).toMatchObject({ active: true, authVersion: 1 });
    expect((await repository.listAudit(20)).map((event) => event.action)).toContain("admin.master_deactivation_serialized");
  });
});
