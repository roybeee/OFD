# 기존 시스템 이관·2개 매장 파일럿 런북

V2는 대표 매장 2곳에서 30일 동안 기존 시스템과 병행한다. 병행은 결과 대사를 위한
것이지 같은 거래를 두 시스템에서 외부 발행한다는 뜻이 아니다. 매장·정산기간별
세금계산서 발행 시스템은 언제나 하나만 권위(authoritative)를 가진다.

## 1. 역할

- 파일럿 책임자: 진행/중단 결정, 일일 대사 확인
- 운영 담당: 주문 승인과 배송 예외 처리
- 재무 담당: 입금/정산 초안과 계산서 검토
- 마스터: 서로 다른 사용자로 계산서 승인, 외부 발행 허용
- 기사: 개인 계정으로 배송사진/완료 처리
- 감사/QA: 타매장 접근, 중복, 복구, 금액 결과 독립 검증

## 2. 파일럿 매장 선정

서로 다른 주문 패턴의 2개 매장을 고른다.

- 매장 A: 월 합산 + 월 외상, 평균 이상의 SKU/주문량
- 매장 B: 배송 건별 + 선결제, 모바일 사용 비중이 높은 매장

두 매장의 동의, 사업자정보, 청구/결제 정책, 담당자 개인계정, 기사 경로를 확인한다.

## 3. 이관 규칙

1. 기준정보를 먼저 이관하고 business number, store scope, 가격 유효기간을 검증한다.
2. 기존 주문은 원문 hash와 legacy ID를 가진 `legacy_unverified` read-only snapshot으로
   이관한다.
3. legacy 주문은 자동 정산·세금계산서·외부발행 대상에서 제외한다.
4. V2 파일럿 시작시각 이후 새 주문만 V2 state machine을 사용한다.
5. 금액은 정수 원화로 다시 계산하되 원본과 차이가 있으면 자동 보정하지 않고 예외
   리포트로 보낸다.
6. 마이그레이션은 동일 legacy ID/hash 재실행 시 중복 생성되지 않아야 한다.

## 4. 일정

### 준비 2주

- 운영 자격증명 없이 mock provider로 전체 흐름 리허설
- 계정/MFA/역할/매장 범위, 360px UI, 배송사진 권한 검증
- 백업과 격리 복구 훈련
- 기준정보·legacy dry-run 2회, 수량/금액/hash 대사
- 운영팀과 점주 교육, 전화/수동 비상절차 확인

### 30일 병행

- 1~7일: V2로 신규 입력하되 외부 세무 발행은 기존 권위 시스템만 사용하고 shadow
  정산 결과를 매일 대사한다.
- 8~21일: 모든 업무 흐름을 V2에서 수행한다. 외부 발행 활성화가 승인되면 선택한
  정산기간부터 V2만 권위 시스템이 된다.
- 22~30일: 월마감, maker-checker, Popbill 상태/NTS 결과, 복구·재시도 시나리오를
  검증한다.
- 매일: 주문/배송/수취 건수, 금액, outbox, dead-letter, 권한오류, 지원요청을 기록한다.

월 경계에서 권위 시스템을 바꾼다. 한 정산기간 중간에 발행 권위를 이동하지 않는다.

## 5. 자동 GO/NO_GO 판정

운영 리포트를 아래 JSON 필드로 확정한 뒤 실행한다.

```json
{
  "pilotStores": 2,
  "parallelDays": 30,
  "ledgerReconciliationRate": 1,
  "taxAmountDifferenceWon": 0,
  "duplicateExternalIssues": 0,
  "pendingOutbox": 0,
  "deadLetters": 0,
  "authorizationTestsPassed": true,
  "restoreDrillPassed": true,
  "mobileTaskSuccessRate": 0.97,
  "approvalSlaRate": 0.96,
  "unresolvedSeverity1": 0
}
```

```bash
node infra/scripts/evaluate-pilot-gates.mjs pilot-metrics.json
```

모든 기준을 만족해야 `GO`다. 수동으로 실패 기준을 면제하지 않는다. 추가 관찰기간 후
새 리포트로 다시 판정한다.

## 6. 즉시 중단 조건

- 외부 세금계산서 중복 또는 중복 위험 1건
- 공급가액/VAT 대사 차이 1원 이상
- 타매장 데이터 접근 또는 승인자 분리 위반
- 배송사진 없이 완료, 수취 중복 생성, 원장 훼손
- 백업 복구 실패 또는 감사 추적 불가
- 처리되지 않은 severity-1 사고

## 7. 중단·롤백 절차

1. V2의 신규 제출과 외부 provider outbox 소비를 즉시 중지한다.
2. 현재 처리 중 이벤트와 마지막 성공 provider 관리키를 스냅샷으로 보존한다.
3. 파일럿 매장에 기존 시스템 사용 재개시각과 수동 주문 채널을 공지한다.
4. 미발행 정산은 기존 권위 시스템으로 재입력하고 2인이 총액/기간/대상을 검증한다.
5. 이미 발행된 세금계산서는 롤백/삭제하지 않고 법정 수정세금계산서로 정정한다.
6. V2 DB와 object는 사고조사를 위해 read-only 보존한다.
7. 원인, 영향 거래, 복구 결과, 재개 승인 조건을 기록한다.

전체 전환 후에도 기존 시스템은 합의한 보존기간 동안 read-only로 유지하고, 신규 쓰기는
feature flag와 접근제어로 막는다.

실제 운영 전환의 승인 시점, GitHub/Render 배포 순서, 전환 후 검증과 복귀 판단은
`docs/production-cutover-runbook.md`를 따른다. 현재 V2 코어는 매장 ID 목록 환경변수로
쓰기를 동결하지 않는다. `CUTOVER_STORE_IDS` 또는 `WRITE_FREEZE_STORE_IDS`를 설정하는
것은 안전장치가 아니며 배포 preflight가 이를 거부한다.
