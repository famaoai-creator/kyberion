import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * R2 of the intent resolver unification plan (concept model v2, D7): one
 * request resolves its utterance once. The gateway resolves at the entry and
 * hands the packet and RoutingDecision downstream; the execution path must act
 * on them instead of re-resolving.
 */

const counters = vi.hoisted(() => ({ resolutions: [] as string[] }));
const executeRegisteredSuperPipeline = vi.hoisted(() =>
  vi.fn(async (steps: unknown[]) => ({ status: 'succeeded', steps }))
);

vi.mock('@agent/core/intent/intent-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/intent/intent-resolution')>();
  return {
    ...actual,
    resolveIntentResolutionPacket: (
      ...args: Parameters<typeof actual.resolveIntentResolutionPacket>
    ) => {
      counters.resolutions.push(args[0]);
      return actual.resolveIntentResolutionPacket(...args);
    },
    gatherImprovementHints: async () => [],
  };
});
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: vi.fn(),
}));
vi.mock('@agent/core/super-nerve-execution-port', () => ({ executeRegisteredSuperPipeline }));
vi.mock('../libs/actuators/orchestrator-actuator/src/super-nerve/index.js', () => ({}));

const { main } = await import('./run_intent.js');
const { resolveAndExecuteIntent } =
  await import('../libs/actuators/orchestrator-actuator/src/super-nerve/resolver.js');
const { resolveRoutingDecision } = await import('@agent/core/intent');

describe('one resolution per request (R2)', () => {
  beforeEach(() => {
    counters.resolutions.length = 0;
    executeRegisteredSuperPipeline.mockClear();
  });

  it('resolves a gateway request once and executes off the carried decision', async () => {
    const result = await main(['サービスを停止して']);

    expect(counters.resolutions).toEqual(['サービスを停止して']);
    expect(executeRegisteredSuperPipeline).toHaveBeenCalledTimes(1);
    const [steps, context] = executeRegisteredSuperPipeline.mock.calls[0] as unknown as [
      Array<{ op: string }>,
      Record<string, any>,
    ];
    expect(steps[0]?.op).toBe('system:shell');
    expect(context.routing_decision).toMatchObject({
      kind: 'routing_decision',
      intent_id: 'stop-service',
    });
    expect(result).toMatchObject({ status: 'succeeded' });
  });

  it('re-resolves only when no decision for this request is carried', async () => {
    const { packet, decision } = resolveRoutingDecision('サービスを停止して');
    counters.resolutions.length = 0;

    await resolveAndExecuteIntent('stop-service', {
      resolution_packet: packet,
      routing_decision: decision,
      source_text: 'サービスを停止して',
    });
    expect(counters.resolutions).toEqual([]);

    // A decision for a different intent is not this request's decision.
    await resolveAndExecuteIntent('stop-service', {
      routing_decision: { ...decision, intent_id: 'start-service' },
    });
    expect(counters.resolutions[0]).toBe('stop-service');
  });
});
