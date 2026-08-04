export function assertSafeE2eTarget(rawUrl: string, allowWrites: string | undefined): URL {
  const target = new URL(rawUrl);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
  if (loopback) return target;
  if (allowWrites !== 'qa') throw new Error('External E2E writes require E2E_ALLOW_WRITES=qa.');
  if (target.protocol !== 'https:') throw new Error('External E2E requires HTTPS.');
  const hostname = target.hostname.toLowerCase();
  const productionNames = ['ofd-workstation.onrender.com', 'ofd.example.kr', 'workstation.ofd.kr'];
  if (productionNames.includes(hostname) || !/(?:^|[.-])(qa|staging|test)(?:[.-]|$)/.test(hostname)) {
    throw new Error(`E2E writes are forbidden for non-QA target: ${hostname}`);
  }
  return target;
}
