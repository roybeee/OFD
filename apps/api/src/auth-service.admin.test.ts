import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import type { Actor, UserCredential } from "@ofd/domain";
import { describe, expect, it } from "vitest";
import { AuthService, type ProvisionActorInput } from "./auth-service.ts";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";

async function adminFixture() {
  const repository = createDemoRepository();
  const master = await repository.get<Actor>("actor", DEMO_IDS.master);
  if (!master) throw new Error("demo master actor is missing");
  return { repository, master, auth: new AuthService(repository, sessionSecret, "test") };
}

describe("AuthService actor administration", () => {
  it("requires an hq_master with a recent step-up before provisioning accounts", async () => {
    const { auth, master } = await adminFixture();
    const input: ProvisionActorInput = {
      name: "신규 배송기사",
      role: "driver",
      storeIds: [],
      email: "driver.new@ofd.local",
      password: "OFD-driver-2026!",
    };
    const staleMaster: Actor = {
      ...master,
      mfaVerified: true,
      mfaVerifiedAt: new Date(Date.now() - 5 * 60_000 - 1_000).toISOString(),
    };

    await expect(auth.provisionActor(staleMaster, input)).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
      statusCode: 403,
    });

    const nonMaster: Actor = {
      ...master,
      id: DEMO_IDS.ops,
      role: "hq_ops",
    };
    await expect(auth.provisionActor(nonMaster, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });

  it("provisions an actor/credential pair while returning only the sanitized admin contract", async () => {
    const { repository, master, auth } = await adminFixture();
    const result = await auth.provisionActor(master, {
      name: "  신규 배송기사  ",
      role: "driver",
      storeIds: [],
      email: " Driver.New@OFD.Local ",
      password: "OFD-driver-2026!",
    });

    expect(result.actor).toMatchObject({
      name: "신규 배송기사",
      role: "driver",
      storeIds: [],
      email: "driver.new@ofd.local",
      active: true,
      version: 1,
      mfaEnabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain("mfaSecretEncrypted");

    const persistedActor = await repository.get<Actor>("actor", result.actor.id);
    const persistedCredential = (await repository.list<UserCredential>("credential"))
      .find((credential) => credential.actorId === result.actor.id);
    expect(persistedActor).toMatchObject({ id: result.actor.id, role: "driver", active: true });
    expect(persistedCredential).toMatchObject({ email: "driver.new@ofd.local", actorId: result.actor.id });

    const directory = await auth.listActorAccounts(master);
    expect(directory.actors.some((actor) => actor.id === DEMO_IDS.system)).toBe(false);
    expect(directory.actors.some((actor) => actor.id === result.actor.id)).toBe(true);
    expect(JSON.stringify(directory)).not.toContain("passwordHash");
    expect(JSON.stringify(directory)).not.toContain("mfaSecretEncrypted");
  });

  it("requires MFA for privileged accounts and rejects system provisioning even from an untyped caller", async () => {
    const { repository, master, auth } = await adminFixture();
    await expect(auth.provisionActor(master, {
      name: "신규 운영자",
      role: "hq_ops",
      storeIds: [],
      email: "ops.new@ofd.local",
      password: "OFD-operator-2026!",
    })).rejects.toMatchObject({ code: "MFA_REQUIRED" });

    const unsafeSystemInput = {
      name: "시스템 위장 계정",
      role: "system",
      storeIds: [],
      email: "system.fake@ofd.local",
      password: "OFD-system-fake-2026!",
    } as unknown as ProvisionActorInput;
    await expect(auth.provisionActor(master, unsafeSystemInput)).rejects.toMatchObject({
      code: "ACTOR_ROLE_NOT_PROVISIONABLE",
    });
    const systemActors = (await repository.list<Actor>("actor")).filter((actor) => actor.role === "system");
    expect(systemActors).toHaveLength(1);
    expect(systemActors[0]?.id).toBe(DEMO_IDS.system);
  });
});
