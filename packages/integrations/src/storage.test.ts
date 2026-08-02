import assert from "node:assert/strict";
import test from "node:test";
import { MockObjectStorage } from "./storage.ts";

test("업로드하지 않은 배송 사진 키는 완료 증빙으로 사용할 수 없다", async () => {
  const storage = new MockObjectStorage();
  const ticket = await storage.createDeliveryProofUpload("shipment-1", "image/jpeg");
  await assert.rejects(storage.verifyDeliveryProof("shipment-1", ticket.objectKey), /업로드가 완료되지/);
});

test("다른 배송에 발급된 사진 키를 거부한다", async () => {
  const storage = new MockObjectStorage();
  const ticket = await storage.createDeliveryProofUpload("shipment-1", "image/jpeg");
  await storage.recordMockUpload(ticket.objectKey, "image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
  await assert.rejects(storage.verifyDeliveryProof("shipment-2", ticket.objectKey), /다른 배송/);
});

test("발급·업로드·검증을 모두 거친 사진만 canonical URL을 반환한다", async () => {
  const storage = new MockObjectStorage();
  const ticket = await storage.createDeliveryProofUpload("shipment-1", "image/webp");
  await storage.recordMockUpload(ticket.objectKey, "image/webp", Uint8Array.from([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50]));
  const verified = await storage.verifyDeliveryProof("shipment-1", ticket.objectKey);
  assert.equal(verified.size, 12);
  assert.match(await storage.createReadUrl(verified.objectKey, verified.versionId), /^\/api\/v2\/mock-files/);
});

test("Content-Type만 이미지인 위장 파일을 거부한다", async () => {
  const storage = new MockObjectStorage();
  const ticket = await storage.createDeliveryProofUpload("shipment-1", "image/jpeg");
  await assert.rejects(storage.recordMockUpload(ticket.objectKey, "image/jpeg", Uint8Array.from([1, 2, 3, 4])), /파일 내용/);
});

test("설정한 업로드 상한을 초과한 파일을 거부한다", async () => {
  const storage = new MockObjectStorage(3);
  const ticket = await storage.createDeliveryProofUpload("shipment-1", "image/jpeg");
  await assert.rejects(storage.recordMockUpload(ticket.objectKey, "image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0])), /바이트/);
});
