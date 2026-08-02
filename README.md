# OFD 프랜차이즈 워크스테이션

올드페리도넛(OFD) 가맹 사업 운영을 위한 통합 워크스테이션.
가맹 영업 파이프라인(가맹사업법 제7조③ 숙려기간 서버 강제) · 발주 · 매출 마감 · 토스플레이스 POS 자동 수집 · 매장별 매출 분석 · 정산 · 부서별 계정(RBAC) · 감사 로그.

## 구성

| 경로 | 내용 |
|---|---|
| `apps/web/` | **V2 PWA** — 점주·본사·배송기사 역할별 React 화면 |
| `apps/api/` | **V2 API** — Fastify 인증·권한·업무 상태 전이·멱등 mutation |
| `apps/worker/` | **V2 worker** — outbox, Popbill, 계좌 수집, 알림, 월마감 |
| `packages/` | 금액·VAT·상태 전이, PostgreSQL 저장소, 외부 연동 adapter |
| `infra/` | PostgreSQL/MinIO 로컬 구성, 컨테이너, 운영 사전검사·복구 스크립트 |
| `server/` | **서버판 v3** — 의존성 0개 Node.js 백엔드 + SPA. 인증·권한·숙려기간·감사를 서버가 강제 |
| `pilot/` | 아티팩트 파일럿판(단일 HTML) — 서버 없이 브라우저 공유 저장소로 동작하는 초기 검증용 |

V2의 업무·보안 계약은 [`spec.md`](spec.md), 배포 절차는
[`docs/deployment-v2.md`](docs/deployment-v2.md), 파일럿 전환 조건은
[`docs/migration-pilot-runbook.md`](docs/migration-pilot-runbook.md)를 기준으로 합니다.

## V2 빠른 시작

Node.js 22와 Docker가 필요합니다.

```bash
cp .env.example .env
npm ci
npm run infra:up
set -a && . ./.env && set +a
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:4100/api/v2/health`
- 명시적 화면 시연: URL 끝에 `?demo=1` 추가

운영에서는 데모 자동 대체가 금지됩니다. `npm run preflight`가 PostgreSQL, HTTPS,
세션·암호화 키, private S3/KMS, SMTP, Popbill 기능별 승인 조건을 fail-closed로 검사합니다.

## 빠른 시작 (Windows)

1. [Node.js LTS](https://nodejs.org) 설치 (최초 1회)
2. `server/실행하기.bat` 더블클릭 → 브라우저가 `http://localhost:8787` 로 열림
3. 초기 설정에서 마스터 계정 생성

배포(HTTPS·systemd·Docker)·토스플레이스 연동·계정 권한 매트릭스는 [`server/README.md`](server/README.md) 참고.

## 검증

```bash
node --test packages/domain/src/*.test.ts infra/scripts/*.test.mjs # 의존성 없는 핵심 계약
npm run test:ci                                                   # V2 typecheck·test·build
npm run e2e                                                       # 3개 역할 화면·접근성·workflow
cd server && node --no-warnings test/integration.js   # 통합 테스트 95건
```
