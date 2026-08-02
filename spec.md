# OFD Workstation V2 — 발주부터 세금계산서까지 원프로세스

상태: 구현 승인됨  
작성일: 2026-08-02  
배포 전략: 기존 서버와 병렬 운영 후 단계적 전환

## 1. 목표

점주 발주, 본사 승인, 자가배송, 배송 증빙, 수취 확정, 입금 대사, 월 정산,
전자세금계산서 발행을 하나의 추적 가능한 업무 흐름으로 제공한다. 모든 재무
결과는 당시 기준정보의 변경과 무관하게 재현 가능해야 하며, 외부 사업자 장애나
재시도 때문에 중복 발행되어서는 안 된다.

## 2. 확정된 운영 정책

- 공급자는 본사 단일 법인, 공급받는자는 각 매장 사업자다.
- 동일 사업자번호의 직영점 거래는 내부거래 명세서를 만들고 세금계산서는 막는다.
- 현재 공급가는 부가가치세 포함 금액이며 모든 품목은 과세 10%다.
- 매장별 청구 정책은 `월 합산`을 기본값으로 하며 `배송 건별`도 선택할 수 있다.
- 매장별 결제 조건은 `선결제` 또는 `월 외상`이다.
- 모든 주문은 본사 운영 담당자가 수동 승인한다.
- 재고, 로트, 유통기한 관리는 V2 범위에 포함하지 않는다.
- 본사가 직접 배송하며 기사 개인 계정과 모바일 PWA를 사용한다.
- 배송 사진은 필수다. 사진 저장 성공 시 배송완료와 정상 수취를 한 트랜잭션으로
  확정한다. 이후 문제는 반품·차감·수정세금계산서 흐름으로만 처리한다.
- 알림 채널은 앱, 이메일, Popbill SMS다.
- 점주는 개인 계정을 사용한다. 기존 매장 공용코드는 초대·최초 등록에만 사용한다.
- 재무 담당자가 정산/계산서를 작성·검토하고 서로 다른 마스터 사용자가 최종 승인·
  발행한다.
- 기존 주문은 `legacy_unverified`로 이관하며 자동 세금계산서 대상에서 제외한다.
- Popbill 세금계산서·계좌거래·SMS만 사용한다. 운영 자격증명, 공급자 인증서,
  계좌조회 승인이 모두 확인되기 전에는 외부 발행을 강제로 차단한다.
- 대표 매장 2곳에서 1개월 병행 운영한 뒤 전환 조건을 충족할 때만 전체 전환한다.

## 3. 기술 경계

- Web: React, Vite, TypeScript, 반응형 PWA
- API: Fastify, TypeScript, `/api/v2`
- DB: PostgreSQL, 버전 있는 SQL migration
- Worker: API 프로세스와 분리된 영속 outbox 소비자
- File: AWS S3 호환 객체 저장소, 로컬 개발은 MinIO
- Integration: provider interface 뒤의 mock/Popbill/email/S3 adapter
- Legacy: 기존 `server/`는 파일럿 기간 동안 변경하지 않고 읽기 전용 호환 대상으로 둔다.

## 4. 사용자와 권한

| 역할 | 허용 업무 |
| --- | --- |
| `store_owner`, `store_staff` | 자기 매장 발주, 진행 조회, 문서/청구 조회 |
| `hq_ops` | 주문 수취, 변경요청, 승인/반려, 배송 배정 |
| `driver` | 자기에게 배정된 배송 조회, 필수 사진 업로드, 배송완료 |
| `finance` | 계좌 대사, 정산 생성·검토, 계산서 초안·검토 |
| `master` | 정책 관리, 다른 사용자가 검토한 계산서 승인·발행 |
| `auditor` | 모든 원장과 감사 이벤트 읽기 전용 |

서버는 매 요청에서 개인 사용자, 역할, 매장 범위를 검증한다. 재무·마스터의 고위험
행위는 MFA 또는 최근 step-up 인증이 필요하다. 작성자와 최종 승인자는 같을 수 없다.

## 5. 상태 모델

### 주문

`draft → submitted → approved | change_requested | rejected | cancelled`

- `change_requested`는 점주 수락 후 다시 `submitted`가 된다.
- 제출 이후 삭제하지 않으며 모든 전이는 `order_events`에 남긴다.
- 승인 시 품목명, 단위, 수량, VAT 포함 단가, 공급가액, 세액을 동결한다.

### 배송과 수취

`preparing → out_for_delivery → delivered`

- 배송 사진의 객체 저장 성공 전에는 `delivered`가 될 수 없다.
- 사진 저장과 동시에 정상 `goods_receipt`를 생성한다.
- 이후 부족·파손·오배송은 원본 수취를 수정하지 않고 `return` 또는 조정 문서로 기록한다.

