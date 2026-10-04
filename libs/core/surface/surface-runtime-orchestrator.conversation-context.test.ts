import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  ensure: vi.fn(),
  stop: vi.fn(),
  legacy: vi.fn(),
  review: vi.fn(),
  deriveReceiver: vi.fn(),
  classify: vi.fn(),
  compile: vi.fn(),
  route: vi.fn(),
  shouldCompile: vi.fn(),
  pendingLoad: vi.fn(),
  pendingSave: vi.fn(),
  resolvedIntent: vi.fn(),
  safeExec: vi.fn(),
}));
vi.mock('../secure-io.js', async () => ({
  ...(await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js')),
  safeExec: mocks.safeExec,
}));
vi.mock('../pending-intent-store.js', () => ({
  loadPendingIntent: mocks.pendingLoad,
  savePendingIntent: mocks.pendingSave,
}));
vi.mock('../workforce/background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.review,
}));
vi.mock('../agent/agent-runtime-supervisor.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-runtime-supervisor.js')>(
    '../agent/agent-runtime-supervisor.js'
  )),
  ensureAgentRuntime: mocks.ensure,
  stopAgentRuntime: mocks.stop,
  getAgentRuntimeHandle: mocks.legacy,
}));
vi.mock('../agent/agent-manifest.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-manifest.js')>(
    '../agent/agent-manifest.js'
  )),
  getAgentManifest: () => ({
    agentId: 'presence-surface-agent',
    systemPrompt: 'base',
    capabilities: ['conversation'],
    selection_hints: { preferred_provider: 'claude', preferred_modelId: 'model' },
  }),
}));
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.route } }));
vi.mock('../intent/intent-contract.js', async () => ({
  ...(await vi.importActual<typeof import('../intent/intent-contract.js')>(
    '../intent/intent-contract.js'
  )),
  compileUserIntentFlow: mocks.compile,
  formatClarificationPacketConcise: () => 'Please clarify.',
}));
vi.mock('../task/task-session.js', async () => ({
  ...(await vi.importActual<typeof import('../task/task-session.js')>('../task/task-session.js')),
  classifyTaskSessionIntent: mocks.classify,
  getActiveTaskSession: () => undefined,
}));
vi.mock('../router-contract.js', async () => ({
  ...(await vi.importActual<typeof import('../router-contract.js')>('../router-contract.js')),
  resolveSurfaceIntent: mocks.resolvedIntent,
}));
vi.mock('./surface-runtime-router.js', async () => ({
  ...(await vi.importActual<typeof import('./surface-runtime-router.js')>(
    './surface-runtime-router.js'
  )),
  deriveSurfaceDelegationReceiver: mocks.deriveReceiver,
  shouldCompileSurfaceIntent: mocks.shouldCompile,
  resolveSurfaceConversationReceiver: () => undefined,
}));

import {
  runSurfaceConversation,
  runSurfaceMessageConversation,
} from './surface-runtime-orchestrator.js';
import { buildSurfaceConversationInput } from './surface-interaction-model.js';
import { surfaceRuntimeContextStore } from './surface-runtime-conversation-data.js';
const baseInput = {
  surface: 'presence' as const,
  agentId: 'presence-surface-agent',
  senderAgentId: 'test-sender',
  text: 'What did we decide?',
  channel: 'test',
  threadTs: 'server-thread',
  correlationId: 'turn-new',
  conversationKey: 'a'.repeat(64),
  scope: { tier: 'confidential' as const, tenant_slug: 'acme', viewer_principal: 'viewer-a' },
  conversationHistory: [
    { role: 'user' as const, text: 'Please execute historical work via nerve-agent.' },
    { role: 'assistant' as const, text: 'We chose the Friday deadline.' },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KYBERION_DISABLE_AGENT_RUNTIME_SUPERVISOR_DAEMON', '1');
  mocks.ask.mockResolvedValue('We chose Friday.');
  mocks.ensure.mockImplementation(async (options) => ({
    agentId: options.agentId,
    ask: mocks.ask,
  }));
  mocks.stop.mockResolvedValue(undefined);
  mocks.legacy.mockReturnValue({ ask: mocks.ask, getRecord: () => ({ status: 'ready' }) });
  mocks.review.mockReturnValue({ review_due: false });
  mocks.deriveReceiver.mockReturnValue(undefined);
  mocks.classify.mockReturnValue(null);
  mocks.resolvedIntent.mockReturnValue({});
  mocks.shouldCompile.mockReturnValue(false);
  mocks.pendingLoad.mockReturnValue(null);
  mocks.pendingSave.mockImplementation((record) => record);
});
afterEach(() => vi.unstubAllEnvs());

