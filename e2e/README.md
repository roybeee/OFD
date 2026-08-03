# V2 E2E

`npm run e2e`는 임시 SQLite 데이터베이스에서 기존 OFD 세션과 V2 실운영 API를
함께 기동합니다. 테스트가 만드는 `화면검증 …` 매장·상품·발주는 이 임시 DB에만
존재하며 애플리케이션 번들이나 운영 DB에는 포함되지 않습니다.

검증 범위:

- 본사 실제 주문 운영 화면(1920px)과 점주 실제 발주 화면(390px)
- 기존 워크스테이션 홈으로 돌아가는 통합 내비게이션
- PC 본문·보조문·버튼의 최소 글자 크기
- WCAG A/AA 중 critical/serious 위반 및 수평 오버플로
- 점주 발주 창과 본사 검토 drawer의 초점 가두기, Escape, 초점 복원
- 익명 V2 API 차단과 production SQLite bootstrap

스크린샷은 `test-results/e2e/**`에 생성되어 병합 전 실화면 검토 자료로 사용됩니다.

외부 주소 검증은 QA 레코드를 생성하므로 격리된 QA 배포에서만 명시적으로 허용합니다.

```bash
E2E_ALLOW_WRITES=qa \
E2E_BASE_URL=https://qa.example.kr \
E2E_API_BASE=https://qa.example.kr \
E2E_HQ_USERNAME=qa-e2e-master \
E2E_HQ_PASSWORD='사전에-발급한-비밀번호' \
E2E_QA_TOKEN='QA-서버와-공유한-임의토큰' \
npm run e2e
```

외부 QA에서는 초기 설정이나 고정 비밀번호 계정을 자동 생성하지 않습니다. 위 계정은
테스트 전용 QA 원장에 미리 발급해야 하며, 화면 주소와 API 주소는 같은 origin이어야 합니다.
QA 서버에도 `E2E_QA_MODE=1`과 같은 `E2E_QA_TOKEN`을 설정해야 쓰기 전 사전 검증이
통과합니다. 운영 주소 `ofd-workstation.onrender.com`은 설정과 무관하게 차단됩니다.
