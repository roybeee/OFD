# OFD Workstation V2 배포 가이드

V2는 `render.yaml`을 단일 배포 명세로 사용하는 React Web, private Fastify API,
background worker, 관리형 PostgreSQL, 외부 S3 토폴로지로 배포한다. Web 컨테이너만
공개되고 `/api/v2/*`를 private API로 reverse proxy한다. 기존 `server/public/v2`에
Web 산출물을 만들거나 커밋하는 방식은 배포 절차가 아니다.

## 1. 배포 단위

| 단위 | Dockerfile | 역할 | 외부 공개 |
| --- | --- | --- | --- |
| Web | `infra/docker/web.Dockerfile` | React 정적 파일, `/api/v2` reverse proxy | 예 |
| API | `infra/docker/api.Dockerfile` | 인증, 업무 API, webhook, health | private network; webhook도 Web proxy 경유 |
| Worker | `infra/docker/worker.Dockerfile` | outbox, 문서, 알림, Popbill/계좌 비동기 처리 | 아니오 |
| PostgreSQL | 관리형 서비스 | 원장, outbox/inbox, 감사 | 아니오 |
| S3 | AWS S3 | 배송사진·PDF private object | 서명 URL만 |

컨테이너는 같은 이미지 태그(커밋 SHA)를 사용한다. worker를 API와 같은 프로세스로
합치지 않는다.

실행 명령은 다음 값으로 고정한다.

| 서비스 | 실행 명령 |
| --- | --- |
| Web | `nginx -g 'daemon off;'` |
| API | `node apps/api/dist/server.js` |
| Worker | `node apps/worker/dist/main.js` |
| Predeploy migration | `node infra/scripts/deploy/preflight.mjs migrate && node packages/db/dist/migrate.js` |

Render의 `API_UPSTREAM_HOSTPORT`는 private API의 `hostport` 속성을 참조한다. Blueprint는
문자열 보간을 지원하지 않으므로 `http://` 접두사는 nginx 템플릿 안에서 붙인다.

## 2. 로컬 실행

```bash
cp .env.example .env
npm ci
npm run infra:up
set -a
. ./.env
set +a
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:4100`
- MinIO: `http://localhost:9001`

기본 `.env.example`은 `STORAGE_MODE=mock`, `EMAIL_PROVIDER=mock`이라 외부 저장이나
메일 발송 없이 데모를 실행한다. 실제 S3 호환 경로를 로컬에서 확인할 때만 `.env`의
`STORAGE_MODE=s3`로 바꾸고 `S3_ENDPOINT=http://localhost:9000`, MinIO 접근키,
버킷을 사용한다. `npm run infra:up`이 MinIO 버킷을 생성하고 versioning과 비공개
정책을 적용한다. 위의 `set -a` 블록은 루트 `.env` 값을 API·worker·Web 프로세스에
상속시키므로 생략하지 않는다.

`docker compose -f infra/docker-compose.yml down`은 컨테이너만 내리고 named volume은
보존한다. 로컬 데이터를 지우는 `down -v`는 이 가이드의 정상 절차에 포함하지 않는다.

## 3. 운영 최초 준비

1. 서울 리전의 관리형 PostgreSQL을 만들고 TLS, PITR, 자동백업, 접근 IP/보안그룹을
   설정한다.
2. S3 private bucket에 versioning, SSE-KMS, public access block, 수명주기 정책을
   적용한다. API/worker는 최소권한 IAM role을 각각 사용한다.
3. Web, API, worker secret을 환경별로 분리 등록하고 `npm run preflight`를 실행한다.
   `NODE_ENV=production`, `APP_MODE=production`, `REPOSITORY_MODE=postgres`는 반드시
   함께 설정한다. 운영에서 `demo`/memory fallback은 허용하지 않는다. 저장소는
   `STORAGE_MODE=s3`, 메일은 `EMAIL_PROVIDER=smtp`여야 하며 `SMTP_HOST`와
   검증된 `EMAIL_FROM`을 등록한다. 이 요구사항은 Popbill 기능 스위치와 독립적이다.
