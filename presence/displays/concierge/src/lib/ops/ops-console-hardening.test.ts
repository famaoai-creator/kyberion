import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const CONCIERGE = 'presence/displays/concierge';
const read = (relative: string) =>
  String(safeReadFile(pathResolver.rootResolve(`${CONCIERGE}/${relative}`), { encoding: 'utf8' }));

describe('operations console hardening', () => {
  it('stops the console runtime even when closing the listener fails (L6)', () => {
    const source = read('server/local-server.ts');
    const finallyAt = source.indexOf('} finally {');
    const stopAt = source.indexOf('await stopOpsConsoleRuntime();');
    expect(finallyAt).toBeGreaterThan(0);
    expect(stopAt).toBeGreaterThan(finallyAt);
  });

  it('never prints agent spawn options to stdout (L7)', () => {
    const source = read('src/app/api/ops/agent/route.ts');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('CHRONOS_DEBUG');
  });

  it('forbids framing /ops by other origins and frames only same-origin documents (L8)', async () => {
    const { default: config } = (await import(
      pathToFileURL(pathResolver.rootResolve(`${CONCIERGE}/next.config.mjs`)).href
    )) as {
      default: {
        headers: () => Promise<
          Array<{ source: string; headers: Array<{ key: string; value: string }> }>
        >;
      };
    };
    const rules = await config.headers();
    for (const source of ['/ops', '/ops/:path*']) {
      const csp = rules
        .find((rule) => rule.source === source)
        ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
      expect(csp, source).toContain("frame-ancestors 'self'");
      expect(csp, source).toContain("frame-src 'self'");
    }
    // API routes keep their own policies (the plugin view frame sets a sandbox CSP).
    expect(rules.some((rule) => rule.source.startsWith('/api'))).toBe(false);
  });
});
