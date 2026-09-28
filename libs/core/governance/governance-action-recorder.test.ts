import { describe, expect, it, vi } from 'vitest';

async function loadRecorder() {
  vi.resetModules();
  return import('./governance-action-recorder.js');
}

function captureStderr() {
  const lines: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => write.mockRestore() };
}

describe('governance action recorder', () => {
  it('warns before dropping overflow and retains the newest pending records', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
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
      expect(stderr.lines.some((line) => line.includes('pending buffer reached 256'))).toBe(true);
    } finally {
      stderr.restore();
    }
  });

  it('reports the dropped record count once a sink is registered', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
    try {
      for (let index = 0; index < 300; index += 1) {
        recordGovernanceAction(`agent-${index}`, 'test', 'pending');
      }
      const overflowWarnings = stderr.lines.filter((line) =>
        line.includes('pending buffer reached')
      );
      expect(overflowWarnings).toHaveLength(1);
      expect(overflowWarnings[0]).toContain('"dropped":1');

      registerGovernanceActionSink(vi.fn());

      const summary = stderr.lines.filter((line) =>
        line.includes('Governance action sink registered')
      );
      expect(summary).toHaveLength(1);
      expect(summary[0]).toContain('drained 256 buffered record(s)');
      expect(summary[0]).toContain('44 record(s) were dropped');
      expect(summary[0]).toContain('"drained":256');
      expect(summary[0]).toContain('"dropped":44');
    } finally {
      stderr.restore();
    }
  });

  it('logs the drained count when a sink registers late without any overflow', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
    try {
      recordGovernanceAction('agent-a', 'read', 'buffered');
      recordGovernanceAction('agent-b', 'write', 'buffered');

      const sink = vi.fn();
      registerGovernanceActionSink(sink);

      expect(sink).toHaveBeenCalledTimes(2);
      const summary = stderr.lines.filter((line) =>
        line.includes('Governance action sink registered')
      );
      expect(summary).toHaveLength(1);
      expect(summary[0]).toContain('drained 2 buffered record(s)');
      expect(summary[0]).toContain('0 record(s) were dropped');
    } finally {
      stderr.restore();
    }
  });

  it('emits no warning while the buffer stays below the drop threshold', async () => {
    const { recordGovernanceAction } = await loadRecorder();
    const stderr = captureStderr();
    try {
      for (let index = 0; index < 256; index += 1) {
        recordGovernanceAction(`agent-${index}`, 'test', 'pending');
      }
      expect(stderr.lines).toHaveLength(0);
    } finally {
      stderr.restore();
    }
  });

  it('passes records straight through once a sink is registered', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
    try {
      const sink = vi.fn();
      registerGovernanceActionSink(sink);
      expect(stderr.lines).toHaveLength(0);

      recordGovernanceAction('agent-a', 'delete', 'policy-denied', true);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith({
        agentId: 'agent-a',
        operation: 'delete',
        reason: 'policy-denied',
        policyViolation: true,
      });
      expect(stderr.lines).toHaveLength(0);
    } finally {
      stderr.restore();
    }
  });

  it('contains a throwing sink and keeps delivering later records', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
    try {
      const received: string[] = [];
      let failNext = true;
      registerGovernanceActionSink((record) => {
        if (failNext) {
          throw new TypeError('sink exploded');
        }
        received.push(record.agentId);
      });

      expect(() => recordGovernanceAction('agent-a', 'write', 'denied', true)).not.toThrow();
      expect(() => recordGovernanceAction('agent-b', 'write', 'denied', true)).not.toThrow();

      const failureLogs = stderr.lines.filter((line) => line.includes('sink threw TypeError'));
      expect(failureLogs).toHaveLength(1);
      expect(failureLogs[0]).toContain('sink exploded');

      failNext = false;
      recordGovernanceAction('agent-c', 'read', 'ok');
      expect(received).toEqual(['agent-c']);
    } finally {
      stderr.restore();
    }
  });

  it('contains a throwing sink while draining buffered records', async () => {
    const { recordGovernanceAction, registerGovernanceActionSink } = await loadRecorder();
    const stderr = captureStderr();
    try {
      recordGovernanceAction('agent-a', 'read', 'buffered');
      recordGovernanceAction('agent-b', 'read', 'buffered');
      recordGovernanceAction('agent-c', 'read', 'buffered');

      const received: string[] = [];
      expect(() =>
        registerGovernanceActionSink((record) => {
          if (record.agentId === 'agent-a') {
            throw new Error('drain exploded');
          }
          received.push(record.agentId);
        })
      ).not.toThrow();

      expect(received).toEqual(['agent-b', 'agent-c']);
      expect(stderr.lines.filter((line) => line.includes('sink threw Error'))).toHaveLength(1);
      expect(stderr.lines.some((line) => line.includes('drained 3 buffered record(s)'))).toBe(true);
    } finally {
      stderr.restore();
    }
  });
});
