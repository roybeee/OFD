# ODA 워크스테이션 · 월 손익·정산

OFD 기반 ODA 1차 개발 브랜치입니다. 계약 기반 월 손익, 증빙 업로드, 이익배분, 정산 확정과 지급 기록을 추가했습니다. 후속 개발로 최초 등록 화면, 로컬 영구 저장 실행 구성, 엑셀 정산서 출력을 포함합니다.

- Mac 로컬 실행: Docker Desktop 준비 후 `Start-ODA.command`. [실행·종료·백업 안내](docs/oda-local.md)
- 개발용 실행: `npm ci` 후 `npm run dev:oda` (테스트 전용 메모리 모드)
- 운영 빌드: `npm run build:oda`
- [매장 사용 흐름·계약 적용·배포](docs/oda-phase1.md)
- [OFD·ODA 서버 자원 공용 검토](docs/oda-shared-hosting-review.md)
- ODA 전용 인프라: `render.oda.yaml`
- 기존 PostgreSQL 호스트 공용 배포안: `render.oda.shared.yaml`. [DB·계정 분리와 배포 절차](docs/oda-shared-deployment.md)

빌드·자동 테스트 485개 통과. 실제 PostgreSQL 연결 테스트 2개는 DB 부재로 미실행했습니다. Docker 컨테이너·실제 브라우저 최종 검증과 온라인 배포는 완료하지 않았습니다. 이 저장소를 배포 완료된 서비스로 표현하지 않습니다.

---

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