### 입금

`pending → matching → paid | manual_review | reversed`

- 계좌 거래가 금액, 입금자 참조, 허용 시간창에서 단 하나의 청구와 일치할 때만 자동
  확정한다.
- 0개 또는 2개 이상 후보는 재무 큐로 보내고 자동 배분하지 않는다.

### 정산

`open → draft → reviewed → approved → locked`

- 월 합산 초안은 매월 1일 생성한다.
- 재무 검토 목표는 5일, 마스터 승인 목표는 7일이다.
- 잠긴 정산은 수정하지 않고 다음 월 조정 또는 수정 문서로 상쇄한다.

### 세금계산서

`draft → reviewed → approved → queued → issued → nts_pending → nts_success | failed`

- 승인과 외부 발행은 별도 단계다.
- 발행 요청은 DB transaction outbox에 기록하고 worker가 처리한다.
- 내부 invoice UUID로 결정적인 공급자 관리키를 만들며 재시도 때 같은 키를 사용한다.
- 타임아웃이면 재발행 전에 관리키로 상태를 조회한다.
- 국세청 전송 성공 후 원본을 바꾸지 않고 법정 사유의 수정세금계산서만 만든다.

## 6. 금액 규칙

- 모든 금액은 정수 원화(`bigint`)다. 부동소수점 금액 계산을 금지한다.
- 문서 총액이 VAT 포함 `gross`이면 `supply = round(gross × 100 / 110)`,
  `vat = gross - supply`로 계산한다.
- 라인별 잠정 공급가액을 계산한 뒤 문서 공급가액과의 원 단위 차이를 안정적인 라인
  순서에 따라 배분한다. 동일 입력은 항상 동일 결과를 낸다.
- `gross = supply + vat`, 라인 합계 = 문서 합계 제약을 항상 만족한다.
- 주문 승인 뒤 가격표를 바꿔도 과거 주문·정산·계산서 금액은 변하지 않는다.
- Popbill 상세 99개 제한을 넘으면 SKU별 합산 후에도 초과하는 경우 결정적으로 여러
  문서로 분할한다.

## 7. 핵심 데이터

- 기준정보: `legal_entities`, `business_profiles`, `stores`, `store_memberships`,
  `products`, `supply_price_versions`, `billing_policies`, `payment_terms`
- 주문: `purchase_orders`, `purchase_order_lines`, `order_events`
- 배송: `shipments`, `shipment_lines`, `delivery_proofs`, `goods_receipts`, `returns`
- 입금: `payment_requests`, `bank_transactions`, `payment_allocations`
- 정산: `settlements`, `settlement_lines`
- 세무: `tax_invoices`, `tax_invoice_lines`, `tax_invoice_events`
- 공통: `documents`, `notifications`, `audit_ledger`, `outbox_events`, `webhook_inbox`,
  `idempotency_records`, `schema_migrations`

사업자정보와 문서 라인은 유효시점 스냅샷을 보관한다. 감사원장은 append-only이며
일반 애플리케이션 경로에서 update/delete할 수 없다.

## 8. API 계약

- 최초 화면: `GET /api/v2/bootstrap`
- 모든 목록: cursor pagination, 명시적인 role/store scope
- 모든 mutation: `Idempotency-Key` 헤더 필수, body의 `expectedVersion` 필수
- 오래된 버전: `409 VERSION_CONFLICT`와 현재 리소스 요약 반환
- 같은 멱등성 키·같은 payload: 최초 결과 재반환
- 같은 멱등성 키·다른 payload: `409 IDEMPOTENCY_CONFLICT`
- 오류 형식: `{ error: { code, message, fieldErrors?, requestId } }`
- 민감 로그에는 계좌번호, 인증키, 전체 사업자 개인정보를 남기지 않는다.

필수 API군:

- 인증/사용자/역할/매장 범위
- 주문 생성·수정·제출·변경수락·승인·반려·취소
- 배송 생성·배정·출발·사진 업로드·완료
- 계좌거래 수집·자동대사·수동대사·역분개
- 정산 초안·검토·승인·잠금
- 세금계산서 초안·검토·승인·발행요청·상태·수정발행
- 문서·알림·감사 이벤트
- Popbill webhook: API key/MID 검증, inbox 중복 제거

## 9. 화면 구조

### 점주

- `발주·입고`: 지금 할 일, 3단계 새 발주, 진행 타임라인, 주문/배송 문서
- `정산·증빙`: 미결제, 월 정산, 거래명세서, 세금계산서

### 본사

- `주문 운영`: 승인대기와 예외 우선 큐, 상세 패널, 수동 승인
- `배송`: 배송일/기사 배정, 진행률, 증빙 상태
- `입금 대사`: 자동 일치, 검토 필요, 연체
- `정산·세금계산서`: 월마감 체크리스트, maker-checker, 발행/국세청 상태

