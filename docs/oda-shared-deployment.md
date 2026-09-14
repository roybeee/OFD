# ODA 공용 서버 운영 구성

사용자 승인 범위: OFD와 ODA를 구별해 저장하고 공용 서버에 연결·배포하며, 기존 OFD 운영 계정도 분리한다.

## 구성

| 항목 | OFD | ODA 월정산 1차 |
|---|---|---|
| 서비스 | 기존 OFD API·worker·web | oda-api, oda-web |
| PostgreSQL 호스트 | 기존 싱가포르 ofd-postgres | 같은 호스트 |
| 논리 DB | ofd_postgres | oda_production |
| 운영 역할 | ofd_app | oda_app |
| 권한 | 자기 DB·업무 객체 소유권 | 자기 DB·업무 객체 소유권 |
| 클러스터 관리 권한 | 없음 | 없음 |
| 세션·암호화 키 | 기존 OFD 키 | 새 ODA 전용 키 |
| 증빙 저장 | 기존 운영 구성 | ODA DB 안의 원본 bytes·SHA256·감사 기록 |
| 외부 처리 | 기존 OFD worker·S3·SMTP | 미지원 API 차단, worker 기동 차단 |

이 계정은 자기 DB 내부의 마이그레이션에 필요한 DDL 권한을 가진다. DML만 허용한 계정이라고 표현하지 않는다. 서로의 DB 연결은 PUBLIC·직접 권한·역할 상속을 포함해 차단한다. Render 관리 계정은 운영 앱에서 제거하지만 클라우드 관리와 복구를 위해 남는다. 같은 DB 호스트의 메모리·디스크·장애까지 분리되는 것은 아니다.

`render.oda.shared.yaml`은 ODA 월정산 전용 production 프로필이다. 새 PostgreSQL 인스턴스를 만들거나 기존 OFD 서비스를 선언적으로 변경하지 않는다. 자료를 PostgreSQL에 실제 저장하며 외부 메일·세금계산서·동기화 공급자는 disabled 오류를 반환한다. 모의 처리 성공을 반환하지 않는다.

## 소스와 검사

배포 브랜치는 `agent/oda-workstation-release`다. 기존 GitHub의 `.github/workflows` 내용을 그대로 유지하고, 이 브랜치를 대상으로 기존 V2 quality gate가 실행되도록 한다. 새 `.github/workflows/oda.yml`의 업로드는 토큰 Workflows 권한이 없어 보류한다. 작업 브랜치에는 해당 추가 검사 제안을 보관한다. 앱 소스와 테스트의 업로드는 허용된 Contents 범위로 수행한다. 기존 main을 변경하지 않는다.

`npm run test:oda`는 정산·원본 업로드·권한·계정·온라인 초기등록·production 설정·UI 검사를 실행한다. `npm run build:oda`는 API/worker 및 ODA 화면을 빌드한다. DB 권한 변경 전에는 폐기 가능한 별도 DB와 역할로 PostgreSQL의 실제 소유권·ACL·연결 거절을 검증한다. 운영 DB에 가짜 정산 자료를 넣어 검사하지 않는다.

## 운영 계정 전환

1. 원래 OFD ready 응답과 PostgreSQL 복구 지점을 확인한다.
2. `render-shared-accounts.py prepare`는 API·worker의 DATABASE_URL 두 값만 메모리에서 확인한다. OFD 전용·ODA 전용·일시 원복용 Render 비밀 설정 그룹을 따로 만든다. 전체 환경변수는 가져오지 않는다.
3. `oda-shared-provision.mjs`는 명시된 관리 계정과 기존 OFD DB만 허용한다. 새 이름이 이미 있으면 무변경 종료한다. 새 역할 두 개를 만들고 새 ODA DB는 연결 차단 상태로 생성한다.
4. OFD 기존 관리·모니터링 login 역할의 CONNECT를 보존한다. 업무 public 객체의 소유권과 양쪽 DB 접근 규칙을 짧은 트랜잭션에서 바꾼다. 확장 객체나 PostgreSQL 서비스 소유 객체는 변경하지 않는다. 잠금을 바로 얻지 못하면 롤백한다.
5. 새 역할 각각으로 자기 DB 접속과 상대 DB의 실제 접속 거절을 확인한다. 관리자의 새 운영 역할 상속은 기존 OFD 연결을 계속 작동하게 한다. 반대 방향의 관리 역할 상속은 허용하지 않는다.
6. OFD API DATABASE_URL을 바꾸고 기존 predeploy migration·health 검증을 통과한 배포가 live가 된 뒤 worker를 전환한다. 실패 시 기록한 원복 연결로 해당 서비스만 복구한다.
7. 임시 provisioning 암호 값은 제거한다. ODA 비밀 설정은 ODA 서비스에만 연결한다.

