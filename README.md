# OFD 프랜차이즈 워크스테이션

올드페리도넛(OFD) 가맹 사업 운영을 위한 통합 워크스테이션.
가맹 영업 파이프라인(가맹사업법 제7조③ 숙려기간 서버 강제) · 발주 · 매출 마감 · 토스플레이스 POS 자동 수집 · 매장별 매출 분석 · 정산 · 부서별 계정(RBAC) · 감사 로그.

## 구성

| 경로 | 내용 |
|---|---|
| `server/` | **서버판 v3** — 의존성 0개 Node.js 백엔드 + SPA. 인증·권한·숙려기간·감사를 서버가 강제 |
| `pilot/` | 아티팩트 파일럿판(단일 HTML) — 서버 없이 브라우저 공유 저장소로 동작하는 초기 검증용 |

## 빠른 시작 (Windows)

1. [Node.js LTS](https://nodejs.org) 설치 (최초 1회)
2. `server/실행하기.bat` 더블클릭 → 브라우저가 `http://localhost:8787` 로 열림
3. 초기 설정에서 마스터 계정 생성

배포(HTTPS·systemd·Docker)·토스플레이스 연동·계정 권한 매트릭스는 [`server/README.md`](server/README.md) 참고.

## 검증

```bash
cd server && node --no-warnings test/integration.js   # 통합 테스트 95건
```
