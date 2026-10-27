import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  curate: vi.fn(() => ({ archived: [], would_archive: ['candidate-1'], protected_reasons: {} })),
  restore: vi.fn(() => ({ candidate_id: 'candidate-1', status: 'proposed', changed: true })),
  maintenance: vi.fn(() => ({ candidate_id: 'candidate-1', status: 'proposed', changed: true })),
  request: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@agent/core/workforce/background-review-curator', () => ({
  curateBackgroundReviewProposals: calls.curate,
  restoreBackgroundReviewProposal: calls.restore,
  setBackgroundReviewProposalMaintenance: calls.maintenance,
}));
vi.mock('@agent/core/workforce/background-review-patch', () => ({
  applyBackgroundReviewPipelinePatch: calls.apply,
  applyBackgroundReviewSkillPatch: calls.apply,
  applyBackgroundReviewMemoryConsolidationPatch: calls.apply,
  createBackgroundReviewApprovalRequest: calls.request,
}));

import { main } from './background_review.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('background-review maintenance CLI', () => {
  it('explains recovery commands without performing maintenance', async () => {
    await main(['--help']);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('restore returns a curator archive to review')
    );
    expect(calls.curate).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
    expect(calls.maintenance).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('makes status read-only and passes dry-run through every maintenance command', async () => {
    await main(['status', '--json']);
    expect(calls.curate).toHaveBeenCalledWith({ dryRun: true, scope: undefined });
    await main(['curate', '--dry-run']);
    expect(calls.curate).toHaveBeenLastCalledWith({ dryRun: true, scope: undefined });
    await main(['pin', '--candidate', 'candidate-1', '--actor-id', 'operator', '--dry-run']);
    expect(calls.maintenance).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true, dryRun: true })
    );
    await main(['restore', '--candidate', 'candidate-1', '--actor-id', 'operator', '--dry-run']);
    expect(calls.restore).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(calls.request).not.toHaveBeenCalled();
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it('preserves the exact scope and distinguishes pinning from automatic maintenance consent', async () => {
    const scope = { tier: 'personal', owner_nhi: 'nhi:operator', provenance_refs: ['source:one'] };
    await main([
      'hold',
      '--candidate',
      'candidate-1',
      '--actor-id',
      'operator',
      '--scope-json',
      JSON.stringify(scope),
    ]);
    expect(calls.maintenance).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      actorId: 'operator',
      scope,
      dryRun: false,
      automaticArchive: false,
    });
    await main(['manage', '--candidate', 'candidate-1', '--actor-id', 'operator']);
    expect(calls.maintenance).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticArchive: true })
    );
    await main(['unpin', '--candidate', 'candidate-1', '--actor-id', 'operator']);
    expect(calls.maintenance).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: false }));
  });

  it('requires an actor and refuses malformed or silently broadened maintenance options', async () => {
    for (const [argv, code] of [
      [['restore', '--candidate', 'candidate-1'], 1],
      [['restore', '--candidate', 'candidate-1', '--actor-id'], 2],
      [['status', '--scope-json', 'null'], 1],
      [['status', '--scope-json', '[]'], 1],
      [['status', '--scope-json', '{broken'], 1],
      [['pin', '--candidate', 'candidate-1', '--actor-id', 'operator', '--scope-json'], 2],
      [['status', '--scope-jsno', '{}'], 2],
      [['status', 'unexpected-positional'], 1],
    ] satisfies Array<[string[], number]>) {
      process.exitCode = undefined;
      await main(argv);
      expect(process.exitCode, argv.join(' ')).toBe(code);
    }
    expect(calls.curate).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
    expect(calls.maintenance).not.toHaveBeenCalled();
  });

  it('uses shared inline value options without borrowing host process arguments', async () => {
    const original = process.argv;
    process.argv = [
      'node',
      'host-script',
      '--candidate',
      'host-candidate',
      '--actor-id',
      'host-actor',
    ];
    try {
      await main(['pin', '--candidate=candidate-1', '--actor-id=operator', '--dry-run']);
      expect(calls.maintenance).toHaveBeenCalledWith({
        candidateId: 'candidate-1',
        actorId: 'operator',
        scope: undefined,
        dryRun: true,
        pinned: true,
      });
    } finally {
      process.argv = original;
    }
  });

  it('never executes approval/apply effects when dry-run or maintenance scope flags are supplied', async () => {
    for (const command of ['request', 'apply', 'apply-skill', 'apply-memory']) {
      await main([
        command,
        '--candidate',
        'candidate-1',
        '--expected-sha256',
        'a'.repeat(64),
        '--approved-by',
        'operator',
        '--approval-ref',
        'approval-1',
        '--dry-run',
      ]);
      expect(process.exitCode).toBe(1);
    }
    await main(['apply', '--candidate', 'candidate-1', '--scope-json', '{}']);
    expect(calls.request).not.toHaveBeenCalled();
    expect(calls.apply).not.toHaveBeenCalled();
  });
});
