import { createDemoRepository, DEMO_IDS } from "@ofd/db";
import { generateTotp, type Actor, type UserCredential } from "@ofd/domain";
import { describe, expect, it } from "vitest";
import { AuthService } from "./auth-service.ts";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";
const mfaSecret = "JBSWY3DPEHPK3PXP";

async function credentialFor(repository: ReturnType<typeof createDemoRepository>, actorId: string) {
  return (await repository.list<UserCredential>("credential")).find((credential) => credential.actorId === actorId)!;
}

function fiveFailures(run: (attempt: number) => Promise<unknown>) {
  return Promise.allSettled(Array.from({ length: 5 }, (_, attempt) => run(attempt)));
}

describe("AuthService concurrent failure lockout", () => {
  it("counts every concurrent password login failure and globally locks the account", async () => {
    const repository = createDemoRepository();
    const auth = new AuthService(repository, sessionSecret, "test");

    const results = await fiveFailures((attempt) => auth.login("store.owner@ofd.local", "wrong-password", `10.0.0.${attempt}`));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const credential = await credentialFor(repository, DEMO_IDS.owner);
    expect(credential.failedAttempts).toBe(5);
    expect(new Date(credential.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("counts every concurrent MFA failure and globally locks the account", async () => {
    const repository = createDemoRepository();
    const auth = new AuthService(repository, sessionSecret, "test");
    const login = await auth.login("hq.finance@ofd.local", "OFD-demo-2026!", "10.0.1.1");
    const validCode = generateTotp(mfaSecret);
    const invalidCode = validCode === "000000" ? "000001" : "000000";

    const results = await fiveFailures((attempt) => auth.completeMfa(login.challengeToken!, invalidCode, `10.0.1.${attempt + 2}`));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const credential = await credentialFor(repository, DEMO_IDS.finance);
    expect(credential.failedAttempts).toBe(5);
    expect(new Date(credential.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("counts every concurrent step-up failure and globally locks the account", async () => {
    const repository = createDemoRepository();
    const auth = new AuthService(repository, sessionSecret, "test");
    const actor = (await repository.get<Actor>("actor", DEMO_IDS.master))!;
    const validCode = generateTotp(mfaSecret);

    const results = await fiveFailures((attempt) => auth.stepUp(actor, "wrong-password", validCode, `10.0.2.${attempt}`));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const credential = await credentialFor(repository, DEMO_IDS.master);
    expect(credential.failedAttempts).toBe(5);
    expect(new Date(credential.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
  });
});
