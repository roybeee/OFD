import { describe, expect, it } from 'vitest';
import { canApproveInvoice, canCompleteDelivery, grossToVatParts, validateDeliveryPhoto } from './workflows';

describe('financial and operational invariants', () => {
  it('splits VAT-inclusive amounts without losing a won', () => {
    expect(grossToVatParts(13_431_700)).toEqual({ supply: 12_210_636, vat: 1_221_064, gross: 13_431_700 });
  });

  it('enforces maker-checker separation', () => {
    expect(canApproveInvoice({ preparedBy: 'admin-1', actorId: 'admin-1', actorRole: 'master' })).toBe(false);
    expect(canApproveInvoice({ preparedBy: 'admin-1', actorId: 'master-1', actorRole: 'master' })).toBe(true);
    expect(canApproveInvoice({ preparedBy: 'admin-1', actorId: 'staff-1', actorRole: 'finance' })).toBe(false);
  });

  it('requires a delivery photo before completion', () => {
    expect(canCompleteDelivery({ photoName: '', recipientName: '김점주' })).toBe(false);
    expect(canCompleteDelivery({ photoName: 'delivery.jpg', recipientName: '김점주' })).toBe(true);
  });

  it('accepts only non-empty JPG, PNG, or WEBP photos up to 10MB', () => {
    expect(validateDeliveryPhoto(new File(['ok'], 'proof.jpg', { type: 'image/jpeg' }))).toBeNull();
    expect(validateDeliveryPhoto(new File(['bad'], 'proof.pdf', { type: 'application/pdf' }))).toBe('JPG, PNG, WEBP 사진만 올릴 수 있어요');
    expect(validateDeliveryPhoto(new File([], 'empty.png', { type: 'image/png' }))).toBe('빈 사진 파일은 올릴 수 없어요');
    expect(validateDeliveryPhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.webp', { type: 'image/webp' }))).toBe('사진은 10MB 이하만 올릴 수 있어요');
  });
});
