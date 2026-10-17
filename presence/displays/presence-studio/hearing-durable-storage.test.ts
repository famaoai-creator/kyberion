import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync, safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { createHearingRecord } from './hearing.js';
import {
  loadHearingRecord,
  saveHearingRecord,
  updateHearingRecord,
  loadHearingCanvasVersion,
  hearingNamespace,
} from './hearing-runtime.js';

const migrationFault = vi.hoisted(() => ({ phase: '' as '' | 'canvas' | 'record' | 'publish' }));
vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeWriteFile: (...args: Parameters<typeof actual.safeWriteFile>) => {
      if (
        String(args[0]).includes('.migration-') &&
        ((migrationFault.phase === 'canvas' && String(args[0]).endsWith('.html')) ||
          (migrationFault.phase === 'record' && String(args[0]).endsWith('.json')))
      )
        throw new Error('Injected migration failure');
      return actual.safeWriteFile(...args);
    },
    safeMoveSync: (...args: Parameters<typeof actual.safeMoveSync>) => {
      if (migrationFault.phase === 'publish' && String(args[0]).includes('.migration-'))
        throw new Error('Injected migration publish failure');
      return actual.safeMoveSync(...args);
    },
  };
});
const tenant = 'zz-hearing-durable';
const sessions: string[] = [];
function paths(session: string) {
  const root = pathResolver.rootResolve(
    'active/shared/runtime/hearing/confidential/' + tenant + '/' + tenant + '/' + session
  );
  return {
    root,
    file: root + '/' + session + '.json',
    legacy: pathResolver.sharedTmp('hearing/' + tenant + '/' + session + '.json'),
  };
}
afterEach(() => {
  migrationFault.phase = '';
  for (const session of sessions.splice(0)) {
    const p = paths(session);
    safeRmSync(p.root, { recursive: true, force: true });
    safeRmSync(p.legacy, { force: true });
    safeRmSync(p.legacy.replace(/\.json$/u, '.v1.html'), { force: true });
  }
});
describe('durable hearing storage', () => {
  it('writes durable state and never falls back to stale temporary state', () => {
    const session = 'receipt-' + randomUUID();
    sessions.push(session);
    const record = createHearingRecord(session, '2026-10-17T00:00:00.000Z');
    saveHearingRecord(tenant, record);
    expect(safeExistsSync(paths(session).file)).toBe(true);
    safeWriteFile(paths(session).legacy, JSON.stringify({ ...record, scenario: 'obsolete' }));
    expect(loadHearingRecord(tenant, session)?.scenario).toBe(record.scenario);
    safeRmSync(paths(session).file, { force: true });
    expect(() => loadHearingRecord(tenant, session)).toThrow();
  });
  it('reads legacy state without migrating on GET-like reads', () => {
    const session = 'legacy-' + randomUUID();
    sessions.push(session);
    const record = createHearingRecord(session, '2026-10-17T00:00:00.000Z');
    safeWriteFile(paths(session).legacy, JSON.stringify(record));
    expect(loadHearingRecord(tenant, session)?.session_id).toBe(session);
    expect(safeExistsSync(paths(session).root)).toBe(false);
    saveHearingRecord(tenant, record);
    expect(safeExistsSync(paths(session).file)).toBe(true);
  });
  it.each(['canvas', 'record', 'publish'] as const)(
    'failed %s migration leaves legacy authoritative and can be retried explicitly',
    (phase) => {
      const session = 'migration-' + randomUUID();
      sessions.push(session);
      const record = {
        ...createHearingRecord(session, '2026-10-17T00:00:00.000Z'),
        canvas_versions: ['v1'],
      };
      safeWriteFile(paths(session).legacy, JSON.stringify(record));
      const canvas = paths(session).legacy.replace(/\.json$/u, '.v1.html');
      safeWriteFile(canvas, '<html>legacy</html>');
      migrationFault.phase = phase;
      expect(() => saveHearingRecord(tenant, record)).toThrow('Injected migration');
      expect(safeExistsSync(paths(session).root)).toBe(false);
      expect(loadHearingRecord(tenant, session)).toEqual(record);
      migrationFault.phase = '';
      saveHearingRecord(tenant, record);
      safeRmSync(paths(session).legacy, { force: true });
      safeRmSync(canvas, { force: true });
      expect(loadHearingRecord(tenant, session)?.record_revision).toBe(1);
      expect(loadHearingCanvasVersion(tenant, session, 'v1')).toBe('<html>legacy</html>');
    }
  );
  it('background writes cannot migrate legacy state', () => {
    const session = 'background-' + randomUUID();
    sessions.push(session);
    const record = createHearingRecord(session, '2026-10-17T00:00:00.000Z');
    safeWriteFile(paths(session).legacy, JSON.stringify(record));
    expect(() =>
      updateHearingRecord(tenant, session, (current) => ({ ...current!, updated_at: 'later' }))
    ).toThrow('migration_required');
    expect(safeExistsSync(paths(session).root)).toBe(false);
    expect(loadHearingRecord(tenant, session)).toEqual(record);
  });
  it('canonical corruption cannot fall back to legacy state or legacy canvas', () => {
    const session = 'corrupt-' + randomUUID();
    sessions.push(session);
    const record = createHearingRecord(session, '2026-10-17T00:00:00.000Z');
    saveHearingRecord(tenant, record);
    safeWriteFile(paths(session).legacy, JSON.stringify(record));
    safeWriteFile(paths(session).legacy.replace(/\.json$/u, '.v1.html'), '<html>stale</html>');
    safeWriteFile(paths(session).file, '{broken');
    expect(() => loadHearingRecord(tenant, session)).toThrow();
    expect(loadHearingCanvasVersion(tenant, session, 'v1')).toBeNull();
    expect(String(safeReadFile(paths(session).file, { encoding: 'utf8' }))).toBe('{broken');
  });
  it('rejects ambiguous tenant sentinels instead of mapping tenants into personal storage', () => {
    expect(hearingNamespace('all')).toBe('all');
    expect(hearingNamespace([])).toBe('unscoped');
    expect(() => hearingNamespace(['all'])).toThrow('AMBIGUOUS');
    expect(() => hearingNamespace(['unscoped'])).toThrow('AMBIGUOUS');
    expect(() => hearingNamespace(['alpha', 'bravo'])).toThrow('AMBIGUOUS');
  });
});
