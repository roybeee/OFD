import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { GetBucketVersioningCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export interface ImmutableObjectWrite {
  objectKey: string;
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  metadata?: Record<string, string>;
}

export interface ImmutableObjectMetadata {
  objectKey: string;
  objectVersionId: string;
  etag: string;
  contentHashSha256: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export interface ImmutableObject extends ImmutableObjectMetadata {
  bytes: Uint8Array;
}

export interface StorageReadiness {
  ok: boolean;
  mode: "mock" | "s3";
  reachable: boolean;
  notRequired?: boolean;
  versioning: "Enabled" | "Suspended" | "Disabled" | "Unknown" | "NotRequired";
  code?: string;
}

export interface ObjectStorage {
  checkReadiness(): Promise<StorageReadiness>;
  createDeliveryProofUpload(shipmentId: string, contentType: string): Promise<UploadTicket>;
  verifyDeliveryProof(shipmentId: string, objectKey: string): Promise<{ objectKey: string; versionId: string; etag: string; checksumSha256: string; size: number; contentType: string }>;
  createReadUrl(objectKey: string, versionId: string): Promise<string>;
  putImmutableObject(input: ImmutableObjectWrite): Promise<ImmutableObjectMetadata>;
  getImmutableObject(objectKey: string, objectVersionId: string): Promise<ImmutableObject>;
  recordMockUpload?(objectKey: string, contentType: string, bytes: Uint8Array): Promise<void>;
}

export class MockObjectStorage implements ObjectStorage {
  private readonly tickets = new Map<string, { shipmentId: string; contentType: string; expiresAt: number; uploadedSize?: number; versionId?: string; etag?: string; checksumSha256?: string }>();
  private readonly immutableObjects = new Map<string, ImmutableObject>();

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

  async checkReadiness(): Promise<StorageReadiness> {
    return { ok: true, mode: "mock", reachable: true, notRequired: true, versioning: "NotRequired" };
  }

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

  async putImmutableObject(input: ImmutableObjectWrite): Promise<ImmutableObjectMetadata> {
    assertImmutableWrite(input);
    const contentHashSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.immutableObjects.get(input.objectKey);
    if (existing) {
      if (existing.contentHashSha256 !== contentHashSha256 || existing.mimeType !== input.mimeType || existing.fileName !== input.fileName) {
        throw new DomainError("IMMUTABLE_OBJECT_CONFLICT", "같은 원본 문서 키를 다른 내용으로 덮어쓸 수 없습니다.", 409);
      }
      return immutableMetadata(existing);
    }
    const object: ImmutableObject = {
      objectKey: input.objectKey,
      objectVersionId: randomUUID(),
      etag: createHash("md5").update(input.bytes).digest("hex"),
      contentHashSha256,
      mimeType: input.mimeType,
      fileName: input.fileName,
      sizeBytes: input.bytes.byteLength,
      bytes: Uint8Array.from(input.bytes),
    };
    this.immutableObjects.set(input.objectKey, object);
    return immutableMetadata(object);
  }

  async getImmutableObject(objectKey: string, objectVersionId: string): Promise<ImmutableObject> {
    const object = this.immutableObjects.get(objectKey);
    if (!object || object.objectVersionId !== objectVersionId) {
      throw new DomainError("IMMUTABLE_OBJECT_NOT_FOUND", "지정한 원본 문서 버전을 찾을 수 없습니다.", 404);
    }
    return { ...object, bytes: Uint8Array.from(object.bytes) };
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly config: ProviderConfig) {
    const { s3Bucket, s3Region, s3Endpoint, s3AccessKeyId, s3SecretAccessKey } = config;
    if (!s3Bucket || !s3Region) throw new DomainError("S3_NOT_CONFIGURED", "S3_BUCKET과 S3_REGION이 필요합니다.", 503);
    this.client = new S3Client({
      region: s3Region,
      forcePathStyle: Boolean(s3Endpoint),
      ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
      ...(s3AccessKeyId && s3SecretAccessKey ? { credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey } } : {}),
    });
  }

  async checkReadiness(): Promise<StorageReadiness> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.s3Bucket! }));
    } catch {
      return { ok: false, mode: "s3", reachable: false, versioning: "Unknown", code: "S3_BUCKET_UNREACHABLE" };
    }
    try {
      const result = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.s3Bucket! }));
      const versioning = result.Status ?? "Disabled";
      const ok = this.config.appMode !== "production" || versioning === "Enabled";
      return { ok, mode: "s3", reachable: true, versioning,
        ...(!ok ? { code: "S3_VERSIONING_NOT_ENABLED" } : {}) };
    } catch {
      return { ok: false, mode: "s3", reachable: true, versioning: "Unknown", code: "S3_VERSIONING_UNAVAILABLE" };
    }
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

  async putImmutableObject(input: ImmutableObjectWrite): Promise<ImmutableObjectMetadata> {
    assertImmutableWrite(input);
    const contentHashSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const encryption = this.config.appMode === "production"
      ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: this.config.s3KmsKeyId }
      : this.config.s3Endpoint ? {} : { ServerSideEncryption: "AES256" as const };
    try {
      const stored = await this.client.send(new PutObjectCommand({
        Bucket: this.config.s3Bucket!,
        Key: input.objectKey,
        Body: input.bytes,
        ContentType: input.mimeType,
        ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
        IfNoneMatch: "*",
        Metadata: { ...input.metadata, contentsha256: contentHashSha256, filename: encodeURIComponent(input.fileName) },
        ...encryption,
      }));
      if (!stored.VersionId) throw new DomainError("S3_VERSIONING_REQUIRED", "원본 문서 보관에는 S3 버전 관리가 필요합니다.", 503);
      return {
        objectKey: input.objectKey,
        objectVersionId: stored.VersionId,
        etag: (stored.ETag ?? "").replaceAll('"', ""),
        contentHashSha256,
        mimeType: input.mimeType,
        fileName: input.fileName,
        sizeBytes: input.bytes.byteLength,
      };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const existing = await this.headImmutableObject(input.objectKey);
      if (existing.contentHashSha256 !== contentHashSha256 || existing.mimeType !== input.mimeType
        || existing.fileName !== input.fileName || existing.sizeBytes !== input.bytes.byteLength) {
        throw new DomainError("IMMUTABLE_OBJECT_CONFLICT", "같은 원본 문서 키를 다른 내용으로 덮어쓸 수 없습니다.", 409);
      }
      return existing;
    }
  }

  async getImmutableObject(objectKey: string, objectVersionId: string): Promise<ImmutableObject> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey, VersionId: objectVersionId }));
    const bytes = new Uint8Array(await object.Body!.transformToByteArray());
    const contentHashSha256 = createHash("sha256").update(bytes).digest("hex");
    if (object.Metadata?.contentsha256 !== contentHashSha256) {
      throw new DomainError("IMMUTABLE_OBJECT_HASH_MISMATCH", "보관된 원본 문서의 해시가 메타데이터와 일치하지 않습니다.", 502);
    }
    return {
      objectKey,
      objectVersionId,
      etag: (object.ETag ?? "").replaceAll('"', ""),
      contentHashSha256,
      mimeType: object.ContentType ?? "application/octet-stream",
      fileName: decodeURIComponent(object.Metadata?.filename ?? "document.bin"),
      sizeBytes: bytes.byteLength,
      bytes,
    };
  }

  private async headImmutableObject(objectKey: string): Promise<ImmutableObjectMetadata> {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket!, Key: objectKey }));
    if (!head.VersionId) throw new DomainError("S3_VERSIONING_REQUIRED", "원본 문서 보관에는 S3 버전 관리가 필요합니다.", 503);
    return {
      objectKey,
      objectVersionId: head.VersionId,
      etag: (head.ETag ?? "").replaceAll('"', ""),
      contentHashSha256: head.Metadata?.contentsha256 ?? "",
      mimeType: head.ContentType ?? "application/octet-stream",
      fileName: decodeURIComponent(head.Metadata?.filename ?? "document.bin"),
      sizeBytes: head.ContentLength ?? 0,
    };
  }
}

function assertImmutableWrite(input: ImmutableObjectWrite): void {
  if (!input.objectKey.startsWith("original-documents/") || input.objectKey.includes("..")) {
    throw new DomainError("INVALID_IMMUTABLE_OBJECT_KEY", "원본 문서 저장 키가 허용된 경로가 아닙니다.", 400);
  }
  if (input.bytes.byteLength <= 0) throw new DomainError("EMPTY_IMMUTABLE_OBJECT", "빈 원본 문서는 저장할 수 없습니다.", 400);
  if (!input.mimeType.trim() || !input.fileName.trim()) throw new DomainError("INVALID_IMMUTABLE_OBJECT_METADATA", "원본 문서 형식과 파일명이 필요합니다.", 400);
}

function immutableMetadata(object: ImmutableObject): ImmutableObjectMetadata {
  const { bytes: _bytes, ...metadata } = object;
  return metadata;
}

function isPreconditionFailure(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
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
