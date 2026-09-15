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
- 기본 등록은 마스터의 이름·이메일·비밀번호만 받는다. 사업자 정보를 비워 둔 `ODA 기본 작업공간`을 만들고, 마스터 홈에서 정산·증빙·출력·매장·계정을 관리한다. 사업자와 A·B 계정은 나중에 등록하며, 마스터가 계약 당사자 둘의 합의를 대신하지 않는다. 사업자·매장·A·B를 함께 등록하는 기존 방식도 선택할 수 있다.
- 중복·동시 등록은 두 등록 방식이 공유하는 DB 잠금으로 막고, 등록 후 설정 키를 다시 사용할 수 없다. 본인이 지정한 마스터 비밀번호는 그대로 사용한다. 초기화가 끝나면 토큰을 제거해도 정상 로그인·재시작이 가능하다.
- Render의 TLS 종료 지점을 고려해 nginx가 HTTPS 전달 정보를 API에 보존한다.

현재 증빙 제한은 파일당 2 MiB, 매장·월별 10 MiB, 5,000행이다. 원본 base64 저장과 월 전체 문서 갱신을 사용하므로 장기 운영에서는 증빙 용량과 DB 사용량을 확인해야 한다. 별도 객체 저장소 이전을 완료했다고 표현하지 않는다.

## 확인된 서버 기준 상태

2026-09-14 UTC 확인: 기존 OFD DB는 PostgreSQL 16/basic_256mb/1 GB다. API·worker는 기존 관리 역할 ofd_postgres_user를 사용했고 CREATEDB·CREATEROLE 권한이 있었다. 기존 연결 역할 primaryuser·datadog·postgres의 접근도 보존 대상이다. 원래 OFD ready는 HTTP 200, migration 11/11, worker heartbeat 정상, S3 버전 관리 Enabled였다. PostgreSQL 복구 상태 AVAILABLE를 확인했다.

이 문서의 구성과 준비 완료는 실제 배포 완료를 뜻하지 않는다. 최종 적용 결과는 실행 체크포인트와 Render 배포 상태, 실제 health·격리 결과로 확인한다.

2026-09-14 21:44 UTC: 실제 PostgreSQL 임시 DB 검증이 통과했고 생성 자원을 모두 정리했다. 이후 운영 DB 분리 작업 `job-dak6l9ff3r2c73c9p6i0`가 성공했다. `ofd_app/ofd_postgres`, `oda_app/oda_production` 각각 접속 확인, 상대 DB 접속은 양쪽 모두 SQLSTATE 42501로 거절됐다. OFD 업무 관계 객체 50개와 함수 2개의 소유권 및 기존 모니터링 접근을 보존했다. 이 단계에서 기존 OFD readiness는 여전히 HTTP 200이었다. 서비스 실행 계정 전환과 ODA 배포는 별도 후속 단계다.

GitHub의 첫 배포 브랜치 업로드는 성공했다. 기존 V2 검사에서 발견한 nodemailer 고위험 의존성은 9.1.1로 갱신했고 로컬 high 감사 및 관련 integration 검사가 통과했다. 새 workflow 파일은 업로드하지 않았다.

## 최초 온라인 적용 결과 — 2026-09-14 UTC

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

## 마스터 단독 등록 적용 결과 — 2026-09-14 UTC

