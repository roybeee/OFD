import type { BootstrapData } from '../types';
import { grossToVatParts } from '../lib/workflows';

const invoiceA = grossToVatParts(2_841_900);
const invoiceB = grossToVatParts(1_276_000);
const invoiceC = grossToVatParts(892_600);

export const demoData: BootstrapData = {
  actor: { id: 'master-1', name: '김운영', role: 'master' },
  store: {
    id: 'store-doksan',
    name: '독산점',
    businessName: '올드페리도넛 독산점',
    billingPolicy: '월 합산',
    paymentTerm: '월 외상 · 익월 7일',
  },
  products: [
    { id: 'p1', name: '버터피스타치오', unit: '1박스 · 12개', grossPrice: 68_400, category: '도넛', recommended: true, note: '최근 4주 판매 1위' },
    { id: 'p2', name: '크림브륄레', unit: '1박스 · 12개', grossPrice: 64_800, category: '도넛', recommended: true, note: '주말 소진 빠름' },
    { id: 'p3', name: '보스턴크림', unit: '1박스 · 12개', grossPrice: 61_200, category: '도넛', recommended: true },
    { id: 'p4', name: '피넛버터', unit: '1박스 · 12개', grossPrice: 62_400, category: '도넛' },
    { id: 'p5', name: '시나몬 슈가', unit: '1박스 · 12개', grossPrice: 54_000, category: '도넛' },
    { id: 'p6', name: '컵 12oz', unit: '1박스 · 500개', grossPrice: 46_000, category: '부자재' },
  ],
  orders: [
    {
      id: 'o1', code: 'PO-260802-014', storeName: '독산점', ownerName: '박도현', createdAt: '2026-08-02T10:24:00+09:00', deliveryDate: '2026-08-04T10:00:00+09:00', itemCount: 7, grossAmount: 486_000, status: 'submitted', paymentTerm: 'monthly_credit', risk: 'price_changed', version: 3,
      storeId: 'store-doksan', storeAddress: '서울 금천구 시흥대로 315, 1층', source: 'native',
      lines: [{ id: 'l1', productId: 'p1', name: '버터피스타치오', unit: '1박스 · 12개', quantity: 2, unitGross: 68_400, gross: 136_800 }, { id: 'l2', productId: 'p2', name: '크림브륄레', unit: '1박스 · 12개', quantity: 1, unitGross: 64_800, gross: 64_800 }, { id: 'l3', productId: 'p3', name: '보스턴크림 외 4종', unit: '박스', quantity: 4, unitGross: 71_100, gross: 284_400 }],
      timeline: [
        { label: '발주 제출', at: '오늘 10:24', done: true },
        { label: '본사 승인', active: true },
        { label: '배송 시작' },
        { label: '입고 완료' },
      ],
    },
    {
      id: 'o2', code: 'PO-260802-011', storeName: '한남점', ownerName: '이수진', createdAt: '2026-08-02T09:42:00+09:00', deliveryDate: '2026-08-03T13:00:00+09:00', itemCount: 12, grossAmount: 728_400, status: 'submitted', paymentTerm: 'prepaid', risk: 'new_store', version: 1,
      storeId: 'store-hannam', storeAddress: '서울 용산구 이태원로 223, 1층', source: 'native',
      lines: [{ id: 'l4', productId: 'p1', name: '버터피스타치오', unit: '1박스 · 12개', quantity: 4, unitGross: 68_400, gross: 273_600 }, { id: 'l5', productId: 'p2', name: '크림브륄레 외 7종', unit: '박스', quantity: 8, unitGross: 56_850, gross: 454_800 }],
      timeline: [{ label: '발주 제출', done: true }, { label: '본사 승인', active: true }, { label: '배송 시작' }, { label: '입고 완료' }],
    },
    {
      id: 'o3', code: 'PO-260801-038', storeName: '성수점', ownerName: '최현정', createdAt: '2026-08-01T16:12:00+09:00', deliveryDate: '2026-08-03T11:00:00+09:00', itemCount: 9, grossAmount: 642_000, status: 'approved', paymentTerm: 'monthly_credit', version: 4,
      storeId: 'store-seongsu', storeAddress: '서울 성동구 연무장길 41, 1층', source: 'native',
      timeline: [{ label: '발주 제출', done: true }, { label: '본사 승인', at: '어제 17:02', done: true }, { label: '배송 준비', active: true }, { label: '입고 완료' }],
    },
    {
      id: 'o4', code: 'PO-260731-026', storeName: '독산점', ownerName: '박도현', createdAt: '2026-07-31T14:30:00+09:00', deliveryDate: '2026-08-02T11:00:00+09:00', itemCount: 8, grossAmount: 518_400, status: 'out_for_delivery', paymentTerm: 'monthly_credit', version: 5,
      storeId: 'store-doksan', storeAddress: '서울 금천구 시흥대로 315, 1층', source: 'native',
      timeline: [{ label: '발주 제출', done: true }, { label: '본사 승인', done: true }, { label: '배송 시작', at: '오늘 09:18', done: true }, { label: '입고 완료', active: true }],
    },
  ],
  deliveries: [
    { id: 'd1', orderId: 'o4', driverId: 'driver-1', version: 2, plannedDate: '2026-08-02', sequence: 1, storeName: '독산점', address: '서울 금천구 시흥대로 315, 1층', phone: '02-867-2026', window: '10:30–11:00', itemCount: 8, status: 'driving', notes: '후문 주차 후 매장에 전화', recipientName: '박도현', lines: [{ name: '도넛 제품', unit: '박스', quantity: 7 }, { name: '컵 12oz', unit: '박스', quantity: 1 }] },
    { id: 'd2', driverId: 'driver-1', version: 1, plannedDate: '2026-08-02', sequence: 2, storeName: '영등포점', address: '서울 영등포구 영중로 15, B1', phone: '02-2638-2026', window: '11:30–12:00', itemCount: 5, status: 'ready', notes: '백화점 하역장 이용', recipientName: '장민지' },
    { id: 'd3', driverId: 'driver-1', version: 1, plannedDate: '2026-08-02', sequence: 3, storeName: '한남점', address: '서울 용산구 이태원로 223, 1층', phone: '02-794-2026', window: '13:10–13:40', itemCount: 12, status: 'ready', recipientName: '이수진' },
    { id: 'd4', driverId: 'driver-1', version: 1, plannedDate: '2026-08-02', sequence: 4, storeName: '성수점', address: '서울 성동구 연무장길 41, 1층', phone: '02-466-2026', window: '14:20–14:50', itemCount: 9, status: 'ready', recipientName: '최현정' },
  ],
  bankMatches: [
    { id: 'b1', depositor: '올드페리독산', amount: 1_286_400, transferredAt: '오늘 09:41', storeName: '독산점', status: 'auto_matched' },
    { id: 'b2', depositor: '김민수', amount: 728_400, transferredAt: '오늘 09:14', status: 'manual_review', candidates: 2 },
    { id: 'b3', depositor: 'OFD한남', amount: 486_000, transferredAt: '어제 18:22', status: 'manual_review', candidates: 0 },
    { id: 'b4', depositor: '성수점', amount: 2_140_800, transferredAt: '7월 31일', storeName: '성수점', status: 'overdue' },
  ],
  invoices: [
    { id: 'i1', storeName: '독산점', period: '2026년 7월', ...invoiceA, grossAmount: invoiceA.gross, supplyAmount: invoiceA.supply, vatAmount: invoiceA.vat, status: 'reviewed', preparedBy: '이재무', preparedById: 'finance-1', dueDate: '8월 7일', version: 2, issueDate: '2026-07-31', supplierName: '주식회사 올드페리도넛', supplierBusinessNumber: '000-00-00000', recipientName: '올드페리도넛 독산점', recipientBusinessNumber: '123-45-67890' },
    { id: 'i2', storeName: '한남점', period: '2026년 7월', ...invoiceB, grossAmount: invoiceB.gross, supplyAmount: invoiceB.supply, vatAmount: invoiceB.vat, status: 'draft', preparedBy: '이재무', preparedById: 'finance-1', dueDate: '8월 7일' },
    { id: 'i3', storeName: '본점 직영', period: '2026년 7월', ...invoiceC, grossAmount: invoiceC.gross, supplyAmount: invoiceC.supply, vatAmount: invoiceC.vat, status: 'internal_statement', preparedBy: '이재무', preparedById: 'finance-1', dueDate: '해당 없음', sameBusinessNumber: true },
    { id: 'i4', storeName: '성수점', period: '2026년 7월', ...grossToVatParts(3_412_200), grossAmount: 3_412_200, supplyAmount: 3_102_000, vatAmount: 310_200, status: 'nts_success', preparedBy: '이재무', preparedById: 'finance-1', dueDate: '완료' },
  ],
  documents: [
    { id: 'doc1', type: 'monthly_statement', title: '7월 월 정산서', period: '2026.07.01–07.31', amount: 2_841_900, status: 'issued' },
    { id: 'doc2', type: 'tax_invoice', title: '7월 전자세금계산서', period: '발급 예정 8월 7일', amount: 2_841_900, status: 'scheduled' },
    { id: 'doc3', type: 'payment_request', title: '7월 결제 요청', period: '납부기한 8월 7일', amount: 2_841_900, status: 'pending' },
    { id: 'doc4', type: 'delivery_statement', title: '7월 31일 거래명세서', period: '입고 완료 · 사진 확인', amount: 518_400, status: 'issued' },
  ],
  generatedAt: '2026-08-02T14:40:00+09:00',
  capabilities: ['store.orders.read', 'store.orders.create', 'store.orders.submit', 'store.documents.read', 'hq.orders.read', 'hq.orders.approve', 'hq.orders.change_request', 'hq.shipments.manage', 'hq.shipments.dispatch', 'hq.payments.reconcile', 'hq.invoices.read', 'hq.invoices.approve', 'driver.deliveries.read', 'driver.deliveries.complete'],
  allowedDeliveryDates: ['2026-08-04', '2026-08-05', '2026-08-06'],
  meta: { apiVersion: 'v2', appMode: 'demo', providerMode: 'mock', externalIssueEnabled: false },
};
