# OFD V2 환경변수 매트릭스

실제 비밀값은 Render/AWS의 secret store에만 저장한다. `.env.example`은 키 이름과
개발 기본값만 제공하며 운영 값으로 재사용하지 않는다.

## 공통

| 변수 | 로컬 | CI | 운영 | 비고 |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` | `test` | `production` | 운영 사전검사 기준 |
| `APP_MODE` | `demo` | `production` | `production` | CI 배포 게이트도 PostgreSQL repository 사용; unit test는 명시적 test fixture 가능 |
| `REPOSITORY_MODE` | `memory` | `postgres` | `postgres` | CI/운영에서 memory fallback 금지 |
| `API_PORT` | `4100` | `4100` | 플랫폼 주입 | API listen port |
| `PUBLIC_APP_URL` | `http://localhost:5173` | 테스트 URL | HTTPS URL | 문서/알림 링크 기준 |
| `WEB_ORIGIN` | `http://localhost:5173` | 테스트 URL | HTTPS URL | CORS 단일 허용 origin |
| `SESSION_SECRET` | 임의 개발값 | CI 임시값 | 32자 이상 secret | `ENCRYPTION_KEY`와 달라야 함 |
| `ENCRYPTION_KEY` | 32바이트 예제 키의 base64 | CI 임시값 | 무작위 32바이트를 base64 인코딩한 secret | MFA 비밀키 AES-256-GCM 암호화 키 |
| `SESSION_COOKIE_SECURE` | `false` | `false` | `true` | 운영 필수 |
| `SERVICE_ROLE` | 미설정 | `api` | `api`/`worker` | 배포 preflight 역할 |
| `RELEASE_SHA` | 미설정 | `${GITHUB_SHA}` | Render commit SHA | 반드시 40자리 전체 SHA |
| `CUTOVER_STORE_IDS` | 빈 값 | 빈 값 | 빈 값 | 현재 코어 미지원; 비어 있지 않으면 preflight 실패 |
| `WRITE_FREEZE_STORE_IDS` | 빈 값 | 빈 값 | 빈 값 | 현재 코어 미지원; 비어 있지 않으면 preflight 실패 |

## 데이터베이스와 파일

| 변수 | 로컬 | 운영 | 필수 조건 |
| --- | --- | --- | --- |
| `DATABASE_URL` | Docker PostgreSQL | 관리형 PostgreSQL TLS URL | `postgresql://`, PITR 활성화 |
| `DATABASE_POOL_MIN/MAX` | `2/20` | 용량 산정값 | API+worker 총 연결수가 DB 한도 이내 |
| `STORAGE_MODE` | `mock` | `s3` | 운영에서 mock 금지; MinIO 시험 시 로컬도 `s3` |
| `S3_ENDPOINT` | `http://localhost:9000` | 보통 미설정 | MinIO 같은 호환 저장소에만 설정 |
| `S3_REGION` | `ap-northeast-2` | 버킷 리전 | 필수 |
| `S3_BUCKET` | `ofd-v2-local` | private 전용 버킷 | versioning/암호화/public block 필수 |
| `S3_ACCESS_KEY_ID` | MinIO 개발값 | 보통 미설정 | 명시적 S3 호환 endpoint에만 필수; AWS는 역할 권장 |
| `S3_SECRET_ACCESS_KEY` | MinIO 개발값 | 보통 미설정 | 명시적 S3 호환 endpoint에만 필수; 로그/DB 저장 금지 |
| `S3_KMS_KEY_ID` | 선택 | 전용 KMS key/alias | 운영 사전검사 필수 |

## 이메일

| 변수 | 로컬 | 운영 | 필수 조건 |
| --- | --- | --- | --- |
| `EMAIL_PROVIDER` | `mock` | `smtp` | 운영에서 mock 금지 |
| `EMAIL_FROM` | `no-reply@example.invalid` | 검증된 발신 주소 | SMTP 운영 사전검사 필수 |
| `SMTP_HOST` | 미설정 | SMTP 호스트 | SMTP 운영 사전검사 필수 |
| `SMTP_PORT` | `587` | 공급자 포트 | TLS 정책과 일치 |
| `SMTP_USER/PASSWORD` | 미설정 | secret store | 공급자가 요구하는 경우 등록 |

