// Build-time dependency only. No contract data or runtime request reaches Google.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const target = fileURLToPath(new URL('../../apps/api/assets/fonts/NanumGothic-Regular.ttf', import.meta.url));
const expected = '76f45ef4a6bcff344c837c95a7dcc26e017e38b5846d5ae0cdcb5b86be2e2d31';
const source = 'https://raw.githubusercontent.com/google/fonts/16680f8688ffcd467d2eb2146a9ce0343404581d/ofl/nanumgothic/NanumGothic-Regular.ttf';
const matches = bytes => createHash('sha256').update(bytes).digest('hex') === expected;
let cached;
try { cached = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (cached && matches(cached)) {
  console.log('Contract PDF font: verified cached asset.');
} else {
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Contract PDF font download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!matches(bytes)) throw new Error('Contract PDF font checksum mismatch; refusing build');
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try { await writeFile(temporary, bytes); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  console.log('Contract PDF font: downloaded pinned asset and verified SHA-256.');
}