4. DB migration 전 자동 snapshot을 만들고 migration job을 단 한 번 실행한다.
5. API를 배포하되 Popbill 운영 스위치는 모두 `false`로 둔다.
6. worker, Web 순서로 배포하고 health/readiness와 구조화 로그를 확인한다.
7. 데모/샌드박스 end-to-end 검증 후 대표 매장 2곳만 파일럿 cohort에 넣는다.

### Render Blueprint와 비밀값

- `render.yaml`의 모든 서비스는 `autoDeployTrigger: off`다. GitHub의 보호된
  `production` environment 승인 없이 Render가 자동 배포하지 않는다.
- PostgreSQL은 public inbound를 차단한 관리형 PG16이고 API/worker는
  `fromDatabase.connectionString`만 사용한다.
- `SESSION_SECRET`, 32바이트 base64 `ENCRYPTION_KEY`, S3 bucket/IAM access key, SMTP,
  Popbill 값은 모두 `sync: false` 외부 secret으로 등록한다. 값 자체는 Git, Blueprint,
  로그에 기록하지 않는다.
- 운영 배포 전에 `node infra/scripts/deploy/preflight.mjs api`를 실행한다. API predeploy
  migration은 같은 검사를 `migrate` 역할로 다시 실행하고 worker predeploy는 `worker`
  역할로 검증한다.
- API와 worker는 서로 다른 서비스지만 provider 기능 스위치와 S3/SMTP 설정은 같은
  승인된 값을 참조한다.

### 최초 npm 잠금파일 생성

일반 CI와 Docker 빌드는 항상 커밋된 `package-lock.json`으로 `npm ci`를 실행한다.
저장소 최초 1회에 한해 GitHub Actions의 `Bootstrap npm lockfile artifact` 수동
워크플로를 실행한다. 이 워크플로는 lifecycle script 없이 잠금파일을 만든 뒤 깨끗한
`npm ci`로 재현성을 확인하고 `package-lock-node-22` 아티팩트를 제공한다. 아티팩트를
검토해 저장소 루트에 그대로 커밋한 뒤부터는 bootstrap 워크플로가 기존 잠금파일을
덮어쓰지 않으며, 일반 품질 게이트는 잠금파일이 없으면 즉시 실패한다.

## 4. 일반 배포 순서

1. CI의 typecheck, 단위/통합/E2E, 접근성, build, 운영 preflight를 모두 통과한다.
   빌드된 API를 `node apps/api/dist/server.js`로 기동하는 runtime smoke와 health
   확인도 통과해야 한다.
2. GitHub `production` environment의 필수 검토자가 배포를 승인한다. 배포 실행자가
   자신의 요청을 승인하지 못하도록 environment 보호 규칙을 설정한다.
3. 승인된 커밋 SHA로 API 배포를 시작한다. API `preDeployCommand`가 migration을 먼저
   완료해야 새 API revision이 live가 된다.
4. API live 확인 뒤 같은 SHA의 worker, 마지막으로 Web을 순차 배포한다. 이 순서는
   `infra/scripts/deploy/trigger-render-deploy.mjs`가 강제한다. Render가 빈 본문의
   `202 Queued`를 반환해도 deploy 목록에서 요청 SHA를 찾아 계속 추적하며, 최종 live
   deploy의 `commit.id`가 요청 SHA와 다르면 실패한다.
5. Web `/healthz`, Web `/readyz`, API `/api/v2/health`, API `/api/v2/ready`, 관리형 DB migration ledger,
   S3 private-object 시험과 provider 상태를 확인한다.
6. 30분간 오류율, p95, DB lock/pool, outbox 지연, dead-letter를 감시한다.
7. workflow artifact의 `render-deploy-manifest.json`에 기록된 현재/직전 deploy ID와 commit ID,
   릴리스 태그, migration 버전, 승인자, 관찰 결과를 운영 일지에 기록한다.