## 외부 연동과 fail-closed 규칙

| 변수 | 초기 운영값 | 활성화 조건 |
| --- | --- | --- |
| `PROVIDER_MODE` | `mock` | 아래 모든 사전조건 확인 뒤 `production` |
| `POPBILL_PRODUCTION_ENABLED` | `false` | 담당자 2인 변경 승인 뒤 `true` |
| `POPBILL_TAX_INVOICE_ENABLED` | `false` | 운영 인증서와 테스트 발행/취소 검증 완료 |
| `POPBILL_BANK_SYNC_ENABLED` | `false` | 계좌조회 승인과 샌드박스 대사 검증 완료 |
| `POPBILL_SMS_ENABLED` | `false` | 발신번호 승인과 수신거부 절차 확인 |
| `POPBILL_LINK_ID` 등 | secret store | Link ID, secret, 법인번호, user ID, webhook API key 모두 필요 |
| `POPBILL_WEBHOOK_API_KEY` | secret store | Popbill webhook `X-Api-Key` 검증 전용 키 |
| `POPBILL_CERTIFICATE_CONFIGURED` | `false` | 세금계산서 기능을 켤 때 인증서 확인 후 `true` |
| `POPBILL_BANK_ACCOUNT_AUTHORIZED` | `false` | 계좌조회 기능을 켤 때 대상 계좌 승인 후 `true` |
| `POPBILL_BANK_CODE/ACCOUNT` | secret store | 계좌조회 기능을 켤 때 승인된 계좌와 정확히 일치 |
| `POPBILL_SMS_SENDER` | secret store | SMS 기능을 켤 때 승인된 발신번호 |

다음 중 하나라도 어긋나면 API, worker, 배포 파이프라인이 시작을 거부해야 한다.

- `NODE_ENV=production`인데 `APP_MODE=production` 또는 `REPOSITORY_MODE=postgres`가 아니거나 누락됨
- 운영인데 `STORAGE_MODE=s3`, `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `EMAIL_FROM` 중 하나라도 누락됨
- 운영 기능 스위치가 켜졌는데 `PROVIDER_MODE`가 `production`이 아님
- 운영 허용 스위치 또는 Popbill 공통 자격증명 누락
- 켠 기능에 필요한 인증서·계좌 승인·발신번호 조건이 충족되지 않음
- 운영 HTTPS, Secure cookie, DB/S3 암호화 필수값 누락

배포 전 `npm run preflight`를 실행한다. 이 명령은 값의 존재 여부만 검사하며 비밀값을
출력하지 않는다. 자격증명의 실제 유효성은 별도 샌드박스 연결시험으로 확인한다.
컨테이너/Render 배포에는 이어서 `node infra/scripts/deploy/preflight.mjs <api|worker|migrate>`를
실행해 Postgres URL, release SHA, 서비스 역할과 미지원 cutover flag까지 확인한다.

Web은 비밀값을 받지 않는다. `API_UPSTREAM_HOSTPORT`만 Render private-service 참조로
주입하며 nginx가 `http://` scheme을 붙인다. `VITE_API_BASE=/api/v2`,
`VITE_DEMO_MODE=false`로 빌드하고 `server/public/v2` 경로는 사용하지 않는다.

## 책임과 변경 승인

- 비밀값 등록: 인프라 관리자
- 인증서·계좌 승인 확인: 재무 담당자 + 마스터(서로 다른 사용자)
- 외부 연동 스위치 변경: 마스터 승인 후 인프라 관리자 실행
- 분기별: 미사용 키 폐기, 접근권한 재검토, webhook API key 순환
- 인증서 만료: 60/30/14/7일 전 앱·이메일 알림
