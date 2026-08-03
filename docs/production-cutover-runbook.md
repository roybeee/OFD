# OFD V2 운영 전환 런북

이 문서는 migration 실행기 자체가 아니라 배포·전환 통제를 다룬다. 대상 release는
하나의 40자리 Git SHA로 API, worker, Web에 동일하게 배포한다.

## 1. 변경 승인 전 확인

1. `main`의 quality, production fail-closed 환경 preflight, PostgreSQL migration과
   test-mode PostgreSQL API runtime smoke, Web test/build, E2E가 모두 통과했는지 확인한다.
2. Render Blueprint sync 결과가 `render.yaml`과 일치하고 세 서비스의 auto-deploy가
   꺼져 있는지 확인한다.
3. 관리형 PostgreSQL snapshot/PITR, S3 versioning·SSE-KMS·public block, SMTP와
   provider secret 등록을 서로 다른 담당자가 확인한다.
4. 외부 provider 기능은 최초 전환에서 모두 `false`로 유지한다. 기능별 승인 뒤 필요한
   스위치만 별도 변경한다.
5. GitHub `production` environment에 필수 검토자, self-review 차단, main branch 제한을
   설정한다.

## 2. 쓰기 동결과 권위 시스템

현재 V2 코어에는 환경변수 기반 매장별 쓰기 동결이 없다. 따라서 다음 원칙을 적용한다.

- `CUTOVER_STORE_IDS`와 `WRITE_FREEZE_STORE_IDS`는 항상 빈 값이어야 한다. 비어 있지
  않으면 deployment preflight가 실패한다.
- 매장별 자동 동결을 지원한다고 운영자에게 안내하지 않는다.
- 파일럿 매장의 권위 시스템·전환 정산기간·수동 주문 중단 시각을 변경 티켓에 기록하고,
  점주·운영·재무가 같은 시각을 확인한다.
- 기술적 매장별 write gate가 필수인 전환은 코어 기능이 구현·검증될 때까지 NO_GO다.
- 전체 쓰기 중단이 필요하면 Render maintenance와 운영 채널 공지를 함께 사용하되,
  처리 중 outbox를 먼저 확인한다.

## 3. 승인 후 배포

1. GitHub workflow의 `deploy-production` job을 승인한다.
2. workflow는 Render API service를 지정 SHA로 배포한다. API predeploy가
   `preflight.mjs migrate`와 DB migration을 완료한다.
3. API가 `live`가 된 뒤 worker를 같은 SHA로 배포한다. worker의 outbox claim 오류와
   dead-letter를 확인한다.
4. 마지막으로 Web을 배포한다. Web은 private API `hostport`만 참조하며 외부 API 주소나
   secret을 번들에 포함하지 않는다.
5. 각 단계가 실패하면 다음 서비스를 배포하지 않는다.
6. workflow가 업로드한 `render-production-deploy-<SHA>` artifact와 job summary에서
   API·worker·Web의 deploy ID, 실제 commit ID, 직전 live deploy ID를 보존한다. 세 서비스의
   실제 commit ID가 승인한 SHA와 다르면 `live` 상태여도 실패로 판정한다.

## 4. 즉시 검증

- `GET /healthz` → 200: Web nginx liveness
- `GET /readyz` → 200 JSON: Web→private API 연결과 DB/schema/S3 readiness
- `GET /api/v2/health` → `mode=production`
- `GET /api/v2/ready` → 200이며 DB/schema/S3 점검이 모두 준비 상태
- `schema_migrations`의 버전/checksum과 배포 SHA 기록
- 로그인/MFA, 점주 매장 범위, 기사 당일 경로, HQ maker-checker
- S3 업로드→immutable metadata→서명 URL 다운로드
- 외부 기능이 승인 전에는 mock/disabled이고 outbox 외부 호출이 없는지 확인

## 5. 관찰과 GO 판정

30분 동안 API 오류율/p95, DB pool·lock, worker 최고 outbox 지연, dead-letter, S3 오류,
인증 실패율을 본다. 세금계산서 중복 위험, 금액 차이, 타매장 접근, migration checksum
불일치가 하나라도 있으면 즉시 NO_GO다.

## 6. 중단과 복귀

1. Web maintenance를 켜고 worker를 suspend해 신규 외부 side effect를 멈춘다.
2. 마지막 성공 outbox/provider 관리키와 migration 버전, 영향 거래를 보존한다.
3. workflow artifact의 `render-deploy-manifest.json`을 내려받고 Render service ID/API key를
   설정한 뒤 `npm run render:rollback -- render-deploy-manifest.json`을 실행한다. 스크립트는
   의존성 역순인 Web→worker→API로 직전 live deploy에 복귀하고 각 실제 commit ID를 검증한다.
   결과 `render-rollback-manifest.json`도 변경 티켓에 첨부한다.
4. migration은 schema/table을 역삭제하지 않고 전진 수정 migration을 사용한다.
5. 이미 외부 발행된 세금계산서는 삭제하지 않고 법정 수정세금계산서 절차를 따른다.
6. 기존 권위 시스템 재개 시각을 점주·운영·재무에 공지하고 2인이 건수와 총액을 대사한다.
