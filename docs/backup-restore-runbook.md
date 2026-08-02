# 백업·복구 운영 런북

목표는 PostgreSQL `RPO ≤ 15분`, 핵심 업무 `RTO ≤ 2시간`이다. 목표 달성 여부는
문서가 아니라 월별 격리 복구 훈련으로 증명한다.

## 백업 정책

### PostgreSQL

- 관리형 PostgreSQL PITR/WAL 보존: 최소 14일
- 일 1회 논리 백업(`pg_dump` custom format), 35일 보존
- 월말 잠금 직후 백업: 세무 보존정책에 맞춘 별도 immutable 보관
- 모든 백업: KMS 암호화, 운영 DB와 다른 권한 경계, SHA-256 checksum
- 환경변수/Popbill secret/인증서 private material은 DB 백업에 넣지 않는다.

`infra/scripts/backup-postgres.sh`는 소유자/권한을 제외한 custom-format 백업과 checksum을
만든다. 스케줄러는 성공 로그만 믿지 말고 파일 크기, checksum, 최근 생성시각을
감시한다.

### S3

- versioning, SSE-KMS, public access block 필수
- 배송사진·문서에 적합한 수명주기/보존 정책 적용
- 다른 계정 또는 별도 복구 버킷으로 복제 권장
- `infra/scripts/verify-s3-controls.sh`로 versioning/암호화/public block을 확인

## 월별 격리 복구 훈련

1. 복구 담당자와 검증 담당자를 서로 다르게 지정하고 incident/change 번호를 만든다.
2. 운영 네트워크와 분리된 빈 PostgreSQL DB와 private 복구 bucket을 준비한다.
3. 선택한 백업의 checksum과 KMS 접근을 검증한다.
4. 빈 DB인지 확인한 후에만 다음처럼 복원한다.

```bash
RESTORE_TARGET_DATABASE_URL='postgresql://...' \
RESTORE_FILE='/secure/path/ofd-v2-YYYYMMDDTHHMMSSZ.dump' \
RESTORE_CONFIRM='RESTORE_OFD_V2_TO_EMPTY_DATABASE' \
infra/scripts/restore-postgres.sh
```

스크립트는 non-empty DB를 거부하며 `--clean`을 사용하지 않는다.

5. 복구 환경에서 outbound network와 worker를 끈다. Popbill/SMS/이메일은 반드시 mock이다.
6. migration 버전, table/row count, FK, 감사원장 hash/연속성, 주문→배송→수취→정산→계산서
   금액 합계를 검증한다.
7. 임의 표본 30건과 월말 2개 매장의 공급가액/VAT를 원본 리포트와 대조한다.
8. S3 object key/checksum 표본과 DB document reference가 일치하는지 검증한다.
9. 실제 RPO/RTO, 실패 단계, 보완 담당자/기한을 기록하고 복구 환경을 승인 절차로 폐기한다.

## 장애 복구 선택

| 상황 | 복구 방식 | 금지 사항 |
| --- | --- | --- |
| 단일 레코드 오작동 | append-only 정정/반품/수정계산서 | 운영 DB에 수동 UPDATE/DELETE |
| 앱 배포 장애 | 이전 이미지 + 전진 수정 migration | 이미 발행된 문서 삭제 |
| DB 논리 손상 | 사고 직전 PITR을 격리 복구 후 검증·전환 | 손상 DB 위 덮어쓰기 |
| 리전 장애 | 복제 DB/S3 복구 환경으로 전환 | DNS 전환 전 외부 worker 이중 실행 |
| S3 객체 삭제 | version ID로 복원 | 동일 key에 추적 없는 덮어쓰기 |

## 운영 전환 체크리스트

- [ ] 격리 복구 환경에서 무외부호출 확인
- [ ] DB migration 버전 일치
- [ ] 원장/정산/세금 합계 대사 차이 0원
- [ ] outbox/inbox 중복·처리상태 확인
- [ ] S3 object 표본과 checksum 일치
- [ ] 세션·암호화·provider secret 별도 재주입
- [ ] worker 단일 인스턴스부터 시작하고 backlog 관찰
- [ ] 재개 승인자 2인과 실제 RPO/RTO 기록

복구 훈련 실패는 파일럿 전체전환 `NO_GO` 조건이다.
