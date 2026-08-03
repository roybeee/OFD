# OFD V2 real E2E

이 테스트는 legacy `server/`, SQLite, `build:render`, `server/public/v2`를 사용하지 않는다.
실행 스택은 다음 네 프로세스다.

- Vite Web `http://127.0.0.1:5173`
- Fastify API `http://127.0.0.1:4100`
- 별도 Worker
- 격리된 PostgreSQL 16

`seed-postgres.mjs`는 `E2E_ALLOW_RESET=1`이고 데이터베이스 이름에 독립된 `e2e` 또는
`test` 구간이 있을 때만 초기화한다. migration checksum을 먼저 확인하고 고정 ID의
점주·본사·기사 계정과 상품·매장을 PostgreSQL repository에 넣는다.

## 검증 여정

1. 점주 UI 로그인, 발주 wizard 생성·제출
2. HQ 운영 MFA 로그인, 승인·기사 배차·당일 출발
3. 기사 UI 로그인, 실제 이미지 업로드·수취인 입력·배송 완료
4. 재무 MFA 로그인, 정산/결제 요청·격리 은행 거래 주입·자동 대사·검토
5. 별도 마스터 MFA 로그인, 정산 승인
6. 재무 계산서 초안·검토, 별도 마스터 승인
7. Worker mock 발행, Popbill webhook, 국세청 성공·정산 잠금·원본 문서 생성
8. 점주 문서 화면과 15분 signed-download contract
9. 점주/기사/운영/재무/마스터 역할 경계, 모바일 overflow, WCAG A/AA serious/critical

도메인은 새 발주의 희망 배송일을 다음 영업일부터 허용하지만 기사 완료는 당일만 허용한다.
한 테스트에서 전체 흐름을 검증하기 위해 격리 DB에서 방금 만든 주문의 희망 배송일만
서울 운영일 오늘로 바꾸는 test-clock bridge를 사용한다. 이 조작은 운영 주소와 운영 DB에서
실행할 수 없으며 E2E guard가 차단한다.

## 로컬 실행

이 suite는 PostgreSQL-only다. Docker가 없거나 PostgreSQL이 없으면 memory fallback으로
통과시키지 않는다. PostgreSQL 16을 준비한 뒤 아래처럼 실행한다.

```powershell
$env:DATABASE_URL='postgresql://ofd:ofd-e2e-isolated@127.0.0.1:5432/ofd_v2_e2e'
$env:E2E_ALLOW_RESET='1'
npm run build:packages
npm run e2e
```

테스트 discovery/TypeScript 변환만 확인하려면 DB 없이 다음 명령을 사용한다.

```powershell
npx playwright test -c e2e/playwright.config.ts --list
```

외부 실행은 HTTPS QA hostname과 `E2E_ALLOW_WRITES=qa`가 모두 필요하다. 알려진 운영
hostname과 `qa`/`staging`/`test` 표시가 없는 주소는 설정과 관계없이 거부된다.