`render-shared-accounts.py`의 체크포인트에는 리소스 ID·단계·배포 ID만 저장한다. 비밀번호는 소스·파일·로그에 저장하지 않는다. 생성 후 중간 실패를 자동 재실행하거나 DB를 삭제하지 않는다. provision 로그의 원복 명세와 마지막 완료 단계를 먼저 확인한다.

## ODA 배포와 최초 등록

- API 시작·마이그레이션 전에 `oda-shared-entry.mjs`가 운영 설정과 DB 양방향 격리를 검사한다.
- 운영 프로필: ODA_SETTLEMENT_ONLY=true, STORAGE_MODE=postgres, EMAIL_PROVIDER=disabled, PROVIDER_MODE=disabled. 기존 OFD production은 계속 S3와 worker를 요구한다.
- ODA readiness는 실제 PostgreSQL 연결, 적용 migration, 원본·감사·중복방지 저장 권한을 확인한다.
- WEB_ORIGIN과 PUBLIC_APP_URL은 ODA의 실제 HTTPS origin과 같아야 한다. 기존 OFD 웹은 `https://ofd-web.onrender.com`, 별도 기존 워크스테이션은 `https://ofd-workstation.onrender.com`이다.
- 최초 등록에는 무작위 일회성 ODA_SETUP_TOKEN과 UTC 만료시각 ODA_SETUP_EXPIRES_AT가 필요하다. 토큰은 앱의 비밀번호 입력란 또는 URL fragment에서 받아 즉시 URL에서 지우고 헤더로만 보낸다.
- 운영자가 실제 매장·사업자·관리자·A·B 정보를 입력한다. 중복·동시 등록은 DB에서 막고 등록 후 토큰을 다시 사용할 수 없다. 초기화가 끝나면 토큰을 제거해도 정상 로그인·재시작이 가능하다.
- Render의 TLS 종료 지점을 고려해 nginx가 HTTPS 전달 정보를 API에 보존한다.

현재 증빙 제한은 파일당 2 MiB, 매장·월별 10 MiB, 5,000행이다. 원본 base64 저장과 월 전체 문서 갱신을 사용하므로 장기 운영에서는 증빙 용량과 DB 사용량을 확인해야 한다. 별도 객체 저장소 이전을 완료했다고 표현하지 않는다.

## 확인된 서버 기준 상태

2026-09-14 UTC 확인: 기존 OFD DB는 PostgreSQL 16/basic_256mb/1 GB다. API·worker는 기존 관리 역할 ofd_postgres_user를 사용했고 CREATEDB·CREATEROLE 권한이 있었다. 기존 연결 역할 primaryuser·datadog·postgres의 접근도 보존 대상이다. 원래 OFD ready는 HTTP 200, migration 11/11, worker heartbeat 정상, S3 버전 관리 Enabled였다. PostgreSQL 복구 상태 AVAILABLE를 확인했다.

이 문서의 구성과 준비 완료는 실제 배포 완료를 뜻하지 않는다. 최종 적용 결과는 실행 체크포인트와 Render 배포 상태, 실제 health·격리 결과로 확인한다.

