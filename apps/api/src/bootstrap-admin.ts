import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { PostgresRepository } from "@ofd/db";
import { hashPassword, type Actor, type UserCredential } from "@ofd/domain";
import { audit } from "./events.ts";

const databaseUrl = required("DATABASE_URL");
const repository = PostgresRepository.connect(databaseUrl);
try {
  const existingHq = (await repository.list<{ isHeadquarters?: boolean }>("legal_entity")).some((entity) => entity.isHeadquarters);
  const existingMaster = (await repository.list<Actor>("actor")).some((actor) => actor.role === "hq_master");
  if (existingHq || existingMaster) throw new Error("bootstrap-admin refused: headquarters or master already exists");

  const password = process.env.BOOTSTRAP_MASTER_PASSWORD ?? await promptSecret("최초 마스터 비밀번호: ");
  const passwordConfirm = process.env.BOOTSTRAP_MASTER_PASSWORD ?? await promptSecret("비밀번호 확인: ");
  if (password !== passwordConfirm) throw new Error("비밀번호가 일치하지 않습니다.");
  const actor: Actor = {
    id: randomUUID(), name: required("BOOTSTRAP_MASTER_NAME"), role: "hq_master", storeIds: [],
    active: true, authVersion: 1,
  };
  const legalEntity = {
    id: randomUUID(), isHeadquarters: true,
    businessNumber: required("BOOTSTRAP_HQ_BUSINESS_NUMBER").replaceAll("-", ""),
    legalName: required("BOOTSTRAP_HQ_LEGAL_NAME"), representativeName: required("BOOTSTRAP_HQ_REPRESENTATIVE"),
    address: required("BOOTSTRAP_HQ_ADDRESS"), businessType: required("BOOTSTRAP_HQ_BUSINESS_TYPE"),
    businessCategory: required("BOOTSTRAP_HQ_BUSINESS_CATEGORY"), email: required("BOOTSTRAP_HQ_EMAIL"),
  };
  if (!/^\d{10}$/.test(legalEntity.businessNumber)) throw new Error("본사 사업자번호는 숫자 10자리여야 합니다.");
  const credential: UserCredential = {
    id: randomUUID(), actorId: actor.id, email: required("BOOTSTRAP_MASTER_EMAIL").trim().toLowerCase(),
    passwordHash: hashPassword(password), failedAttempts: 0, version: 1,
  };
  await repository.commit({
    changes: [
      { type: "legal_entity", id: legalEntity.id, expectedVersion: null, value: legalEntity },
      { type: "actor", id: actor.id, expectedVersion: null, value: actor },
      { type: "credential", id: credential.id, expectedVersion: null, value: credential },
    ],
    audits: [audit(actor, "system", legalEntity.id, "system.bootstrap_admin_created", undefined, undefined,
      { headquartersId: legalEntity.id, masterActorId: actor.id, masterEmail: credential.email })],
  });
  stdout.write(`bootstrap-admin completed: headquarters=${legalEntity.id}, master=${actor.id}\n`);
} finally {
  await repository.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error("비대화형 실행에서는 BOOTSTRAP_MASTER_PASSWORD가 필요합니다.");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (key: string): void => {
      if (key === "\r" || key === "\n") {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\n");
        resolve(value);
      } else if (key === "\u0003") {
        stdin.setRawMode(false);
        reject(new Error("cancelled"));
      } else if (key === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
    };
    stdin.on("data", onData);
  });
}
