import * as path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

const sourceRoot = rootDir();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp/ops-alert-fresh-' + process.pid);
const savedRoot = process.env.KYBERION_ROOT;
let io: typeof import('./secure-io.js');
let authority: typeof import('./authority.js');
let alerts: typeof import('./ops-alert-log.js');
const store = path.join(fixtureRoot, 'active/shared/observability/ops-alerts.jsonl');

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(fixtureRoot, 'package.json'), '{"name":"ops-alert-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(sourceRoot, relative))) {
        const file = path.join(relative, name);
        const source = path.join(sourceRoot, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(fixtureRoot, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
  });
  process.env.KYBERION_ROOT = fixtureRoot;
  vi.resetModules();
  io = await import('./secure-io.js');
  authority = await import('./authority.js');
  alerts = await import('./ops-alert-log.js');
}, 120_000);

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(fixtureRoot, { recursive: true, force: true })
  );
});

it('creates a fresh fixed alert store without granting its directory or siblings', () => {
  expect(io.safeExistsSync(path.dirname(store))).toBe(false);
  authority.withExecutionContext(
    'run_pipeline.bundle',
    () => {
      alerts.appendOpsAlertLogRecord(store, {
        ts: '2026-10-26T00:00:00.000Z',
        kind: 'ops_alert_ack',
        before: '2026-10-25T00:00:00.000Z',
        acked_count: 0,
      });
      expect(alerts.withOpsAlertFileStore(store, () => String(io.safeReadFile(store)))).toContain(
        'ops_alert_ack'
      );
      expect(() =>
        alerts.withOpsAlertFileStore(store, () =>
          io.safeWriteFile(path.join(path.dirname(store), 'arbitrary.json'), '{}')
        )
      ).toThrow(/POLICY|SECURITY/u);
      expect(() =>
        alerts.withOpsAlertFileStore(store, () =>
          io.safeMkdir(path.join(path.dirname(store), 'arbitrary-directory'))
        )
      ).toThrow(/POLICY|SECURITY/u);
    },
    'worker'
  );
});