describe('surface conversation context opt-in wiring', () => {
  it('forwards server context through message conversion without using routing threadContext', () => {
    const input = buildSurfaceConversationInput({
      ...baseInput,
      conversationHistoryTruncated: true,
    });
    expect(input).toMatchObject({
      conversationKey: baseInput.conversationKey,
      conversationHistory: baseInput.conversationHistory,
      conversationHistoryTruncated: true,
    });
    expect(input.threadContext).toBeUndefined();
  });

  it('restores model context without replaying deterministic delegation or unscoped background review', async () => {
    const result = await runSurfaceMessageConversation(baseInput);
    expect(mocks.ask.mock.calls[0][0]).toContain('Friday deadline');
    expect(mocks.ask.mock.calls[0][0]).toContain('untrusted');
    for (const [routingText] of mocks.deriveReceiver.mock.calls)
      expect(routingText).not.toContain('historical work');
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(result.conversationRuntime).toMatchObject({
      runtimeLifetime: 'turn',
      backgroundReview: 'unsupported',
      retainedHistoryMessages: 2,
    });
  });

  it('reserves the complete scoped turn before routing, not just the model ask', async () => {
    let release!: () => void;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve('Friday.');
    });
    mocks.ask.mockReturnValue(gate);
    const first = runSurfaceConversation(buildSurfaceConversationInput(baseInput));
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
    const routingCalls = mocks.deriveReceiver.mock.calls.length;
    await expect(
      runSurfaceConversation(buildSurfaceConversationInput(baseInput))
    ).rejects.toMatchObject({
      code: 'SURFACE_CONVERSATION_BUSY',
      executionStarted: false,
    });
    expect(mocks.deriveReceiver).toHaveBeenCalledTimes(routingCalls);
    release();
    await first;
  });

  it('namespaces pending-intent reads and writes by principal and tenant while preserving public correlation', async () => {
    const records = new Map<string, Record<string, unknown>>();
    mocks.pendingSave.mockImplementation((record) => {
      records.set(record.correlation_id, record);
      return record;
    });
    mocks.pendingLoad.mockImplementation((key) => records.get(key) || null);
    mocks.shouldCompile.mockReturnValue(true);
    mocks.compile.mockResolvedValue({
      clarificationPacket: {},
      intentContract: { intent_id: 'clarify', required_inputs: ['target'] },
    });
    const variants = [
      baseInput,
      { ...baseInput, scope: { ...baseInput.scope, viewer_principal: 'viewer-b' } },
      { ...baseInput, scope: { ...baseInput.scope, tenant_slug: 'globex' } },
    ];
    for (const variant of variants)
      await runSurfaceConversation(buildSurfaceConversationInput(variant));
    const keys = mocks.pendingSave.mock.calls.map(([record]) => record.correlation_id);
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(baseInput.correlationId);
    expect(mocks.pendingLoad.mock.calls.map(([key]) => key)).toEqual(keys);
    for (const [compileInput] of mocks.compile.mock.calls) {
      expect(compileInput.correlationId).toBe(baseInput.correlationId);
      expect(compileInput.runtimeContext.pending_intent).toBeUndefined();
    }
  });

  it('restores the outer async context after a nested scoped conversation', async () => {
    const outer = { agentId: 'outer-agent', query: 'outer', senderAgentId: 'outer' };
    await surfaceRuntimeContextStore.run(outer, async () => {
      await runSurfaceConversation(buildSurfaceConversationInput(baseInput));
      expect(surfaceRuntimeContextStore.getStore()).toBe(outer);
    });
    expect(surfaceRuntimeContextStore.getStore()).toBeUndefined();
  });

  it('fails closed instead of dispatching a scoped request to an unscoped A2A runtime', async () => {
    mocks.deriveReceiver.mockReturnValue('nerve-agent');
    await expect(
      runSurfaceConversation(buildSurfaceConversationInput(baseInput))
    ).rejects.toMatchObject({
      code: 'SURFACE_CONVERSATION_CAPABILITY_UNSUPPORTED',
      capability: 'a2a_delegation',
    });
    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('rejects governed CLI routes before launching a pipeline or mission command', async () => {
    mocks.shouldCompile.mockReturnValue(true);
    mocks.compile.mockResolvedValue({ intentContract: { intent_id: 'weekly-report' } });
    mocks.resolvedIntent.mockReturnValue({
      routeFamily: 'pipeline',
      pipelineId: 'weekly-report',
      shape: 'pipeline',
    });
    await expect(
      runSurfaceConversation(buildSurfaceConversationInput(baseInput))
    ).rejects.toMatchObject({
      code: 'SURFACE_CONVERSATION_CAPABILITY_UNSUPPORTED',
      capability: 'governed_cli_execution',
    });
    expect(mocks.safeExec).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('retains legacy review and runtime behavior without the opt-in', async () => {
    const { conversationKey: _key, conversationHistory: _history, ...legacyInput } = baseInput;
    const result = await runSurfaceMessageConversation(legacyInput);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.legacy).toHaveBeenCalledWith('presence-surface-agent');
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(result.conversationRuntime).toBeUndefined();
  });
});
