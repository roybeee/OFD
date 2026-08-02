# OFD Workstation V2 배포 가이드

V2는 기존 `server/`와 별도인 React Web, Fastify API, worker, PostgreSQL, S3로
배포한다. 파일럿이 끝날 때까지 기존 서버의 코드와 데이터는 읽기 전용 기준선으로
유지한다.

## 1. 배포 단위

| 단위 | Dockerfile | 역할 | 외부 공개 |
| --- | --- | --- | --- |
| Web | `infra/docker/web.Dockerfile` | React 정적 파일, `/api/v2` reverse proxy | 예 |
| API | `infra/docker/api.Dockerfile` | 인증, 업무 API, webhook, health | Web/Popbill만 |
| Worker | `infra/docker/worker.Dockerfile` | outbox, 문서, 알림, Popbill/계좌 비동기 처리 | 아니오 |
| PostgreSQL | 관리형 서비스 | 원장, outbox/inbox, 감사 | 아니오 |
| S3 | AWS S3 | 배송사진·PDF private object | 서명 URL만 |

컨테이너는 같은 이미지 태그(커밋 SHA)를 사용한다. worker를 API와 같은 프로세스로
합치지 않는다.

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
   `NODE_ENV=production`과 `APP_MODE=production`은 반드시 함께 설정한다. 운영에서
   `APP_MODE` 누락이나 `demo` fallback은 허용하지 않는다. 저장소는
   `STORAGE_MODE=s3`, 메일은 `EMAIL_PROVIDER=smtp`여야 하며 `SMTP_HOST`와
   검증된 `EMAIL_FROM`을 등록한다. 이 요구사항은 Popbill 기능 스위치와 독립적이다.
4. DB migration 전 자동 snapshot을 만들고 migration job을 단 한 번 실행한다.
5. API를 배포하되 Popbill 운영 스위치는 모두 `false`로 둔다.
6. worker, Web 순서로 배포하고 health/readiness와 구조화 로그를 확인한다.
7. 데모/샌드박스 end-to-end 검증 후 대표 매장 2곳만 파일럿 cohort에 넣는다.

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
2. 동일 태그의 API/worker/Web 이미지를 생성하고 digest를 릴리스 기록에 남긴다.
3. 하위호환 migration을 실행한다. 기존 column/table 삭제는 다음 릴리스로 미룬다.
4. API canary 1개에서 `/health`, `/ready`, DB·S3 연결, provider 상태를 확인한다.
5. API 전체 → worker 1개 → worker 전체 → Web 순서로 점진 배포한다.
6. 30분간 오류율, p95, DB lock/pool, outbox 지연, dead-letter를 감시한다.
7. 릴리스 태그, migration 버전, 승인자, 관찰 결과를 운영 일지에 기록한다.

## 5. Health와 경보 기준

- Liveness: 프로세스 이벤트 루프만 확인한다.
- Readiness: DB 읽기, migration 버전, S3 설정, 필수 환경변수를 확인한다.
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

- 앱 결함: 신규 입력을 feature flag로 차단하고 이전 이미지 digest로 되돌린다.
- 하위호환 migration: DB는 전진 수정 migration을 사용하며 즉시 역삭제하지 않는다.
- 재무 불일치/중복 위험: worker의 외부 발행 소비를 즉시 중지하고 재무 큐를 동결한다.
- 이미 발행된 세금계산서: 데이터/배포 롤백으로 삭제하지 않고 법정 수정세금계산서
  절차만 사용한다.
- 자세한 파일럿 중단/복귀 절차는 `docs/migration-pilot-runbook.md`를 따른다.
