import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "@ofd/domain";
import type { ProviderConfig } from "./config.ts";

export interface UploadTicket {
  objectKey: string;
  uploadUrl: string;
  publicUrl?: string;
  expiresInSeconds: number;
  requiredHeaders: Record<string, string>;
}

export interface ObjectStorage {
  createDeliveryProofUpload(shipmentId: string, contentType: string): Promise<UploadTicket>;
  verifyDeliveryProof(shipmentId: string, objectKey: string): Promise<{ objectKey: string; versionId: string; etag: string; checksumSha256: string; size: number; contentType: string }>;
  createReadUrl(objectKey: string, versionId: string): Promise<string>;
  recordMockUpload?(objectKey: string, contentType: string, bytes: Uint8Array): Promise<void>;
}

export class MockObjectStorage implements ObjectStorage {
  private readonly tickets = new Map<string, { shipmentId: string; contentType: string; expiresAt: number; uploadedSize?: number; versionId?: string; etag?: string; checksumSha256?: string }>();

  async createDeliveryProofUpload(shipmentId: string, contentType: string): Promise<UploadTicket> {
    assertPhotoType(contentType);
    const objectKey = `delivery-proofs/${shipmentId}/${randomUUID()}.jpg`;
    this.tickets.set(objectKey, { shipmentId, contentType, expiresAt: Date.now() + 900_000 });
    return {
      objectKey, uploadUrl: `/api/v2/mock-uploads?key=${encodeURIComponent(objectKey)}`,
      publicUrl: `/api/v2/mock-files/${encodeURIComponent(objectKey)}`, expiresInSeconds: 900,
      requiredHeaders: { "content-type": contentType },
    };
  }

  constructor(private readonly uploadMaxBytes = 10 * 1024 * 1024) {}

  async recordMockUpload(objectKey: string, contentType: string, bytes: Uint8Array): Promise<void> {
    const ticket = this.tickets.get(objectKey);
    if (!ticket || ticket.expiresAt < Date.now()) throw new DomainError("UPLOAD_TICKET_INVALID", "업로드 주소가 없거나 만료되었습니다.", 410);
    if (ticket.contentType !== contentType) throw new DomainError("UPLOAD_CONTENT_TYPE_MISMATCH", "발급된 사진 형식과 업로드 형식이 다릅니다.", 415);
    if (ticket.uploadedSize) throw new DomainError("UPLOAD_ALREADY_USED", "이미 사용된 단일 업로드 주소입니다.", 409);
    if (bytes.byteLength <= 0 || bytes.byteLength > this.uploadMaxBytes) throw new DomainError("INVALID_PHOTO_SIZE", `배송 사진은 1바이트~${this.uploadMaxBytes}바이트여야 합니다.`, 413);
    if (detectImageMime(bytes) !== contentType) throw new DomainError("PHOTO_SIGNATURE_MISMATCH", "파일 내용과 이미지 형식이 일치하지 않습니다.", 415);
    ticket.uploadedSize = bytes.byteLength;
    ticket.versionId = randomUUID();
    ticket.checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    ticket.etag = createHash("md5").update(bytes).digest("hex");
    this.tickets.set(objectKey, ticket);
  }

  async verifyDeliveryProof(shipmentId: string, objectKey: string): Promise<{ objectKey: string; versionId: string; etag: string; checksumSha256: string; size: number; contentType: string }> {
    const ticket = this.tickets.get(objectKey);
    if (!ticket || ticket.expiresAt < Date.now()) throw new DomainError("UPLOAD_TICKET_INVALID", "업로드 주소가 없거나 만료되었습니다.", 410);
    if (ticket.shipmentId !== shipmentId) throw new DomainError("PHOTO_SHIPMENT_MISMATCH", "다른 배송 건의 사진은 사용할 수 없습니다.", 409);
    if (!ticket.uploadedSize) throw new DomainError("PHOTO_NOT_UPLOADED", "사진 업로드가 완료되지 않았습니다.", 409);
    return { objectKey, versionId: ticket.versionId!, etag: ticket.etag!, checksumSha256: ticket.checksumSha256!, size: ticket.uploadedSize, contentType: ticket.contentType };
  }