2026-09-14 21:44 UTC: 실제 PostgreSQL 임시 DB 검증이 통과했고 생성 자원을 모두 정리했다. 이후 운영 DB 분리 작업 `job-dak6l9ff3r2c73c9p6i0`가 성공했다. `ofd_app/ofd_postgres`, `oda_app/oda_production` 각각 접속 확인, 상대 DB 접속은 양쪽 모두 SQLSTATE 42501로 거절됐다. OFD 업무 관계 객체 50개와 함수 2개의 소유권 및 기존 모니터링 접근을 보존했다. 이 단계에서 기존 OFD readiness는 여전히 HTTP 200이었다. 서비스 실행 계정 전환과 ODA 배포는 별도 후속 단계다.

GitHub의 첫 배포 브랜치 업로드는 성공했다. 기존 V2 검사에서 발견한 nodemailer 고위험 의존성은 9.1.1로 갱신했고 로컬 high 감사 및 관련 integration 검사가 통과했다. 새 workflow 파일은 업로드하지 않았다.

## 최종 온라인 적용 결과 — 2026-09-14 UTC

- 접속: https://oda-web-wpts.onrender.com
- 앱 소스: `60ea2ecb25fb7bf4bb23df75dcc0503326868221`, `agent/oda-workstation-release`. 이후 문서·웹 실행 명령 보정만 소스에 추가했다.
- ODA API `srv-dak6mdm1egvs739an23g` / 배포 `dep-dak6nip42hec739op7m0`: live.
- ODA web `srv-dak6mj61egvs739anm1g` / 배포 `dep-dak6plnjopgc73cp8dtg`: live. Render의 Docker 실행 명령에 `/bin/sh /usr/local/bin/ofd-web-entrypoint`를 명시해 nginx 설정 생성을 보장했다.
- OFD API `dep-dak6m5bl550s73a45dk0`, worker `dep-dak6na3l550s73a49cu0`: 기존 main 앱 그대로 `ofd_app` 계정으로 전환한 배포가 live. 전환용 암호 환경변수 3개는 제거했다.
- 21:58 UTC 외부 확인: ODA `/` 및 `/readyz` HTTP 200. 운영 PostgreSQL, migration 11/11, PostgreSQL 원본 저장 준비 모두 정상. ODA 정산 전용 프로필은 worker를 요구하지 않는다.
- 같은 시각 기존 OFD `/readyz` HTTP 200, worker heartbeat 정상, S3 버전 관리 Enabled 유지.
- 온라인 최초 등록 조회: enabled=true, initialized=false, setupMode=online. 실제 매장·사업자·관리자/A/B 등록은 아직 하지 않았으며 가짜 운영 계정을 만들지 않았다.
- 외부 요청으로 비로그인 bootstrap 401, 지원하지 않는 API 404, 설정 키 누락 403, OFD origin의 ODA 등록 요청 403을 확인했다. 올바른 ODA origin은 토큰 검증 단계까지 도달해 nginx의 HTTPS 전달도 확인했다.
- 설정 키는 Render `oda-production-secrets` 환경그룹의 `ODA_SETUP_TOKEN`에만 보관한다. 현재 키 기한은 2026-09-16 21:48 UTC(한국 시간 9월 17일 06:48)이다. 최초 등록 화면에 키와 실제 정보를 입력한다.
- [GitHub 검사 34900598013](https://github.com/roybeee/OFD/actions/runs/34900598013): quality 및 E2E 성공. 자동 테스트 514개 통과, ODA 전용 네이티브 통합 검사 1개 건너뛰기. 별도 실제 PostgreSQL smoke와 브라우저 검사 통과. 건너뛴 검사를 통과로 계산하지 않는다.

같은 PostgreSQL 호스트를 사용하지만 데이터베이스·소유 역할·앱 서비스·세션 비밀값은 분리했다. `ofd_app`은 OFD DB에만, `oda_app`은 ODA DB에만 CONNECT가 허용되며 두 역할 모두 SUPERUSER/CREATEDB/CREATEROLE 권한이 없다. 공유 호스트의 CPU·메모리·디스크 자원은 공동 사용하므로 데이터 접근 격리와 자원 경쟁은 구별한다.
