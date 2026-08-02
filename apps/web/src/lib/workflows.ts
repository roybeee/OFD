export function grossToVatParts(gross: number) {
  const supply = Math.round((gross * 100) / 110);
  return { supply, vat: gross - supply, gross };
}

export function canApproveInvoice(input: { preparedBy: string; actorId: string; actorRole: string }) {
  return ['master', 'hq_master'].includes(input.actorRole) && input.preparedBy !== input.actorId;
}

export function canCompleteDelivery(input: { photoName: string; recipientName: string }) {
  return input.photoName.trim().length > 0 && input.recipientName.trim().length > 0;
}

export function validateDeliveryPhoto(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'JPG, PNG, WEBP 사진만 올릴 수 있어요';
  if (file.size === 0) return '빈 사진 파일은 올릴 수 없어요';
  if (file.size > 10 * 1024 * 1024) return '사진은 10MB 이하만 올릴 수 있어요';
  return null;
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value) + '원';
}

export function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(value));
}

export function getStatusLabel(status: string) {
  const labels: Record<string, string> = {
    submitted: '승인 대기',
    change_requested: '변경 확인',
    rejected: '반려',
    cancelled: '취소 완료',
    approved: '승인 완료',
    preparing: '상품 준비',
    out_for_delivery: '배송 중',
    delivered: '입고 완료',
    ready: '출발 전',
    driving: '배송 중',
    auto_matched: '자동 일치',
    manual_review: '검토 필요',
    overdue: '연체',
    draft: '초안',
    reviewed: '검토 완료',
    queued: '발행 대기',
    nts_success: '국세청 전송 완료',
    failed: '실패',
    internal_statement: '내부거래 명세',
    issued: '발급 완료',
    scheduled: '발급 예정',
    paid: '입금 완료',
    pending: '미결제',
  };
  return labels[status] ?? status;
}
