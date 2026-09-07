import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendSupervisorEvent,
  listSupervisorEventFiles,
  readSupervisorEvents,
  SUPERVISOR_EVENTS_FILE_PATTERN,
  SUPERVISOR_EVENTS_LEGACY_FILE,
} from './agent-runtime-events.js';

function fixtureDir(suffix: string): string {
  return pathResolver.sharedTmp(`agent-runtime-events-${suffix}`);
}

describe('SUPERVISOR_EVENTS_FILE_PATTERN', () => {
  it('matches a dated supervisor event file and captures its UTC date', () => {
    const match = SUPERVISOR_EVENTS_FILE_PATTERN.exec(
      'agent-runtime-supervisor-events-2026-09-06.jsonl'
    );
    expect(match?.[1]).toBe('2026-09-06');
    expect(SUPERVISOR_EVENTS_FILE_PATTERN.test(SUPERVISOR_EVENTS_LEGACY_FILE)).toBe(false);
  });
});

describe('appendSupervisorEvent (AC-10 rotation)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) safeRmSync(dir, { recursive: true, force: true });
    delete process.env.KYBERION_TEST_OBSERVABILITY_DIR;
    dir = undefined;
  });

  it('writes to a UTC-dated file instead of the legacy unrotated file', () => {
    dir = fixtureDir(randomUUID());
    process.env.KYBERION_TEST_OBSERVABILITY_DIR = dir;

    appendSupervisorEvent({ decision: 'agent_runtime_ask_completed', agent_id: 'agent-1' });

    const today = new Date().toISOString().slice(0, 10);
    const datedPath = path.join(dir, `agent-runtime-supervisor-events-${today}.jsonl`);
    expect(safeExistsSync(datedPath)).toBe(true);
    expect(safeExistsSync(path.join(dir, SUPERVISOR_EVENTS_LEGACY_FILE))).toBe(false);

    const lines = (safeReadFile(datedPath, { encoding: 'utf8' }) as string)
      .split('\n')
      .filter((line) => line.trim());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.decision).toBe('agent_runtime_ask_completed');
    expect(record.agent_id).toBe('agent-1');
    expect(typeof record.ts).toBe('string');
  });
});

describe('listSupervisorEventFiles / readSupervisorEvents', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) safeRmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeFixture(fileName: string, records: Array<Record<string, unknown>>): void {
    const filePath = path.join(dir!, fileName);
    safeWriteFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }

  it('lists the legacy file first, then dated files oldest-first', () => {
    dir = fixtureDir(randomUUID());
    safeMkdir(dir, { recursive: true });
    writeFixture(SUPERVISOR_EVENTS_LEGACY_FILE, [{ decision: 'legacy-1' }]);
    writeFixture('agent-runtime-supervisor-events-2026-09-05.jsonl', [{ decision: 'day-5' }]);
    writeFixture('agent-runtime-supervisor-events-2026-09-03.jsonl', [{ decision: 'day-3' }]);

    const files = listSupervisorEventFiles({ dir });
    expect(files.map((file) => file.date)).toEqual([null, '2026-09-03', '2026-09-05']);
  });

  it('excludes the legacy file when includeLegacy is false', () => {
    dir = fixtureDir(randomUUID());
    safeMkdir(dir, { recursive: true });
    writeFixture(SUPERVISOR_EVENTS_LEGACY_FILE, [{ decision: 'legacy-1' }]);
    writeFixture('agent-runtime-supervisor-events-2026-09-05.jsonl', [{ decision: 'day-5' }]);

    const files = listSupervisorEventFiles({ dir, includeLegacy: false });
    expect(files.map((file) => file.date)).toEqual(['2026-09-05']);
  });

  it('filters dated files by recentDays but always keeps the legacy file (history)', () => {
    dir = fixtureDir(randomUUID());
    safeMkdir(dir, { recursive: true });
    writeFixture(SUPERVISOR_EVENTS_LEGACY_FILE, [{ decision: 'legacy-1' }]);
    writeFixture('agent-runtime-supervisor-events-2026-09-06.jsonl', [{ decision: 'today' }]);
    writeFixture('agent-runtime-supervisor-events-2026-08-20.jsonl', [{ decision: 'old' }]);

    const files = listSupervisorEventFiles({ dir, recentDays: 2, now: '2026-09-06T12:00:00.000Z' });
    expect(files.map((file) => file.date)).toEqual([null, '2026-09-06']);
  });

  it('reads and merges every partition, skipping malformed lines', () => {
    dir = fixtureDir(randomUUID());
    safeMkdir(dir, { recursive: true });
    writeFixture(SUPERVISOR_EVENTS_LEGACY_FILE, [{ decision: 'legacy-1' }]);
    safeWriteFile(
      path.join(dir, 'agent-runtime-supervisor-events-2026-09-06.jsonl'),
      [JSON.stringify({ decision: 'day-6' }), 'not-json', '[]'].join('\n') + '\n'
    );

    const events = readSupervisorEvents({ dir });
    expect(events).toEqual([{ decision: 'legacy-1' }, { decision: 'day-6' }]);
  });

  it('returns an empty list when the directory does not exist', () => {
    dir = fixtureDir(randomUUID());
    expect(listSupervisorEventFiles({ dir })).toEqual([]);
    expect(readSupervisorEvents({ dir })).toEqual([]);
  });
});
