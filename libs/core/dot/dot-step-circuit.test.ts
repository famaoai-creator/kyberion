import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import type { DotCharter } from './dot-charter.js';
import { evaluateDotTriggersDue, recordDotWatchSnapshot } from './dot-runtime.js';
import { DotSupervisorStepCircuit } from './dot-step-circuit.js';

const TEST_ROOT = 'active/shared/tmp/dot-step-circuit-tests';
// Watched paths are relative to deps.rootDir.
const WATCH_REL = 'watch/alerts.jsonl';
const WATCH_ABS = `${TEST_ROOT}/${WATCH_REL}`;

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'Keep CI green.' },
  attention: {
    triggers: [
      {
        kind: 'watch',
        paths: [WATCH_REL],
        ignore_jsonl_kinds: ['operator_notification_undelivered'],
      },
    ],
  },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

function deps() {
  return { rootDir: TEST_ROOT, now: () => new Date('2026-10-02T10:15:00Z') };
}

function writeAlerts(lines: unknown[]): void {
  safeMkdir(`${TEST_ROOT}/watch`, { recursive: true });
  safeWriteFile(WATCH_ABS, '');
  for (const line of lines) appendJsonLine(WATCH_ABS, line);
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('watch trigger ignore_jsonl_kinds', () => {
  it('stays quiet when every appended record carries an ignored kind', () => {
    writeAlerts([{ ts: '1', kind: 'ops_alert', title: 'real alert' }]);
    // First sighting establishes the baseline and fires once.
    expect(evaluateDotTriggersDue(CHARTER, deps()).length).toBe(1);
    recordDotWatchSnapshot(CHARTER, deps());

    // Appending only undelivered-notification rows must not re-fire.
    appendJsonLine(WATCH_ABS, {
      ts: '2',
      kind: 'operator_notification_undelivered',
      event: 'mission_completed',
      title: 'x',
      reason: 'no_channel_configured',
    });
    appendJsonLine(WATCH_ABS, {
      ts: '3',
      kind: 'operator_notification_undelivered',
      event: 'dot_decision',
      title: 'y',
      reason: 'no_channel_configured',
    });
    expect(evaluateDotTriggersDue(CHARTER, deps())).toHaveLength(0);

    // The snapshot advanced past them: a real alert appended later fires.
    appendJsonLine(WATCH_ABS, { ts: '4', kind: 'ops_alert', title: 'circuit open' });
    expect(evaluateDotTriggersDue(CHARTER, deps()).length).toBe(1);
  });

  it('fires when the append mixes ignored and real records', () => {
    writeAlerts([{ ts: '1', kind: 'ops_alert', title: 'real alert' }]);
    evaluateDotTriggersDue(CHARTER, deps());
    recordDotWatchSnapshot(CHARTER, deps());
    appendJsonLine(WATCH_ABS, {
      ts: '2',
      kind: 'operator_notification_undelivered',
      event: 'mission_completed',
      title: 'x',
      reason: 'no_channel_configured',
    });
    appendJsonLine(WATCH_ABS, { ts: '3', kind: 'ops_alert', title: 'new' });
    expect(evaluateDotTriggersDue(CHARTER, deps()).length).toBe(1);
  });
});

describe('DotSupervisorStepCircuit', () => {
  it('counts identical failures, opens at the threshold, backs off and half-opens', () => {
    const circuit = new DotSupervisorStepCircuit('test-step', {
      threshold: 3,
      baseCooldownMs: 1000,
      maxCooldownMs: 10_000,
    });
    const error = new Error('deterministic policy deny');
    expect(circuit.admits('dot-a', 0)).toBe(true);
    expect(circuit.reportFailure('dot-a', error, 0)).toBe('counted');
    expect(circuit.reportFailure('dot-a', error, 1)).toBe('counted');
    expect(circuit.reportFailure('dot-a', error, 2)).toBe('open');
    expect(circuit.admits('dot-a', 3)).toBe(false);
    // Cooldown elapsed → half-open probe admitted once.
    expect(circuit.admits('dot-a', 1003)).toBe(true);
    // The probe fails the same way → re-opens with a longer hold.
    expect(circuit.reportFailure('dot-a', error, 1003)).toBe('open');
    expect(circuit.admits('dot-a', 2003)).toBe(false);
    expect(circuit.admits('dot-a', 3004)).toBe(true);
    // A success closes the circuit entirely.
    circuit.reportSuccess('dot-a');
    expect(circuit.streakOf('dot-a')).toBe(0);
    expect(circuit.reportFailure('dot-a', error, 3004)).toBe('counted');
  });

  it('does not let one dot or one signature starve the others', () => {
    const circuit = new DotSupervisorStepCircuit('test-step', { threshold: 2 });
    expect(circuit.reportFailure('dot-a', new Error('x'), 0)).toBe('counted');
    expect(circuit.reportFailure('dot-a', new Error('x'), 1)).toBe('open');
    expect(circuit.admits('dot-a', 2)).toBe(false);
    expect(circuit.admits('dot-b', 2)).toBe(true);
    // A different failure signature starts a fresh streak rather than
    // extending the held one.
    const circuit2 = new DotSupervisorStepCircuit('s', { threshold: 3 });
    circuit2.reportFailure('d', new Error('first'), 0);
    circuit2.reportFailure('d', new Error('first'), 1);
    expect(circuit2.reportFailure('d', new Error('different'), 2)).toBe('counted');
  });

  it('streaks failures that differ only in volatile ids (pids, epochs, uuids)', () => {
    const circuit = new DotSupervisorStepCircuit('test-step', { threshold: 3 });
    // Same defect, different pid each sweep — must still reach the threshold.
    expect(circuit.reportFailure('dot-a', new Error('daemon lock held by pid 1073'), 0)).toBe(
      'counted'
    );
    expect(circuit.reportFailure('dot-a', new Error('daemon lock held by pid 2084'), 1)).toBe(
      'counted'
    );
    expect(circuit.reportFailure('dot-a', new Error('daemon lock held by pid 3110'), 2)).toBe(
      'open'
    );
    circuit.reportSuccess('dot-a');
    const circuit2 = new DotSupervisorStepCircuit('s', { threshold: 2 });
    circuit2.reportFailure('d', new Error('request 9f8e7d6c-1234-5678-9abc-def012345678 lost'), 0);
    expect(
      circuit2.reportFailure('d', new Error('request aaaa1111-2222-3333-4444-bbbbccccdddd lost'), 1)
    ).toBe('open');
  });
});
