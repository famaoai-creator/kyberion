import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SB-01: under SYSTEM_ROLE=slack_bridge an in-process assumption of another
 * role (mission_controller has no presence/bridge/runtime/ write) used to make
 * the stimuli-journal rotation fail — and nerve-bridge swallows that error.
 * The rotation writes as the journal's own store-writer role, so it works no
 * matter which assumption (or async continuation of one) it runs in. Runs the
 * real secure-io / tier-guard stack against a hermetic KYBERION_ROOT.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
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

async function loadModules() {
  vi.resetModules();
  const authority = await import('./authority.js');
  const journal = await import('./stimuli-journal.js');
  authority.resetRoleAssumptionPolicyCache();
  return { authority, journal };
}

describe('SB-01 stimuli-journal rotation under SYSTEM_ROLE=slack_bridge', () => {
  beforeAll(() => {
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
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_ROOT = root;
    process.env.SYSTEM_ROLE = 'slack_bridge';
    fs.writeFileSync(journalPath(), journalLines(20));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    vi.resetModules();
  });

  it('rotates under the ambient slack_bridge role', async () => {
    const { journal } = await loadModules();
    const before = fs.statSync(journalPath()).size;
    expect(journal.rotateStimuliJournalIfNeeded(MAX_BYTES)).toBe(true);
    expect(fs.statSync(journalPath()).size).toBeLessThan(before);
  });

  it('rotates from inside a mission_controller assumption', async () => {
    const { authority, journal } = await loadModules();
    const before = fs.statSync(journalPath()).size;
    const rotated = authority.withExecutionContext('mission_controller', () => {
      expect(authority.resolveRole()).toBe('mission_controller');
      return journal.rotateStimuliJournalIfNeeded(MAX_BYTES);
    });
    expect(rotated).toBe(true);
    expect(fs.statSync(journalPath()).size).toBeLessThan(before);
    expect(fs.readFileSync(journalPath(), 'utf8')).not.toContain('"msg-0"');
  });

  it('rotates from an async continuation (await + timer) of that assumption', async () => {
    const { authority, journal } = await loadModules();
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
    expect(fs.statSync(journalPath()).size).toBeLessThan(before);
  });

  it('appends and rotates through appendStimulus inside the assumption', async () => {
    const { authority, journal } = await loadModules();
    fs.writeFileSync(journalPath(), journalLines(200));
    const before = fs.statSync(journalPath()).size;
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
    const after = fs.readFileSync(journalPath(), 'utf8');
    expect(after).toContain('"msg-appended"');
    expect(Buffer.byteLength(after)).toBeGreaterThan(before);
  });
});