### 기사

- `오늘 배송`: 큰 터치 영역의 경로 카드, 전화/주소, 사진 촬영, 배송완료

모바일 360px에서 가로 스크롤이 없어야 한다. 주요 컨트롤은 최소 44×44px다.
상태는 색상에만 의존하지 않고 텍스트와 아이콘을 함께 쓴다. 키보드 포커스,
`aria-current`, `aria-live`, 오류-필드 연결, reduced-motion을 지원한다.

## 10. 외부 연동과 장애 처리

- 기본 실행은 명시적으로 표시된 mock provider다.
- `PROVIDER_MODE=production`은 Popbill 자격증명, 공급자 인증서 확인, 계좌 승인 플래그,
  운영 허용 스위치가 모두 참일 때만 시작한다.
- outbox는 지수 backoff, 최대 시도, dead-letter와 수동 재처리를 지원한다.
- webhook은 inbox에 원문 hash와 provider event id를 먼저 저장한 뒤 한 번만 적용한다.
- Popbill webhook 누락을 대비해 주기적 조회 대사를 수행한다.
- 이메일/SMS 실패가 재무 원장 트랜잭션을 롤백하지 않으며 알림 실패 큐에 남는다.
- 파일은 private bucket에 저장하고 짧은 만료시간의 서명 URL로만 제공한다.

## 11. 보안·운영

- 비밀번호는 강한 password hash, 세션 쿠키는 Secure/HttpOnly/SameSite다.
- 로그인·발행·webhook·파일 업로드에 속도/크기/유형 제한을 둔다.
- 이미지 MIME signature와 최대 크기를 서버에서 다시 검증한다.
- 운영 비밀은 환경변수/secret manager에만 있고 DB 백업에 포함하지 않는다.
- PostgreSQL PITR과 객체 저장소 versioning을 켜고 정기 복구 훈련을 기록한다.
- request id, actor id, store id, resource version을 구조화 로그와 감사원장에 남긴다.
- 개인정보 및 세무 문서 보존·파기 정책은 운영 전 법무/세무 검토로 확정한다.

## 12. 파일럿과 전환 게이트

대표 매장 2곳을 한 달 병행 운영한다. 아래를 모두 충족해야 전체 전환한다.

- 발주/배송/수취 원장 100% 대사
- 계산서 공급가액·세액 차이 0원
- 중복 외부 발행 0건
- 미처리 outbox/dead-letter 0건
- 역할·타매장 접근 보안 테스트 100% 통과
- 백업 복구 훈련 성공 및 목표 RPO/RTO 확인
- 점주 모바일 핵심 작업 성공률과 운영팀 승인 SLA 기준 충족

불일치, 중복 발행 위험, 복구 실패 중 하나라도 발생하면 신규 V2 입력을 중단하고 기존
시스템을 계속 사용한다. 이미 발행된 세무 문서는 롤백하지 않고 정정 절차를 따른다.

## 13. 수용 기준

- 점주가 360px 화면에서 상품 선택부터 제출까지 3단계 안에 완료한다.
- 본사 승인 없이는 배송 준비로 넘어갈 수 없다.
- 기사 사진이 없으면 배송완료가 거부되고, 성공 시 수취가 정확히 한 번 생성된다.
- 공급가 변경 후에도 기존 주문 금액 테스트가 변하지 않는다.
- 중복 클릭, 재시도, worker 재시작, 중복 webhook에서도 주문/입금/계산서가 중복되지 않는다.
- 단일 계좌거래만 자동대사되고 모호한 거래는 재무 큐에 남는다.
- 재무 작성자와 동일한 사용자는 마스터 권한이 있어도 자기 계산서를 승인할 수 없다.
- 동일 사업자번호 매장은 계산서 발행이 서버에서 거절되고 내부 명세서가 제공된다.
- 자격증명 없는 운영 모드에서는 외부 계산서/SMS/계좌 호출이 fail-closed 된다.
- 단위, 통합, E2E, 접근성, 빌드 검증이 통과한다.
- 데스크톱 HQ, 모바일 점주, 모바일 기사 실제 실행 화면을 사용자에게 병합 전에 보여준다.

## 14. 비기능 목표

- 1,000개 매장, 월 100,000건 주문을 전제로 목록과 worker batch를 설계한다.
- API mutation p95 500ms 이내(외부 연동은 비동기), 목록 p95 800ms 이내를 목표로 한다.
- 외부 발행과 계좌 수집은 API 요청 경로에서 직접 수행하지 않는다.
- 장애 시 재처리 가능한 상태가 DB에 남아야 하며 메모리 큐만 사용하지 않는다.
