import { describe, expect, it, vi } from 'vitest';
import { executeServiceProcedure, resolveServiceParams } from './service-procedure-executor.js';
import type { ServiceRecording } from './service-recording.js';

function rec(overrides: Partial<ServiceRecording> = {}): ServiceRecording {
  return {
    schema_version: 'service-recording.v1',
    recording_id: 'svc-1',
    source: 'service-capture',
    created_at: '2026-06-24T00:00:00.000Z',
    target: { name: 'Deal Intake', services: ['jira', 'slack'] },
    steps: [
      { step_id: 's1', service_id: 'jira', action: 'create_issue', summary: '起票', risk_class: 'high', params: { summary: '{{input.title}}' }, produces: 'issue_key' },
      { step_id: 's2', service_id: 'slack', action: 'post_message', summary: '通知', risk_class: 'high', params: { text: 'issue {{channel.issue_key}} created' }, consumes: ['issue_key'] },
    ],
    risk_summary: { requires_manual_review: true, approval_required_count: 2 },
    ...overrides,
  };
}

describe('resolveServiceParams', () => {
  it('resolves an exact input placeholder to the raw value (keeps type)', () => {
    expect(resolveServiceParams('{{input.count}}', { count: 5 }, {})).toBe(5);
  });
  it('interpolates placeholders inside a larger string', () => {
    expect(resolveServiceParams('issue {{channel.k}} done', {}, { k: 'ABC-1' })).toBe('issue ABC-1 done');
  });
  it('recurses into objects and arrays', () => {
    const out = resolveServiceParams({ a: ['{{input.x}}'], b: { c: '{{channel.y}}' } }, { x: 'X' }, { y: 'Y' });
    expect(out).toEqual({ a: ['X'], b: { c: 'Y' } });
  });
});

describe('executeServiceProcedure', () => {
  it('threads produces → consumes across steps and completes', async () => {
    const calls: any[] = [];
    const executePreset = vi.fn(async (service: string, action: string, params: any) => {
      calls.push({ service, action, params });
      return action === 'create_issue' ? 'JIRA-42' : { ok: true };
    });
    const result = await executeServiceProcedure({
      recording: rec(),
      inputs: { title: 'New deal' },
      externalEffectApproved: true,
      executePreset,
    });
    expect(result.status).toBe('completed');
    expect(calls[0].params).toEqual({ summary: 'New deal' });
    // step 2 consumed the produced channel value
    expect(String(calls[1].params.text)).toContain('JIRA-42');
    expect(result.channels.issue_key).toBe('JIRA-42');
  });

  it('blocks external-effect steps when not approved', async () => {
    const executePreset = vi.fn();
    const result = await executeServiceProcedure({ recording: rec(), externalEffectApproved: false, executePreset });
    expect(result.status).toBe('blocked');
    expect(executePreset).not.toHaveBeenCalled();
  });

  it('skips external-effect steps in dry-run', async () => {
    const executePreset = vi.fn(async () => ({ ok: true }));
    const result = await executeServiceProcedure({ recording: rec(), externalEffectApproved: true, dryRun: true, executePreset });
    expect(result.status).toBe('completed');
    expect(result.results.every((r) => r.status === 'skipped')).toBe(true);
    expect(executePreset).not.toHaveBeenCalled();
  });

  it('returns failed and stops when a step throws', async () => {
    const executePreset = vi.fn(async () => { throw new Error('503 from jira'); });
    const result = await executeServiceProcedure({ recording: rec(), externalEffectApproved: true, executePreset });
    expect(result.status).toBe('failed');
    expect(result.results[0].status).toBe('error');
    expect(result.results).toHaveLength(1); // stopped after the failure
  });
});
