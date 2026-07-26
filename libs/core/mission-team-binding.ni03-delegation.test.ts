import { afterAll, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import {
  buildDelegationLink,
  parseDelegationChain,
  serializeDelegationChain,
  type DelegationChain,
} from './delegation-chain.js';

// NI-03: the execution ledger records the delegation chain first-class so an
// audit can reconstruct the full path (root orchestrator/user → every
// intermediate actor) from a ledger entry alone.

const MISSION_ID = `MSN-NI03-LEDGER-${process.pid}`;
const TEST_MISSION_DIR = pathResolver.sharedTmp(`ni03-ledger-tests/${MISSION_ID}`);
const LEDGER_PATH = `${TEST_MISSION_DIR}/execution-ledger.jsonl`;

function sampleChain(): DelegationChain {
  return [
    buildDelegationLink({
      actor: 'kyberion://agent/ni03-org/mission-orchestrator',
      team_role: 'orchestrator',
      granted_scope: {},
      granted_at: '2026-07-26T00:00:00.000Z',
    }),
    buildDelegationLink({
      actor: 'kyberion://agent/ni03-org/worker-a',
      team_role: 'implementer',
      granted_scope: { capability_tier: 'implementer' },
      granted_at: '2026-07-26T00:00:01.000Z',
    }),
    buildDelegationLink({
      actor: 'subagent:process-spawn:explorer',
      team_role: 'reviewer',
      granted_scope: { capability_tier: 'explorer' },
      granted_at: '2026-07-26T00:00:02.000Z',
    }),
  ];
}

function readLedgerEntries(): Array<Record<string, unknown>> {
  const content = safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string;
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  const root = pathResolver.sharedTmp('ni03-ledger-tests');
  if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
});

describe('mission-team-binding NI-03 delegation_chain ledger column', () => {
  it('persists a typed delegation_chain and supports lossless audit reconstruction', () => {
    const chain = sampleChain();
    appendMissionExecutionLedgerEntry({
      mission_id: MISSION_ID,
      mission_path_hint: TEST_MISSION_DIR,
      event_type: 'task_issued',
      task_id: 'task-1',
      team_role: 'implementer',
      actor_id: 'worker-a',
      actor_type: 'agent',
      decision: 'dispatch',
      delegation_chain: chain,
    });

    const entries = readLedgerEntries();
    const entry = entries[entries.length - 1];
    expect(entry.delegation_chain).toEqual(chain);

    // Audit reconstruction: the persisted chain re-parses and re-serializes
    // byte-identically — the full 3-hop path (root orchestrator → worker →
    // sub-worker) is recoverable from the ledger row alone.
    const reconstructed = parseDelegationChain(JSON.parse(JSON.stringify(entry.delegation_chain)));
    expect(reconstructed).toEqual(chain);
    expect(serializeDelegationChain(reconstructed!)).toBe(serializeDelegationChain(chain));
    expect(reconstructed![0].actor).toBe('kyberion://agent/ni03-org/mission-orchestrator');
    expect(reconstructed![2].actor).toBe('subagent:process-spawn:explorer');
  });

  it('promotes a chain riding in payload.delegation_chain (the emitMissionTaskEvent pass-through)', () => {
    const chain = sampleChain().slice(0, 2);
    appendMissionExecutionLedgerEntry({
      mission_id: MISSION_ID,
      mission_path_hint: TEST_MISSION_DIR,
      event_type: 'participant_context_resolved',
      task_id: 'task-2',
      team_role: 'implementer',
      actor_id: 'worker-a',
      actor_type: 'agent',
      decision: 'dispatch_context_compiled',
      payload: { delegation_chain: chain, other: 'kept' },
    });

    const entries = readLedgerEntries();
    const entry = entries[entries.length - 1];
    expect(entry.delegation_chain).toEqual(chain);
    expect((entry.payload as Record<string, unknown>).other).toBe('kept');
  });

  it('drops a malformed payload chain best-effort (append still succeeds, no delegation_chain column)', () => {
    appendMissionExecutionLedgerEntry({
      mission_id: MISSION_ID,
      mission_path_hint: TEST_MISSION_DIR,
      event_type: 'task_issued',
      task_id: 'task-3',
      decision: 'dispatch',
      payload: { delegation_chain: [{ actor: '', granted_at: 42 }] },
    });

    const entries = readLedgerEntries();
    const entry = entries[entries.length - 1];
    expect(entry.event_type).toBe('task_issued');
    expect(entry.delegation_chain).toBeUndefined();
  });

  it('leaves chain-less entries unchanged (legacy compatibility)', () => {
    appendMissionExecutionLedgerEntry({
      mission_id: MISSION_ID,
      mission_path_hint: TEST_MISSION_DIR,
      event_type: 'task_completed',
      task_id: 'task-4',
      decision: 'done',
    });
    const entries = readLedgerEntries();
    const entry = entries[entries.length - 1];
    expect('delegation_chain' in entry).toBe(false);
  });
});
