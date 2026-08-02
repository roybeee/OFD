# V2 E2E

`npm run e2e`는 Vite를 명시적 데모 모드로 시작하고 다음 실제 화면을 검증·촬영한다.

- 본사 주문 운영 1440px
- 점주 발주·입고 360px
- 기사 오늘 배송 360px

각 화면은 고정 test id, 단일 `main` landmark, 키보드 초점, WCAG 2 A/AA의
critical/serious 위반 0건, 모바일 수평 오버플로 0을 검사한다. 스크린샷은
`test-results/e2e/**`에 생성되어 병합 전 실화면 검토 자료로 사용된다.

안전 회귀 시나리오는 데모 역할 전환 제한, 주문/배송 다이얼로그의 초점 가두기와
Escape·초점 복원, 열린 모바일 드로어 오버플로, 후보가 모호한 입금의 수동 연결
차단, 배송 증빙 파일 형식·용량 검증까지 확인한다.

이미 실행 중인 배포를 검사하려면 다음처럼 지정한다.

```bash
E2E_BASE_URL=https://preview.example.kr npm run e2e
```
