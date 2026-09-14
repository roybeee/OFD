/** One-time ODA provisioning on a separate, migrated PostgreSQL database. */
import { readFile } from 'node:fs/promises';
import { PostgresRepository } from '@ofd/db';
import { provisionOda } from './oda-provisioning.ts';
const configPath = process.argv[2];
if (!configPath || !process.env.DATABASE_URL) throw new Error('ODA 전용 DATABASE_URL과 설정 JSON 경로가 필요합니다.');
const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
const passwordKeys = ['ODA_MASTER_PASSWORD', 'ODA_OPERATOR_PASSWORD', 'ODA_PARTNER_PASSWORD'] as const;
const passwords = passwordKeys.map(key => { const value = process.env[key]; if (!value) throw new Error(`${key}: 초기 비밀번호가 필요합니다.`); return value; });
const repository = PostgresRepository.connect(process.env.DATABASE_URL);
try {
  await provisionOda(repository, config, passwords);
  console.log('ODA 최초 설정 완료. 관리자·A·B는 첫 로그인에서 초기 비밀번호를 변경해야 합니다.');
} finally { await repository.close(); }
