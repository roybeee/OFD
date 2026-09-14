# ODA 워크스테이션 · 월 손익·정산

OFD 기반 ODA 월 정산 서비스입니다. 계약 기반 월 손익, 증빙 업로드, 이익배분, 정산 확정·지급 기록, 엑셀 정산서를 제공합니다. 공용 PostgreSQL 호스트에서 OFD와 ODA의 데이터베이스·운영 계정을 분리하며, 온라인 최초 등록 화면에서 실제 매장과 관리자·A·B 계정을 입력합니다.

- 온라인 주소: [ODA 워크스테이션](https://oda-web-wpts.onrender.com). 웹/API 배포와 외부 접속 확인을 완료했습니다. [운영 배포 기록](docs/oda-shared-deployment.md)
- 온라인 첫 설정: Render의 `oda-production-secrets` 그룹에 보관된 `ODA_SETUP_TOKEN`을 첫 설정 화면에 입력합니다. 키 값과 실제 사업자·계정 정보는 소스에 저장하지 않습니다. [최초 등록 안내](docs/oda-phase1.md#oda-첫-매장과-ab-계정-등록)
- Mac 로컬 실행: Docker Desktop 준비 후 `Start-ODA.command`. [실행·종료·백업 안내](docs/oda-local.md)
- 개발용 실행: `npm ci` 후 `npm run dev:oda` (테스트 전용 메모리 모드)
- 운영 빌드: `npm run build:oda`
- [매장 사용 흐름·계약 적용·배포](docs/oda-phase1.md)
- [OFD·ODA 서버 자원 공용 검토](docs/oda-shared-hosting-review.md)
- 현재 온라인 구성: `render.oda.shared.yaml` — ODA 전용 DB·운영 계정과 웹/API를 사용합니다. 정산 원본은 ODA DB에 저장하며 별도 ODA worker와 외부 발행·메일 공급자는 사용하지 않습니다.
- 독립 인프라 대안: `render.oda.yaml`. [DB·계정 분리와 배포 절차](docs/oda-shared-deployment.md)

배포 브랜치 `agent/oda-workstation-release`를 GitHub에 업로드했습니다. 앱 커밋 `60ea2ec`의 [V2 검사 실행 34900598013](https://github.com/roybeee/OFD/actions/runs/34900598013)에서 자동 테스트 514개 통과·ODA 네이티브 통합 검사 1개 건너뛰기, 실제 PostgreSQL smoke, 브라우저 안전 검사 3개·매장 흐름 검사 3개 통과를 확인했습니다. 실제 서버에서도 OFD·ODA의 상대 DB 접근 거절(SQLSTATE 42501), OFD API·worker의 분리 계정 운영, ODA API의 마이그레이션 11개 적용과 live 상태를 확인했습니다. 웹을 포함한 최신 적용 결과와 남은 실기기 검증 범위는 [배포 기록](docs/oda-shared-deployment.md)과 [1차 검증 범위](docs/oda-phase1.md#이번-개발본-검증-범위)를 따릅니다.

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
