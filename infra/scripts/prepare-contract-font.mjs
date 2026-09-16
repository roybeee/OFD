// Build-time dependency only. No contract data or runtime request reaches the font host.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const target = fileURLToPath(new URL('../../apps/api/assets/fonts/NotoSansCJKkr-Regular.otf', import.meta.url));
const expected = '6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a';
const source = 'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf';
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
