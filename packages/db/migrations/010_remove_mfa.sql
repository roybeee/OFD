-- 010: MFA(TOTP) 제거 — 로그인·스텝업을 비밀번호 전용으로 전환하면서 저장된 인증코드를 초기화(제거)한다.
-- 자격정보 스냅샷에서 mfaSecretEncrypted 키를 지운다. 남아 있어도 코드가 더는 읽지 않지만,
-- 민감정보를 남겨둘 이유가 없으므로 원장에서 정리한다. version은 그대로 두어 낙관적 잠금과 무관하게 둔다.
UPDATE aggregate_snapshots
SET payload = payload - 'mfaSecretEncrypted', updated_at = now()
WHERE aggregate_type = 'credential' AND payload ? 'mfaSecretEncrypted';