- 앱 소스 `ad0291de73c8daa9c27d46924e693b40021da7c8`를 같은 `agent/oda-workstation-release` 브랜치에 업로드했다. 기존 GitHub workflow와 main은 변경하지 않았다.
- ODA API 배포 `dep-dak794qfngtc73c206j0`, 웹 배포 `dep-dak7a30ae00c73fuv5tg` 모두 위 앱 커밋으로 live다. 접속 주소는 [ODA 워크스테이션](https://oda-web-wpts.onrender.com)으로 유지한다.
- 기본 가입은 일회성 설정 키를 확인한 뒤 마스터 이름·이메일·비밀번호만 받는다. 사업자·실제 매장·A·B 입력은 선택 사항이다. 별도의 법인이나 가짜 담당자를 만들지 않으며, 사업자 정보가 비어 있는 논리 작업공간만 생성한다.
- 마스터 홈은 월 손익·증빙·정산서 출력·정산 기준·확정 및 지급·이력·매장·계정 관리로 연결된다. 매장 이름만 추가하거나 기존 작업공간에 사업자 정보를 나중에 등록할 수 있다. 본인이 지정한 마스터 비밀번호는 첫 로그인 때 다시 바꾸지 않는다.
- 마스터의 확정·재개방·지급 기록 권한을 추가했으며, 실제 A·B의 개별 기준 확인과 미해결 항목·지급액 검사는 유지한다. 배정 범위가 있는 기존 ODA 관리자·감사 계정의 초기 조회도 해당 매장으로 제한한다.
- [GitHub 검사 34904003546](https://github.com/roybeee/OFD/actions/runs/34904003546)의 quality와 E2E가 모두 성공했다. 로컬 ODA 테스트·빌드, 사업자 없는 가입부터 로그인·업로드·원본 다운로드·XLSX 출력·계정 조회까지의 HTTP 검사도 통과했다. 이 HTTP 검사는 명시적인 메모리 저장소 주입으로 실행했으며, 운영 DB 내 가짜 계정·정산 자료를 만들지 않았다.
- ODA 및 기존 OFD `/readyz` HTTP 200을 확인했다. ODA 최초 등록 상태는 `initialized=false`, 설정 키는 유효하며 실제 마스터 생성은 운영자가 본인 정보로 진행한다. OFD 서비스의 소스나 설정은 이번 기능 배포에서 변경하지 않았다.
- 외부 접속에서 ODA `/`와 `/hq/oda-master` HTTP 200, 배포된 `index-B-91yGjV.js` 안의 마스터 가입·홈·매장 관리 연결을 확인했다. 마스터 홈 자체는 로그인 후 표시한다.

## 월별 매장 현황판 적용 결과 — 2026-09-14 UTC

- 앱 소스 `4a2af093dfa357db6da7603a0a1cbd8430b92306`, API 배포 `dep-dak872942hec739jkk80`, 웹 배포 `dep-dak8830u01pc73e60tr0`가 모두 live다.
- 마스터 홈에서 지난달을 기본으로 매장별 자료 미등록·확인 필요·확정 가능·지급 대기·지급 완료 상태와 금액·다음 할 일을 확인한다. 버튼은 선택한 정산월과 매장의 거래 검토·기준 확인·지급 화면으로 연결한다.
- 현황 조회는 매장 권한과 비활성 여부를 서버에서 적용하며 20개씩 표시한다. 원본 파일 bytes·과거 거래 복사본을 조회 응답에서 제외하고, 확정 금액은 저장된 확정본에서 가져온다. 미등록 자료는 0원으로 표시하거나 조회 시 자동 생성하지 않는다.
- [GitHub 검사 34908976066](https://github.com/roybeee/OFD/actions/runs/34908976066)의 quality·E2E 성공. PostgreSQL 통합 검사에 월·매장 범위와 확정본 조회, 원본 bytes 제외 검증을 추가해 실제 CI DB에서 통과했다. ODA 전용 선택적 네이티브 검사 1개는 별도로 건너뛰며 통과로 계산하지 않는다.
- 외부 확인: ODA `/`·`/hq/oda-master`·`/readyz` HTTP 200, 비로그인 현황 API 401, 기존 OFD `/readyz` HTTP 200. 배포된 `index-1qZmRkjh.js`에서 새 현황판과 API 연결을 확인했다. 배포 이후 ODA API·웹 오류 로그는 없었다.
- 기존 OFD 소스·설정, 공용 DB 계정 분리와 ODA 최초 마스터 등록 방식은 이번 배포에서 변경하지 않았다.

## 매장별 엑셀 양식 공유 적용 결과 — 2026-09-15 UTC

- 앱 소스 `457bab4395d7e8692647069432f93229df14aeea`, API 배포 `dep-dak8qo0u01pc73e8cg2g`, 웹 배포 `dep-dak8rk942hec739m7ccg`가 모두 live다.
- 정상 반영한 XLSX의 열 제목 행·시트·열 연결을 ODA 전용 DB의 `oda_import_profile`에 매장·종류·출처별로 저장한다. 다른 PC에서도 재사용하며 원본 파일 내용·거래 금액은 설정에 복제하지 않는다. DB 구조 변경 없이 기존 매장 범위 제약을 사용한다.
- 실제 열 제목과 순서가 일치할 때만 저장한 연결을 적용한다. 미리보기와 직접 반영 절차를 유지하며, 오류·중복·월 저장 실패 시 양식 변경도 취소된다. 초기화는 버전 충돌과 중복 요청을 검사하고 변경 기록을 남긴다. 서버에서 초기화한 양식을 오래된 브라우저 설정으로 복원하지 않는다.
- [GitHub 검사 34911988395](https://github.com/roybeee/OFD/actions/runs/34911988395)의 quality·E2E가 모두 성공했다. 실제 CI PostgreSQL에서 새 저장 유형·매장 격리·트랜잭션 롤백을 검증했다. 로컬 ODA API 86개·웹 54개 검사와 ODA 빌드도 통과했다. 선택적 ODA 네이티브 통합 검사 1개는 별도로 건너뛰었다.
- 외부 확인: ODA `/`·`/hq/oda-master`·`/readyz` HTTP 200, readiness `ok=true`. 실제 제공된 `index-Cc35AttS.js`에서 새 공유 설정 안내·API 경로·재시도 버튼을 확인했다. 비로그인 설정 조회는 401, 기존 OFD `/readyz`는 HTTP 200·`ok=true`다. API live 이후 조회한 ODA API·웹 오류 로그는 없었다.
- 기존 OFD 서비스·환경설정·main·GitHub workflow는 변경하지 않았다. 운영 DB에 가짜 매장이나 테스트 정산을 만들지 않았으며, 로그인한 실제 사용자 기기에서의 사용 확인은 자동 테스트·배포 확인과 구분한다.

## 반복 비용 선택·증빙 확인 적용 결과 — 2026-09-15 UTC

- 최종 앱 소스 `70c552ba37c3f0695a9a2a2caa916516a05e47d8`, API 배포 `dep-dak9d17qj5pc73aampjg`, 웹 배포 `dep-dak9e0uk1f9s73cfssrg`가 모두 live다.
- **월 정산 → 거래·증빙 → 지난달 비용 미리보기**에서 바로 지난달 확정·지급 정산의 임차료·인건비·관리비를 선택한다. 지난달이 없거나 미확정이면 오래전 자료로 대신 채우지 않는다. 미리보기는 조회만 하며 원본 bytes를 응답에 포함하지 않는다.
- 이미 가져온 비용은 재추가를 막고, 이번 달 비용과 분류·내용 또는 금액이 비슷하면 참고 거래를 표시해 기본 선택에서 뺀다. 별도 비용으로 직접 선택한 항목만 추가할 수 있다. 당월·전월 버전과 선택 항목을 서버에서 다시 검사하며 오류 시 일부만 저장하지 않는다.
- 새 항목은 확인 대기로 추가하며 손익 합산을 보류한다. 전월 증빙·통장 연결을 복제하지 않는다. 당월 증빙이 없는 반복 비용은 UI의 확인 완료 버튼을 비활성화하고 서버 요청도 422로 거절한다. 실제 당월 증빙을 연결한 뒤 확인하면 설정된 부가세 기준으로 손익에 반영한다.
- [최종 GitHub 검사 34914694457](https://github.com/roybeee/OFD/actions/runs/34914694457)의 quality·E2E가 모두 성공했다. 기본 선택·유사 비용 확인·페이지 간 선택 유지·늦은 응답 차단·양월 버전 충돌·원자적 취소·증빙 없는 확인 거절과 증빙 연결 후 손익 반영을 검사했다. 로컬 ODA 전체 검사와 빌드, 보강분 관련 API 22개·화면 16개 검사도 통과했다. 선택적 ODA 네이티브 통합 검사 1개는 별도로 건너뛰었다.
- 외부 확인: ODA `/`·`/hq/oda-master`·`/readyz` HTTP 200, readiness `ok=true`. 실제 `index-CmrAcprr.js`에 미리보기·선택 반영·증빙 확인 안내와 API 연결이 포함됐다. 비로그인 미리보기 API는 401, OFD `/readyz`는 200·`ok=true`다. 최종 API live 이후 조회한 ODA API·웹 오류 로그는 없었다.
- 기존 OFD 서비스·설정·main·GitHub workflow와 DB 계정 분리는 변경하지 않았다. 운영 DB에 테스트 매장·계정·정산을 만들지 않았으며 실제 운영자 로그인 후 실기기 사용 검증과 자동 검사는 구분한다.


## 비용 통합 관리·증빙 전달 묶음 적용 결과 — 2026-09-15 UTC

- 앱 소스 `aaea0ff637d451c377813af49ef24c03edc3d160`, API 배포 `dep-dak9q4lg1s2s73bi2hgg`, 웹 배포 `dep-dak9r4h5efls73d7vsk0`가 모두 live다.
- **마스터 홈 → 비용 관리** 또는 **월 정산 → 비용 관리**에서 비용·증빙을 한 화면에서 관리한다. 비용 입력·파일 업로드·반복 비용 선택·검색·누락 필터·상세 수정과 원본 다운로드가 같은 월 정산 원장을 사용한다. 사업자 정보가 비어 있는 기본 작업공간에서도 기존 역할 권한대로 사용할 수 있다.
- 비용 목록에서 50개씩 보고 최대 200건의 분류·증빙 연결·확인을 한 번에 저장한다. 권한·월 잠금·버전·선택 오류는 전부 취소하며 기존 원본 연결과 수입 행을 보호한다. 확인 완료로 생성·수정하는 운영비에는 당월 증빙이 필요하다. 일괄 확인은 선택 항목의 분류·필요 부가세·중복 등도 검사한다. 변경 전후 거래와 담당자가 기존 감사 기록에 남는다.
- 비용·증빙 ZIP에는 운영비 등록, 손익 제외, 증빙 목록 CSV와 관련 원본을 담는다. 미확인 부가세는 빈칸, 반복 제안은 손익 미반영으로 표시한다. 확정본 우선, 권한 범위, 원본 해시·크기, CSV 수식 방지, 한글 파일명·CRC·원본 바이트 보존을 검증했다. 미연결 자료와 누락·검증 실패도 목록에서 구별한다. 자동 외부 전송이나 세무 판단은 수행하지 않는다.
- [GitHub 검사 34916582069](https://github.com/roybeee/OFD/actions/runs/34916582069)의 quality·E2E가 모두 성공했다. 로컬 API ODA 검사 110개와 웹 검사 74개, ODA 빌드가 통과했다. 선택적 ODA 네이티브 PostgreSQL 검사 1개는 별도로 건너뛰며 통과 수에 포함하지 않았다. ZIP은 Python으로도 CRC·한글 경로·원본 바이트를 확인했다.
- 외부 확인: ODA `/`·`/hq/oda-settlement?tab=expenses`·`/readyz` HTTP 200, readiness `ok=true`. 실제 제공된 `index-C9hkNPEn.js`에서 새 비용 화면·일괄 저장·ZIP 연결을 확인했다. 비로그인 ZIP 요청은 401, OFD `/readyz`는 200·`ok=true`다. API live 이후 조회한 ODA API·웹 오류 로그는 없었다.
- 기존 OFD 서비스·설정·main·GitHub workflow와 DB 계정 분리를 유지했다. 운영 DB에 테스트 매장·계정·거래를 생성하지 않았다. React/API 자동 검증과 운영 배포·HTTP 확인을 수행했으며, 로그인 후 실제 사용자 기기의 화면 검증은 수행하지 않았다. 로컬 브라우저의 localhost 접근 차단으로 모바일 화면 캡처도 확인하지 못했다.

## 매장별 비용 분류 기억 적용 결과 — 2026-09-15 UTC

- 최종 앱 소스 `eb5f22aee1e8dc4e1849970ace10952c4c47f9e9`, API 배포 `dep-daka73uk1f9s73ciond0`와 웹 배포 `dep-daka88dg1s2s73bjj2r0`가 모두 live다. 웹 전환 시각은 01:51 UTC다.
- **월 정산 → 비용 관리**에서 비용을 선택하고 분류를 지정할 때 **다음에도 같은 거래 내용은 이 분류로 기억**을 선택한다. 같은 매장의 이후 CSV·Excel 가져오기에서 정규화한 전체 거래 내용이 일치하는 비용에 적용한다. 원본에 명시된 분류와 계약상 제외 항목을 우선하며 금액·부가세·증빙을 추측하거나 확인 완료로 바꾸지 않는다.
- 같은 화면에서 기억한 분류를 조회·검색·삭제한다. 이전 거래는 소급 수정하지 않는다. 거래 상세와 CSV·Excel·세무사 전달 ZIP에 적용 근거가 남는다. 매장별 저장·권한·버전 검사와 일괄 비용 변경의 원자적 저장을 적용했다.
- 미리보기 이후 기억한 분류가 바뀌면 저장을 거절하고 **미리보기 새로고침**으로 다시 확인한다. 이전 웹을 열어 둔 기기는 미리보기와 저장 모두 기존 분류 방식을 사용해 보지 못한 분류가 저장 시 적용되지 않는다.
- [GitHub 검사 34918442921](https://github.com/roybeee/OFD/actions/runs/34918442921)의 quality·E2E가 모두 성공했다. 로컬 도메인 67개, 관련 API 127개, ODA 웹 79개 검사와 빌드가 통과했다. 후속 보강은 비용 화면 14개, 호환성 API 7개와 클라이언트·정산 화면 24개 검사로 확인했다. 이 수는 중복 실행을 포함하므로 합산하지 않는다. 선택적 ODA 네이티브 검사 1개는 건너뛰었다.
- 외부 확인: ODA `/`·비용 관리 페이지·`/readyz` HTTP 200, readiness `ok=true`. 실제 제공된 `index-7f0NXiBv.js`에서 분류 기억·관리·미리보기 갱신 및 호환성 옵션을 확인했다. 비로그인 분류 조회는 401, OFD `/readyz`는 200·`ok=true`다. 최종 API live 이후 조회한 ODA API·웹 오류 로그는 없었다.
- 기존 OFD 서비스·설정·main·GitHub workflow 및 DB 계정 분리는 유지했다. 운영 테스트 데이터를 만들지 않았다. 자동 기능 검사와 실제 배포·HTTP 확인을 수행했으며, 운영 계정 로그인 후 실기기 화면 검증은 수행하지 않았다.
# 채널별 POS 배달매출 설정 (2026-09-15)

- 정산 기준의 배달매출 포함 여부를 배달의민족·쿠팡이츠·요기요·땡겨요별로 설정한다. 운영 채널을 선택하고 각 채널의 POS 포함·별도 합산·확인 필요를 구분한다.
- `posDeliveryScopes`가 있으면 채널별 설정으로 플랫폼 매출만 중복 제외한다. POS 원본 행과 플랫폼 수수료·환불 부호·지급예정액은 보존한다. 미확인인 운영 채널은 확정을 막는다.
- 기존 필드 `posDeliveryScope`만 있는 저장본은 종전 방식으로 계산한다. 새 화면에서 저장할 때 기존 3개 채널의 선택을 이어받으며, 새 땡겨요 채널은 확인 필요로 시작한다. 기존 확정본을 일괄 변경하지 않는다.
- 새 설정은 월 저장·다음 달 기준·확정 보관본·CSV/XLSX 정산서에 포함된다. 기준 변경 시 A/B 확인을 해제한다. 채널별 설정을 누락한 구버전 화면의 저장은 409로 차단한다.
- 로컬 검증: `npm run test:oda` 280개 통과, 환경이 필요한 선택적 PostgreSQL 통합 검사 1개 제외. API와 웹 프로덕션 빌드 통과. 배포는 API 지원 반영 후 웹을 순서대로 진행해야 한다.
