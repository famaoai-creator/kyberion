import { describe, expect, it } from 'vitest';
import { buildAgentSessionBlocks, type AgentSessionSources } from './workspace-agent-sessions.js';
import type { CoSessionActivity } from '../workforce/co-session.js';
import type { DelegatedTaskRecord } from '../workforce/delegated-task-observability.js';

const range = { from: '2026-11-16', to: '2026-11-22' };

function sources(partial: Partial<AgentSessionSources>): AgentSessionSources {
  return { coSessions: () => [], delegations: () => [], ...partial };
}

function coSession(events: CoSessionActivity['events']): CoSessionActivity {
  return {
    record: {
      session_id: 'cs-1',
      goal: 'registry split',
      status: 'closed',
      checkout_root: '/tmp/x',
      created_at: '2026-11-17T09:00:00Z',
      created_by: 'claude',
    },
    events,
  };
}

const ev = (type: CoSessionActivity['events'][number]['type'], at: string, actor?: string) => ({
  event_id: `e-${at}-${type}`,
  session_id: 'cs-1',
  type,
  at,
  ...(actor ? { actor_provider: actor as never } : {}),
});

describe('buildAgentSessionBlocks', () => {
  it('projects a co-session participant window from joined to left', () => {
    const { blocks } = buildAgentSessionBlocks(
      sources({
        coSessions: () => [
          coSession([
            ev('session_started', '2026-11-17T09:00:00Z', 'claude'),
            ev('session_joined', '2026-11-17T09:10:00Z', 'codex'),
            ev('session_left', '2026-11-17T12:00:00Z', 'codex'),
            ev('session_closed', '2026-11-17T13:00:00Z'),
          ]),
        ],
      }),
      { range, viewerTenants: 'all' }
    );
    const codex = blocks.find((b) => b.provider === 'codex');
    expect(codex).toMatchObject({
      kind: 'co_session',
      startAt: '2026-11-17T09:10:00Z',
      endAt: '2026-11-17T12:00:00Z',
      status: 'closed',
      sessionId: 'cs-1',
    });
    const claude = blocks.find((b) => b.provider === 'claude');
    expect(claude?.endAt).toBe('2026-11-17T13:00:00Z');
  });

  it('drops blocks outside the range and keeps open sessions open', () => {
    const { blocks } = buildAgentSessionBlocks(
      sources({
        coSessions: () => [
          coSession([
            ev('session_started', '2026-10-01T00:00:00Z', 'claude'),
            ev('session_closed', '2026-10-02T00:00:00Z'),
          ]),
          {
            ...coSession([ev('session_started', '2026-11-21T20:00:00Z', 'devin')]),
            record: {
              session_id: 'cs-2',
              goal: 'live',
              status: 'open',
              checkout_root: '/tmp/x',
              created_at: '2026-11-21T20:00:00Z',
              created_by: 'devin',
            },
          },
        ],
      }),
      { range, viewerTenants: 'all', now: new Date('2026-11-22T00:00:00Z') }
    );
    expect(blocks.some((b) => b.sessionId === 'cs-1')).toBe(false);
    const live = blocks.find((b) => b.provider === 'devin');
    expect(live?.status).toBe('open');
    expect(live?.endAt).toBeUndefined();
  });

  it('projects delegations with provider, model and tenant fields', () => {
    const record = {
      delegation_id: 'd-1',
      kind: 'delegated_task',
      trace_id: 't-1',
      status: 'completed',
      created_at: '2026-11-18T10:00:00Z',
      completed_at: '2026-11-18T11:30:00Z',
      owner: 'ops',
      instruction: 'fix the golden gate\ndetail',
      backend_name: 'claude-cli',
      tenant_slug: 'acme',
      outcome: { served_model: 'claude-opus-4' },
    } as unknown as DelegatedTaskRecord;
    const seen: (readonly string[] | 'all')[] = [];
    const { blocks } = buildAgentSessionBlocks(
      sources({
        delegations: (tenants) => {
          seen.push(tenants);
          return [record];
        },
      }),
      { range, viewerTenants: ['acme'] }
    );
    expect(seen).toEqual([['acme']]);
    expect(blocks[0]).toMatchObject({
      kind: 'delegation',
      provider: 'claude-cli',
      model: 'claude-opus-4',
      tenantSlug: 'acme',
      title: 'fix the golden gate',
    });
  });

  it('reports a failing store in degraded without losing the other source', () => {
    const { blocks, degraded } = buildAgentSessionBlocks(
      sources({
        coSessions: () => {
          throw new Error('denied');
        },
      }),
      { range, viewerTenants: 'all' }
    );
    expect(degraded).toEqual(['co_sessions']);
    expect(blocks).toEqual([]);
  });
});
