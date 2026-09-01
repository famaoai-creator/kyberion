import { describe, expect, it } from 'vitest';
import {
  chronosConversationScope,
  chronosViewerCanAccessAgentScope,
  intentResolutionA2ui,
  parseChronosAgentBody,
  parseChronosAgentsBody,
  resolveChronosPipelineInputPath,
} from './agent-route-helpers';

describe('intentResolutionA2ui', () => {
  it('projects every operator-facing contract decision field', () => {
    const [section] = intentResolutionA2ui({
      normalized_intent: 'send_message',
      missing_inputs: [],
      authority_level: 'approval_required',
      outcome_kind: 'service_change',
      next_action: {
        kind: 'request_approval',
        label: 'Review and approve',
        consequence: 'The message will be sent after approval.',
      },
    });

    const entries = section.props.items[0].props.entries;
    expect(entries).toEqual(
      expect.arrayContaining([
        { key: 'Authority', value: 'human approval required' },
        { key: 'Consequence', value: 'The message will be sent after approval.' },
      ])
    );
  });

  it('uses the requested locale for projection labels', () => {
    const [section] = intentResolutionA2ui(
      {
        normalized_intent: 'answer_question',
        missing_inputs: [],
        authority_level: 'autonomous',
        outcome_kind: 'answer',
        next_action: { kind: 'continue', label: 'Continue', consequence: 'No side effect.' },
      },
      'ja'
    );

    expect(section.props.title).toBe('依頼の整理');
    expect(section.props.items[0].props.entries).toEqual(
      expect.arrayContaining([
        { key: '理解', value: 'answer_question' },
        { key: '不足入力', value: 'なし' },
        { key: '次の操作', value: 'Continue' },
        { key: '権限', value: '自動実行候補' },
        { key: '結果', value: '回答' },
        { key: '帰結', value: 'No side effect.' },
      ])
    );
  });
});

