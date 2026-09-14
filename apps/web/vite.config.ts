import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  define: { 'import.meta.env.VITE_WORKSTATION_BRAND': JSON.stringify(mode === 'oda' ? 'oda' : 'ofd') },
  plugins: [react(), {
    name: 'oda-brand-metadata',
    closeBundle() {
      if (mode !== 'oda') return;
      for (const file of ['design-archive','ofd-logo.png','ofd-mark.svg','login-intro.mp4','login-intro-portrait.mp4','manifest.webmanifest'])
        rmSync(resolve(import.meta.dirname, 'dist', file), { recursive: true, force: true });
    },
    transformIndexHtml(html) {
      if (mode !== 'oda') return html;
      return html.replaceAll('OFD', 'ODA')
        .replaceAll('ofd-mark.svg', 'oda-mark.svg')
        .replaceAll('icon-192.png', 'oda-icon-192.png')
        .replaceAll('apple-touch-icon.png', 'oda-apple-touch-icon.png')
        .replaceAll('manifest.webmanifest', 'oda.webmanifest')
        .replace('#f76822', '#b93825')
        .replace('발주부터 입고, 정산, 세금계산서까지 이어지는 통합 운영 워크스테이션', '매장 운영과 계약 기반 월 손익·이익배분 정산');
    },
  }],
  server: {
    port: 5173,
    proxy: {
      '/api/v2': 'http://127.0.0.1:4100',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
}));