CI는 실제 배포 값으로 production fail-closed preflight를 별도 실행한다. 이어 PostgreSQL 16
service에 migration을 적용하고 `APP_MODE=test`, `REPOSITORY_MODE=postgres`로 컴파일된 API를
기동한다. `smoke-postgres-runtime.mjs`는 저장소의 모든 migration 파일이
`schema_migrations`에 기록됐는지 검사한다. mock S3/SMTP를 production API에 주입하지 않으며,
memory/demo repository smoke는 배포 게이트로 인정하지 않는다.

## 5. Health, readiness와 경보 기준

- Web liveness `GET /healthz`: nginx 프로세스만 확인한다.
- Web edge readiness `GET /readyz`: nginx에서 private API의 `GET /api/v2/ready`까지
  도달하고 DB schema와 S3 준비 상태가 통과했는지 확인한다.
- API liveness `GET /api/v2/health`: Fastify 프로세스와 app/provider mode를 확인한다.
- API readiness `GET /api/v2/ready`: PostgreSQL 연결·필수 schema migration·S3 provider
  준비 상태를 확인하며, 실패하면 Web `/readyz`도 비정상 상태를 반환한다.
- 외부 Popbill 장애는 API readiness를 내리지 않고 provider circuit 상태와 outbox
  지연으로 경보한다.
- 즉시 호출: 5분 오류율 2% 초과, API p95 1초 초과, outbox 최고 지연 10분 초과,
  dead-letter 1건 이상, 중복 발행 의심 1건 이상.

## 6. Popbill 운영 활성화

운영 배포와 외부 발행 활성화는 별도 변경이다. 다음을 서로 다른 담당자가 확인한다.

1. 법인번호/사용자/Link ID 자격증명과 webhook API key 등록
2. 공급자 인증서 정상·만료일 확인
3. 계좌조회 승인과 대상 계좌 확인
4. 테스트 법인에서 발행, 상태조회, webhook 중복, 타임아웃 후 조회, 수정발행 검증
5. provider 관리키가 내부 invoice UUID에서 결정적으로 생성되는지 확인
6. `PROVIDER_MODE=production`, `POPBILL_PRODUCTION_ENABLED=true`와 필요한 기능만
   단계적으로 활성화

사전검사 실패를 우회하지 않는다. 자격증명이나 인증서가 없으면 mock 상태로 배포는
가능하지만 외부 발행·계좌조회·SMS 호출은 불가능해야 한다.

## 7. 배포 롤백

- 앱 결함: 신규 입력과 worker 외부 효과를 차단하고 workflow artifact의
  `render-deploy-manifest.json`으로 `npm run render:rollback -- render-deploy-manifest.json`을
  실행한다. 스크립트는 Web→worker→API 순으로 기록된 직전 live deploy에 복귀하고 실제
  commit ID를 검증한다.
- 하위호환 migration: DB는 전진 수정 migration을 사용하며 즉시 역삭제하지 않는다.
- 재무 불일치/중복 위험: worker의 외부 발행 소비를 즉시 중지하고 재무 큐를 동결한다.
- 이미 발행된 세금계산서: 데이터/배포 롤백으로 삭제하지 않고 법정 수정세금계산서
  절차만 사용한다.
- 자세한 파일럿 중단/복귀 절차는 `docs/migration-pilot-runbook.md`를 따른다.

## 8. 매장별 전환·쓰기 동결 제한

현재 애플리케이션 코어는 `CUTOVER_STORE_IDS`와 `WRITE_FREEZE_STORE_IDS` 환경변수를
강제하지 않는다. 배포 preflight는 이 값이 비어 있지 않으면 시작을 거부한다. 지원되지
않는 플래그를 설정해 쓰기가 멈췄다고 간주하지 않는다. 매장별 전환은
`docs/production-cutover-runbook.md`의 승인·확인 절차로 수행하고, 자동 동결이 필요하면
별도 코어 기능과 테스트를 먼저 배포한다.
