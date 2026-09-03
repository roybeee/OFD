import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* 브랜드 디자인 시스템(788ab54)이 --muted-2를 4.26:1로 내렸는데, e2e의 axe 검사가 3주간(audit 실패에 가려) 돌지 않아
 * 아무도 몰랐다. 텍스트 토큰 × 배경 토큰 조합을 여기서 몇 ms에 잡는다. */

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function rootTokens() {
  const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  return Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

describe('디자인 토큰 대비(WCAG 2 AA)', () => {
  const tokens = rootTokens();
  const textTokens = ['ink', 'muted', 'muted-2'];
  const surfaceTokens = ['panel', 'canvas', 'orange-pale', 'orange-soft', 'green-soft', 'red-soft', 'blue-soft'];

  it('본문·보조 텍스트 토큰은 모든 배경 토큰 위에서 4.5:1 이상이다', () => {
    const failures: string[] = [];
    for (const text of textTokens) {
      for (const surface of [...surfaceTokens.map((s) => tokens[s]), '#ffffff']) {
        const ratio = contrast(tokens[text]!, surface!);
        if (ratio < 4.5) failures.push(`--${text} ${tokens[text]} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('토큰이 빠지면 검사가 조용히 통과하지 않는다', () => {
    for (const name of [...textTokens, ...surfaceTokens]) expect(tokens[name], `--${name}`).toMatch(/^#[0-9a-f]{6}$/);
  });
});