  async createReadUrl(objectKey: string, versionId: string): Promise<string> {
    return `/api/v2/mock-files?key=${encodeURIComponent(objectKey)}&versionId=${encodeURIComponent(versionId)}`;
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly config: ProviderConfig) {
    if (!config.s3Bucket || !config.s3Region) throw new DomainError("S3_NOT_CONFIGURED", "S3_BUCKET과 S3_REGION이 필요합니다.", 503);
    this.client = new S3Client({ region: config.s3Region, endpoint: config.s3Endpoint, forcePathStyle: Boolean(config.s3Endpoint),
      credentials: config.s3AccessKeyId && config.s3SecretAccessKey
        ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } : undefined });
  }

  async createDeliveryProofUpload(shipmentId: string, contentType: string): Promise<UploadTicket> {
    assertPhotoType(contentType);
    const objectKey = `delivery-proofs/${shipmentId}/${randomUUID()}.jpg`;
    const ticketExpires = String(Date.now() + 900_000);
    const encryption = this.config.appMode === "production"
      ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: this.config.s3KmsKeyId }
      : this.config.s3Endpoint ? {} : { ServerSideEncryption: "AES256" as const };
    const command = new PutObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey, ContentType: contentType,
      Metadata: { shipmentid: shipmentId, ticketexpires: ticketExpires }, ...encryption });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: 900 });
    return { objectKey, uploadUrl, expiresInSeconds: 900, requiredHeaders: {
      "content-type": contentType, "x-amz-meta-shipmentid": shipmentId, "x-amz-meta-ticketexpires": ticketExpires,
    } };
  }

  async verifyDeliveryProof(shipmentId: string, objectKey: string): Promise<{ objectKey: string; versionId: string; etag: string; checksumSha256: string; size: number; contentType: string }> {
    if (!objectKey.startsWith(`delivery-proofs/${shipmentId}/`)) throw new DomainError("PHOTO_SHIPMENT_MISMATCH", "다른 배송 건의 사진은 사용할 수 없습니다.", 409);
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey }));
    } catch {
      throw new DomainError("PHOTO_NOT_UPLOADED", "S3에서 업로드된 배송 사진을 확인할 수 없습니다.", 409);
    }
    const size = head.ContentLength ?? 0;
    const contentType = head.ContentType ?? "";
    if (!head.VersionId) throw new DomainError("S3_VERSIONING_REQUIRED", "배송 증빙 버킷의 버전 관리가 필요합니다.", 503);
    if (head.Metadata?.shipmentid !== shipmentId) throw new DomainError("PHOTO_METADATA_MISMATCH", "배송 사진 메타데이터가 일치하지 않습니다.", 409);
    if (!head.Metadata?.ticketexpires || Number(head.Metadata.ticketexpires) < Date.now()) throw new DomainError("UPLOAD_TICKET_INVALID", "업로드 주소가 없거나 만료되었습니다.", 410);
    assertPhotoType(contentType);
    if (size <= 0 || size > this.config.uploadMaxBytes) throw new DomainError("INVALID_PHOTO_SIZE", `배송 사진은 1바이트~${this.config.uploadMaxBytes}바이트여야 합니다.`, 413);
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey, VersionId: head.VersionId }));
    const bytes = new Uint8Array(await object.Body!.transformToByteArray());
    if (detectImageMime(bytes) !== contentType) throw new DomainError("PHOTO_SIGNATURE_MISMATCH", "파일 내용과 이미지 형식이 일치하지 않습니다.", 415);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    return { objectKey, versionId: head.VersionId, etag: (head.ETag ?? "").replaceAll('"', ""), checksumSha256, size, contentType };
  }


  async createReadUrl(objectKey: string, versionId: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey, VersionId: versionId }), { expiresIn: 900 });
  }
}

function assertPhotoType(contentType: string): void {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
    throw new DomainError("INVALID_PHOTO_TYPE", "배송 사진은 JPEG, PNG 또는 WebP만 업로드할 수 있습니다.", 415);
  }
}

export function detectImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}
