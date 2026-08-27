import { describe, expect, it, vi } from 'vitest';

describe('governance action recorder', () => {
  it('warns before dropping overflow and retains the newest pending records', async () => {
    vi.resetModules();
    const { recordGovernanceAction, registerGovernanceActionSink } =
      await import('./governance-action-recorder.js');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (let index = 0; index < 300; index += 1) {
        recordGovernanceAction(`agent-${index}`, 'test', 'pending');
      }

      const sink = vi.fn();
      registerGovernanceActionSink(sink);

      expect(sink).toHaveBeenCalledTimes(256);
      expect(sink.mock.calls[0]?.[0]).toEqual({
        agentId: 'agent-44',
        operation: 'test',
        reason: 'pending',
        policyViolation: false,
      });
      expect(sink.mock.calls.at(-1)?.[0]).toEqual({
        agentId: 'agent-299',
        operation: 'test',
        reason: 'pending',
        policyViolation: false,
      });
      expect(
        write.mock.calls.some(([line]) => String(line).includes('pending buffer reached 256'))
      ).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});
