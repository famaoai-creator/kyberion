import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import {
  formatThreadWorkStatus,
  isThreadStatusQuery,
  readThreadWork,
  recordThreadWork,
  resolveThreadWorkStatus,
  threadWorkLogicalPath,
} from './thread-work-index.js';

const created: string[] = [];

function ref() {
  const channel = `CTEST${randomUUID().slice(0, 8)}`;
  const value = { surface: 'slack', channel, threadTs: '1700000000.000100' };
  created.push(threadWorkLogicalPath(value));
  return value;
}

describe('thread-work-index', () => {
  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const logical of created.splice(0)) {
        const file = pathResolver.rootResolve(logical);
        if (safeExistsSync(file)) safeRmSync(file, { force: true });
      }
    });
  });

  it('records missions per thread idempotently and keeps the tenant', () => {
    const thread = ref();
    recordThreadWork(
      thread,
      { kind: 'mission', id: 'MSN-A', confirmed_by: 'user:lead' },
      {
        tenantSlug: 'acme',
      }
    );
    recordThreadWork(thread, { kind: 'mission', id: 'MSN-B' }, { tenantSlug: 'acme' });
    recordThreadWork(
      thread,
      { kind: 'mission', id: 'MSN-A', confirmed_by: 'user:lead' },
      { tenantSlug: 'acme' }
    );
    const index = readThreadWork(thread);
    expect(index?.tenant_slug).toBe('acme');
    expect(index?.entries.map((entry) => entry.id)).toEqual(['MSN-B', 'MSN-A']);
    expect(readThreadWork({ ...thread, threadTs: '1700000000.999999' })).toBeNull();
  });

  it('refuses surfaces without a writer', () => {
    expect(() =>
      recordThreadWork(
        { surface: 'discord', channel: 'C1', threadTs: '1' },
        { kind: 'mission', id: 'X' }
      )
    ).toThrow(/no thread-work writer/);
  });

  it('reads live status and formats it', () => {
    const thread = ref();
    recordThreadWork(thread, { kind: 'mission', id: 'MSN-A', confirmed_by: 'user:lead' });
    const statuses = resolveThreadWorkStatus(readThreadWork(thread), (id) =>
      id === 'MSN-A' ? 'active' : undefined
    );
    expect(statuses).toMatchObject([{ id: 'MSN-A', status: 'active' }]);
    const text = formatThreadWorkStatus(statuses, 'en');
    expect(text).toContain('MSN-A');
    expect(text).toContain('user:lead');
    expect(formatThreadWorkStatus([], 'en')).toMatch(/No missions/);
  });

  it.each([
    ['status?', true],
    ['状況は？', true],
    ['進捗どう', true],
    ['How is it going?', true],
    ['status of the release notes draft', false],
    ['このバグの状況を調べて修正して', false],
  ])('detects status queries: %s', (text, expected) => {
    expect(isThreadStatusQuery(text)).toBe(expected);
  });
});
