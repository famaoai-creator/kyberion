import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * SB-01: under SYSTEM_ROLE=slack_bridge an in-process assumption of another
 * role (mission_controller has no presence/bridge/runtime/ write) used to make
 * the stimuli-journal rotation fail — and nerve-bridge swallows that error.
 * The rotation writes as the journal's own store-writer role, so it works no
 * matter which assumption (or async continuation of one) it runs in. Runs the
 * real secure-io / tier-guard stack against a hermetic KYBERION_ROOT.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENV_KEYS = ['KYBERION_ROOT', 'SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA'] as const;
const JOURNAL_RELATIVE = 'presence/bridge/runtime/stimuli.jsonl';
const MAX_BYTES = 256;

let root = '';
const original: Record<string, string | undefined> = {};

function journalLines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${JSON.stringify({ id: `msg-${index}`, intent: 'probe' })}\n`
  ).join('');
}

function journalPath(): string {
  return path.join(root, JOURNAL_RELATIVE);
}

/** Rotated `stimuli-YYYYMMDD-HHmmss[-n].jsonl` segments next to the journal. */
function segmentPaths(): string[] {
  const dir = path.dirname(journalPath());
  return fs
    .readdirSync(dir)
    .filter((name) => /^stimuli-\d{8}-\d{6}(-\d+)?\.jsonl$/u.test(name))
    .map((name) => path.join(dir, name));
}

function segmentText(): string {
  return segmentPaths()
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('');
}

/** Rotation renames the live journal to a segment; appends recreate it. */
function liveSize(): number {
  return fs.existsSync(journalPath()) ? fs.statSync(journalPath()).size : 0;
}

type AuthorityModule = typeof import('./authority.js');
type JournalModule = typeof import('./stimuli-journal.js');
type JsonModule = typeof import('./foundation/json.js');
type SensorModule = typeof import('./sensor-engine.js');

// Imported ONCE per file, after KYBERION_ROOT / SYSTEM_ROLE are set:
// path-resolver caches the project root and stimuli-journal its path at import
// time. Re-importing the secure-io / tier-guard / authority stack per test with
// vi.resetModules() re-ran all of its module-level initialisation every test and
// coincided with intermittent macOS Vitest worker SIGSEGVs (#989, #990). Per-test
// state is reset through the modules' own seams instead (see beforeEach).
let authority: AuthorityModule;
let journal: JournalModule;
let json: JsonModule;
let sensorEngine: SensorModule;

describe('SB-01 stimuli-journal rotation under SYSTEM_ROLE=slack_bridge', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-stimuli-rotation-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"hermetic"}\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# hermetic\n');
    fs.mkdirSync(path.dirname(path.join(root, JOURNAL_RELATIVE)), { recursive: true });
    // Copied, not linked: the policy engine refuses a symlinked policy path.
    for (const dir of ['governance', 'schemas']) {
      fs.cpSync(
        path.join(REPO_ROOT, 'knowledge', 'product', dir),
        path.join(root, 'knowledge', 'product', dir),
        { recursive: true }
      );
    }
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_ROOT = root;
    process.env.SYSTEM_ROLE = 'slack_bridge';
    // Each test file gets a fresh module registry (isolate: true) and the
    // setup file imports no core module, so this first import binds the root.
    authority = await import('./authority.js');
    journal = await import('./stimuli-journal.js');
    json = await import('./foundation/json.js');
    sensorEngine = await import('./sensor-engine.js');
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Per-test isolation: no test may inherit a role/persona left by another;
    // afterAll restores the values saved in beforeAll.
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_PERSONA;
    authority.resetRoleAssumptionPolicyCache();
    for (const segment of segmentPaths()) fs.rmSync(segment, { force: true });
    fs.writeFileSync(journalPath(), journalLines(20));
  });

  it('rotates under the ambient slack_bridge role', async () => {
    const before = fs.statSync(journalPath()).size;
    expect(journal.rotateStimuliJournalIfNeeded(MAX_BYTES)).toBe(true);
    expect(liveSize()).toBeLessThan(before);
    expect(segmentPaths()).toHaveLength(1);
  });

  it('rotates from inside a mission_controller assumption', async () => {
    const before = fs.statSync(journalPath()).size;
    const rotated = authority.withExecutionContext('mission_controller', () => {
      expect(authority.resolveRole()).toBe('mission_controller');
      return journal.rotateStimuliJournalIfNeeded(MAX_BYTES);
    });
    expect(rotated).toBe(true);
    expect(liveSize()).toBeLessThan(before);
    // Moved aside, not lost: the full history is in the segment.
    expect(segmentText()).toContain('"msg-0"');
  });

  it('rotates from an async continuation (await + timer) of that assumption', async () => {
    const before = fs.statSync(journalPath()).size;
    const rotated = await authority.withExecutionContextAsync('mission_controller', async () => {
      await Promise.resolve();
      return new Promise<boolean>((resolve, reject) => {
        setTimeout(() => {
          try {
            // The scope follows the timer created inside the assumption.
            expect(authority.resolveRole()).toBe('mission_controller');
            resolve(journal.rotateStimuliJournalIfNeeded(MAX_BYTES));
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    });
    expect(rotated).toBe(true);
    expect(liveSize()).toBeLessThan(before);
  });

  it('appends and rotates through appendStimulus inside the assumption', async () => {
    // Just over the real ceiling, so appendStimulus's own rotation fires.
    const line = `${JSON.stringify({ id: 'msg-old', intent: 'probe', pad: 'x'.repeat(1000) })}\n`;
    fs.writeFileSync(
      journalPath(),
      line.repeat(Math.ceil(journal.STIMULI_MAX_BYTES / Buffer.byteLength(line)) + 1)
    );
    const before = fs.statSync(journalPath()).size;
    expect(before).toBeGreaterThan(journal.STIMULI_MAX_BYTES);
    authority.withExecutionContext('mission_controller', () =>
      journal.appendStimulus({
        id: 'msg-appended',
        ts: '2026-09-27T00:00:00.000Z',
        from: 'probe',
        node_id: 'node-probe',
        to: 'broadcast',
        type: 'event',
        intent: 'probe',
        payload: {},
      })
    );
    // The append landed, then write-time rotation moved the journal aside.
    expect(liveSize()).toBeLessThan(journal.STIMULI_MAX_BYTES);
    expect(segmentText()).toContain('"msg-appended"');
    // Readers continue into the segment, so the rotation loses no context.
    expect(journal.loadRecentStimuli(1, { enforceTtl: false }).map((m) => m.id)).toEqual([
      'msg-appended',
    ]);
  });

  it('appends a Slack surface stimulus unchanged from inside another assumption (SB-02)', async () => {
    const { appendJsonLine } = json;
    fs.writeFileSync(journalPath(), '');
    const stimulus = {
      id: 'slack-stimulus-1',
      ts: '2026-09-27T00:00:00.000Z',
      ttl: 3600,
      origin: {
        channel: 'slack' as const,
        source_id: 'C123',
        context: 'thread',
        metadata: { user: 'U123' },
      },
      signal: { type: 'CHAT' as const, priority: 5, payload: 'hello' },
      policy: {
        flow: 'LOOPBACK' as const,
        feedback: 'auto' as const,
        retention: 'ephemeral' as const,
      },
      control: { status: 'pending' as const, evidence: [] },
    };
    // The raw append the bridge used to do fails under mission_controller.
    expect(() =>
      authority.withExecutionContext('mission_controller', () =>
        appendJsonLine(journal.stimuliJournalPath(), stimulus)
      )
    ).toThrow();
    authority.withExecutionContext('mission_controller', () => journal.appendStimulus(stimulus));
    expect(fs.readFileSync(journalPath(), 'utf8')).toBe(`${JSON.stringify(stimulus)}\n`);
  });
  it('emits sensor stimuli through the journal store writer inside another assumption', async () => {
    const { KyberionSensor } = sensorEngine;
    class ProbeSensor extends KyberionSensor {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      fire(): void {
        this.emit({ intent: 'probe.sensor', payload: { ok: true }, priority: 3 });
      }
    }
    fs.writeFileSync(journalPath(), '');
    const sensor = new ProbeSensor({ id: 'probe', name: 'Probe', type: 'event-driven' });
    authority.withExecutionContext('mission_controller', () => sensor.fire());
    const lines = fs.readFileSync(journalPath(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      origin: { channel: 'sensor', source_id: 'probe' },
      signal: { intent: 'probe.sensor', priority: 3, payload: { ok: true } },
      control: { status: 'pending', feedback: 'auto', evidence: [] },
    });
  });

  describe('size bounds (MSN-STORE-BOUNDS-20261101)', () => {
    const message = (id: string, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({
        id,
        ts: '2026-11-01T00:00:00.000Z',
        from: 'probe',
        node_id: 'node-probe',
        to: 'broadcast',
        type: 'event',
        intent: 'probe',
        payload: { pad: 'x'.repeat(10_000) },
        ...extra,
      })}\n`;

    beforeEach(() => {
      for (const segment of segmentPaths()) fs.rmSync(segment, { force: true });
    });

    it('reads the newest stimuli from a journal past the old 5MB read cap', () => {
      const filler = message('msg-filler');
      fs.writeFileSync(
        journalPath(),
        filler.repeat(Math.ceil((6 * 1024 * 1024) / Buffer.byteLength(filler))) +
          message('msg-newest-1') +
          message('msg-newest-2')
      );
      expect(fs.statSync(journalPath()).size).toBeGreaterThan(5 * 1024 * 1024);
      expect(journal.loadRecentStimuli(2, { enforceTtl: false }).map((m) => m.id)).toEqual([
        'msg-newest-1',
        'msg-newest-2',
      ]);
    });

    it('keeps scanning past expired records so they cannot crowd out live ones', () => {
      const nowMs = Date.parse('2026-11-01T01:00:00.000Z');
      fs.writeFileSync(
        journalPath(),
        message('msg-live') +
          message('msg-expired-1', { metadata: { ttl: 60 } }) +
          message('msg-expired-2', { metadata: { ttl: 60 } })
      );
      expect(journal.loadRecentStimuli(1, { nowMs }).map((m) => m.id)).toEqual(['msg-live']);
    });

    it('never throws from appendStimulus past the old 11MB rotation read cap', () => {
      const big = message('msg-big', { payload: { pad: 'y'.repeat(100_000) } });
      fs.writeFileSync(
        journalPath(),
        big.repeat(Math.ceil((12 * 1024 * 1024) / Buffer.byteLength(big)))
      );
      expect(fs.statSync(journalPath()).size).toBeGreaterThan(11 * 1024 * 1024);
      expect(() =>
        journal.appendStimulus({
          id: 'msg-after-oversize',
          ts: '2026-11-01T00:00:00.000Z',
          from: 'probe',
          node_id: 'node-probe',
          to: 'broadcast',
          type: 'event',
          intent: 'probe',
          payload: {},
        })
      ).not.toThrow();
      // Rotated by rename (no whole-file read): the live journal starts over.
      expect(liveSize()).toBe(0);
      expect(segmentPaths()).toHaveLength(1);
      expect(journal.loadRecentStimuli(1, { enforceTtl: false }).map((m) => m.id)).toEqual([
        'msg-after-oversize',
      ]);
    });
  });
});

describe('SB-01 the stimuli journal is not an authorization input', () => {
  it('keeps dynamic-permission-guard and sensory-memory out of the authorization modules', () => {
    const authorizationModules = [
      'libs/core/tier-guard.ts',
      'libs/core/secure-io.ts',
      'libs/core/governance/policy-engine.ts',
      'libs/core/authority.ts',
      'libs/core/operation-policy-gate.ts',
    ];
    for (const relative of authorizationModules) {
      const file = path.join(REPO_ROOT, relative);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      expect(source, relative).not.toMatch(
        /dynamic-permission-guard|sensory-memory|stimuli-journal/u
      );
    }
  });
});
