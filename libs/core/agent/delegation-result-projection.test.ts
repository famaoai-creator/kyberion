import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  delegationSummaryBudget,
  projectDelegationResult,
} from './delegation-result-projection.js';

const writeArtifact = vi.hoisted(() => vi.fn(() => ({ repo_relative_path: 'scoped/full.txt' })));
vi.mock('../workforce/artifact-store.js', () => ({ writeScopedArtifact: writeArtifact }));
beforeEach(() => writeArtifact.mockClear());

describe('delegation result projection', () => {
  it('bounds a Unicode head/tail excerpt and preserves full text in the owning scope', async () => {
    const result = 'START' + '日本語😀'.repeat(2000) + 'FINAL NEEDS';
    const projected = await projectDelegationResult(result, {
      maxSummaryBytes: 300,
      artifactScope: { mission: 'MSN-OWNER', task: 'task-1' },
    });
    expect(Buffer.byteLength(projected)).toBeLessThanOrEqual(300);
    expect(projected).toContain('START');
    expect(projected).toContain('FINAL NEEDS');
    expect(projected).not.toContain('�');
    expect(writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { mission: 'MSN-OWNER', task: 'task-1' },
        content: result,
        tier: undefined,
        create_only: true,
      })
    );
  });

  it.each([
    JSON.stringify({ data: 'x'.repeat(30_000) }),
    '{"__proto__":{"data":"' + 'x'.repeat(30_000) + '"}}',
    'prose\n```task_result\n' + 'x'.repeat(30_000) + '\n```',
    '```json\n' + 'x'.repeat(30_000) + '\n```',
  ])('never truncates structured data', async (result) => {
    expect(await projectDelegationResult(result)).toBe(result);
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('uses latest occupancy and per-child headroom with a fixed unknown-context ceiling', () => {
    expect(delegationSummaryBudget()).toBe(24_000);
    expect(
      delegationSummaryBudget({
        parentContext: {
          contextWindowTokens: 1000,
          latestPromptTokens: 600,
          reservedOutputTokens: 100,
          expectedResults: 3,
        },
      })
    ).toBe(50);
    expect(
      delegationSummaryBudget({
        parentContext: {
          contextWindowTokens: 1000,
          latestPromptTokens: 2000,
        },
      })
    ).toBe(0);
    expect(() =>
      delegationSummaryBudget({
        parentContext: {
          contextWindowTokens: 1000,
          latestPromptTokens: Number.NaN,
        },
      })
    ).toThrow('occupancy');
  });

  it('refuses oversized unscoped/system results without losing full data', async () => {
    const result = 'x'.repeat(25_000);
    await expect(projectDelegationResult(result)).rejects.toMatchObject({ fullResult: result });
    await expect(
      projectDelegationResult(result, { artifactScope: { system: true } })
    ).rejects.toThrow('non-system');
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('does not persist after a terminal cancellation during artifact resolution', async () => {
    await expect(
      projectDelegationResult('x'.repeat(25_000), {
        artifactScope: { mission: 'MSN-OWNER' },
        canAcceptResult: () => false,
      })
    ).rejects.toThrow('terminal');
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('preserves complete explicitly structured non-JSON formats', async () => {
    const result = '<schema>' + 'x'.repeat(30_000) + '</schema>';
    expect(await projectDelegationResult(result, { format: 'structured' })).toBe(result);
  });
});
