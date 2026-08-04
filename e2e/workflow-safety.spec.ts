import { expect, test } from '@playwright/test';
import { assertSafeE2eTarget } from './target-safety';

test('production and ambiguous external URLs can never become E2E write targets', () => {
  expect(() => assertSafeE2eTarget('https://ofd-workstation.onrender.com', 'qa')).toThrow(/forbidden/i);
  expect(() => assertSafeE2eTarget('https://workstation.example.com', 'qa')).toThrow(/forbidden/i);
  expect(() => assertSafeE2eTarget('https://qa.ofd.example.com', undefined)).toThrow(/E2E_ALLOW_WRITES/);
  expect(assertSafeE2eTarget('https://qa.ofd.example.com', 'qa').hostname).toBe('qa.ofd.example.com');
  expect(assertSafeE2eTarget('http://127.0.0.1:5173', undefined).hostname).toBe('127.0.0.1');
});