describe('chronosConversationScope', () => {
  it('keeps a single tenant and the strongest allowed non-personal tier', () => {
    expect(
      chronosConversationScope({
        tenantSlugs: ['tenant-a'],
        tierAccess: ['public', 'confidential'],
      })
    ).toEqual({ scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' });
  });

  it('masks multi-tenant viewers to a system/public scope', () => {
    expect(
      chronosConversationScope({
        tenantSlugs: 'all',
        tierAccess: ['public', 'confidential'],
      })
    ).toEqual({ scope_kind: 'system', tier: 'public' });
  });

  it('only resolves JSON pipelines inside the repository pipelines directory', () => {
    expect(resolveChronosPipelineInputPath('/repo', 'pipelines/daily.json')).toBe(
      '/repo/pipelines/daily.json'
    );
    expect(resolveChronosPipelineInputPath('/repo', '../secrets.json')).toBeNull();
    expect(resolveChronosPipelineInputPath('/repo', 'knowledge/private.json')).toBeNull();
    expect(resolveChronosPipelineInputPath('/repo', '/tmp/pipeline.json')).toBeNull();
  });
});

describe('chronosViewerCanAccessAgentScope', () => {
  it('allows only an already-authorized tenant and tier', () => {
    const viewer = { tenantSlugs: ['tenant-a'], tierAccess: ['confidential'] as const };
    expect(
      chronosViewerCanAccessAgentScope(viewer, {
        scope_kind: 'tenant',
        tier: 'confidential',
        tenant_slug: 'tenant-a',
      })
    ).toBe(true);
    expect(
      chronosViewerCanAccessAgentScope(viewer, {
        scope_kind: 'tenant',
        tier: 'confidential',
        tenant_slug: 'tenant-b',
      })
    ).toBe(false);
    expect(
      chronosViewerCanAccessAgentScope(viewer, {
        scope_kind: 'tenant',
        tier: 'public',
        tenant_slug: 'tenant-a',
      })
    ).toBe(false);
  });

  it('does not expose a missing runtime scope to a broad viewer', () => {
    expect(
      chronosViewerCanAccessAgentScope({ tenantSlugs: 'all', tierAccess: ['public'] }, undefined)
    ).toBe(false);
  });
});

describe('parseChronosAgentsBody', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['malformed action', { action: { value: 'spawn' } }],
    ['unsupported action', { action: 'delete_everything' }],
    ['unknown field', { query: 'hello', unsupported: true }],
    ['non-string agent id', { action: 'logs', agentId: [] }],
    ['invalid limit', { action: 'logs', agentId: 'agent-1', limit: 0 }],
    ['non-string capabilities', { action: 'spawn', provider: 'claude', capabilities: ['ok', 1] }],
    ['unknown field', { action: 'spawn', provider: 'claude', unsupported: true }],
    ['oversized query', { action: 'ask', agentId: 'agent-1', query: 'x'.repeat(100_001) }],
  ])('rejects %s before runtime dispatch', (_label, body) => {
    expect(parseChronosAgentsBody(body)).toMatchObject({ ok: false });
  });

  it('requires action-specific fields and accepts a strict spawn body', () => {
    expect(parseChronosAgentsBody({ action: 'ask', agentId: 'agent-1' })).toMatchObject({
      ok: false,
    });
    expect(
      parseChronosAgentsBody({
        action: 'spawn',
        provider: 'claude',
        capabilities: ['reasoning'],
        runtimeMetadata: { tenant: 'tenant-a' },
      })
    ).toEqual({
      ok: true,
      action: 'spawn',
      body: {
        action: 'spawn',
        provider: 'claude',
        capabilities: ['reasoning'],
        runtimeMetadata: { tenant: 'tenant-a' },
      },
    });
  });

  it('requires a structured A2A envelope and delete-style agent id', () => {
    expect(parseChronosAgentsBody({ action: 'a2a', envelope: {} })).toMatchObject({ ok: false });
    expect(parseChronosAgentsBody({}, { requireAgentId: true })).toMatchObject({ ok: false });
    expect(parseChronosAgentsBody({ agentId: 'agent-1' }, { requireAgentId: true })).toMatchObject({
      ok: true,
    });
  });

  it('requires an action id only for manual execution', () => {
    expect(parseChronosAgentsBody({ action: 'manual_peek', agentId: 'agent-1' })).toMatchObject({
      ok: true,
    });
    expect(parseChronosAgentsBody({ action: 'manual_execute', agentId: 'agent-1' })).toMatchObject({
      ok: false,
    });
    expect(
      parseChronosAgentsBody({ action: 'manual_execute', agentId: 'agent-1', actionId: 'step-1' })
    ).toMatchObject({ ok: true });
    expect(
      parseChronosAgentsBody({ action: 'manual_peek', agentId: 'agent-1', actionId: [] })
    ).toMatchObject({ ok: false });
    expect(parseChronosAgentsBody({ action: 'manual_status', agentId: 'agent-1' })).toMatchObject({
      ok: false,
    });
    expect(
      parseChronosAgentsBody({
        action: 'manual_status',
        agentId: 'agent-1',
        commandId: 'command-1',
      })
    ).toMatchObject({ ok: true });
    expect(
      parseChronosAgentsBody({
        action: 'manual_cancel',
        agentId: 'agent-1',
        commandId: 'command-1',
      })
    ).toMatchObject({ ok: true });
    expect(parseChronosAgentsBody({ action: 'manual_cancel', agentId: 'agent-1' })).toMatchObject({
      ok: false,
    });
    expect(parseChronosAgentsBody({ action: 'manual_resume', agentId: 'agent-1' })).toMatchObject({
      ok: false,
    });
    expect(
      parseChronosAgentsBody({
        action: 'manual_resume',
        agentId: 'agent-1',
        commandId: 'command-1',
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects empty or oversized capabilities before runtime dispatch', () => {
    expect(
      parseChronosAgentsBody({ action: 'spawn', provider: 'claude', capabilities: [''] })
    ).toMatchObject({ ok: false });
    expect(
      parseChronosAgentsBody({
        action: 'spawn',
        provider: 'claude',
        capabilities: Array.from({ length: 65 }, () => 'reasoning'),
      })
    ).toMatchObject({ ok: false });
  });
});

describe('parseChronosAgentBody', () => {
  it('accepts a normal chat request and the governed mission action', () => {
    expect(parseChronosAgentBody({ query: 'status', locale: 'en' })).toMatchObject({
      ok: true,
      query: 'status',
      requesterId: 'chronos-ui',
    });
    expect(
      parseChronosAgentBody({ action: 'approve_mission', sessionId: 'proposal-1' })
    ).toMatchObject({ ok: true, query: undefined });
  });

  it.each([
    ['unknown field', { query: 'status', unsupported: true }],
    ['unsupported action', { action: 'restart_runtime' }],
    ['object query', { query: { value: 'status' } }],
    ['oversized query', { query: 'x'.repeat(100_001) }],
    ['object locale', { query: 'status', locale: { value: 'en' } }],
  ])('rejects %s before conversation dispatch', (_label, body) => {
    expect(parseChronosAgentBody(body)).toMatchObject({ ok: false });
  });
});
