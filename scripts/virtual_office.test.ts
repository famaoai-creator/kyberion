import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpRoot: string;
let mod: typeof import('./virtual_office.js');

describe('virtual office surface', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-office-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    // the @agent/core barrel eagerly compiles schemas at import time
    fs.cpSync(path.join(process.cwd(), 'schemas'), path.join(tmpRoot, 'schemas'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpRoot, 'knowledge', 'product'), { recursive: true });
    fs.cpSync(
      path.join(process.cwd(), 'knowledge', 'product', 'schemas'),
      path.join(tmpRoot, 'knowledge', 'product', 'schemas'),
      {
        recursive: true,
      }
    );
    process.env.KYBERION_ROOT = tmpRoot;

    // one active mission with mixed task states
    const missionDir = path.join(tmpRoot, 'active', 'missions', 'MSN-OFFICE-1');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(
      path.join(missionDir, 'mission-state.json'),
      JSON.stringify({ mission_id: 'MSN-OFFICE-1', status: 'active', mission_type: 'development' })
    );
    fs.writeFileSync(
      path.join(missionDir, 'NEXT_TASKS.json'),
      JSON.stringify([
        {
          task_id: 'T-1',
          status: 'in_progress',
          assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
          description: 'build the thing',
        },
        {
          task_id: 'T-2',
          status: 'blocked',
          assigned_to: { role: 'qa', agent_id: 'nerve-agent' },
          description: 'verify the thing',
        },
        { task_id: 'T-3', status: 'completed', assigned_to: { role: 'reviewer' } },
      ])
    );
    // one archived mission (must land on the shelf, not the floor)
    const archivedDir = path.join(tmpRoot, 'active', 'missions', 'MSN-OFFICE-OLD');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      path.join(archivedDir, 'mission-state.json'),
      JSON.stringify({ mission_id: 'MSN-OFFICE-OLD', status: 'archived' })
    );
    // performance index
    const perfDir = path.join(tmpRoot, 'active', 'shared', 'observability', 'retrospectives');
    fs.mkdirSync(perfDir, { recursive: true });
    fs.writeFileSync(
      path.join(perfDir, 'agent-performance.json'),
      JSON.stringify({
        by_agent_role: {
          'implementation-architect|implementer': {
            samples: 6,
            success: 5,
            review: 0,
            blocked: 1,
            success_rate: 0.83,
          },
        },
      })
    );
    const { createTaskSession } = await import('@agent/core');
    const session = createTaskSession({
      sessionId: 'TSK-TEST-VIRTUAL-OFFICE',
      surface: 'presence',
      taskType: 'analysis',
      status: 'executing',
      goal: {
        summary: '新しい virtual office の見せ方を整える',
        success_condition: '現在の作業内容が一目でわかる',
      },
      workLoop: {
        intent: { label: 'virtual-office' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'analysis',
        },
        workflow_design: {
          workflow_id: 'office-humanization',
          pattern: 'narrated',
          stage: 'observe',
          phases: ['collect', 'humanize', 'render'],
          rationale: 'make current work legible at a glance',
        },
        review_design: {
          review_mode: 'lean',
          required_gate_ids: [],
          all_gate_ids: [],
          rationale: 'test-only session',
        },
        outcome_design: {
          outcome_ids: [],
          labels: [],
        },
        process_design: {
          plan_outline: ['collect live sessions', 'render agent cards'],
          intake_requirements: [],
          operator_checklist: ['check the now-working panel'],
        },
        runtime_design: {
          owner_model: 'single_actor',
          assignment_policy: 'direct_specialist',
          coordination: {
            bus: 'none',
            channels: [],
          },
          memory: {
            store: 'none',
            scope: 'none',
            purpose: [],
          },
        },
        execution_boundary: {
          llm_zone: {
            allowed: [],
            forbidden: [],
          },
          knowledge_zone: {
            owns: [],
          },
          compiler_zone: {
            responsibilities: [],
          },
          executor_zone: {
            responsibilities: [],
          },
          rule: 'test-only',
        },
        teaming: {
          team_roles: ['implementer'],
        },
        authority: {
          requires_approval: false,
        },
        learning: {
          reusable_refs: [],
        },
      },
      payload: {
        agent_id: 'implementation-architect',
      },
    });
    session.history.push({
      ts: new Date().toISOString(),
      type: 'execution',
      text: 'Now Working に一言要約を出す',
    });
    session.completion_summary = {
      requested_result: '現在の作業の見える化',
      satisfied: false,
      delivered: [],
      gaps: ['still polishing'],
      next_step: 'エージェントカードに次の一手を載せる',
      confidence: 0.6,
      evidence_refs: [],
    };
    fs.mkdirSync(path.join(tmpRoot, 'active', 'shared', 'runtime', 'task-sessions'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        tmpRoot,
        'active',
        'shared',
        'runtime',
        'task-sessions',
        `${session.session_id}.json`
      ),
      JSON.stringify(session, null, 2)
    );

    mod = await import('./virtual_office.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collects rooms, agent states, performance, and archive shelf from disk', () => {
    const snapshot = mod.collectOfficeSnapshot();
    const room = snapshot.rooms.find((entry) => entry.mission_id === 'MSN-OFFICE-1');
    expect(room).toBeTruthy();
    expect(room!.tasks).toHaveLength(3);
    expect(snapshot.archived_recent).toContain('MSN-OFFICE-OLD');
    expect(snapshot.task_status_counts.in_progress).toBe(1);
    expect(snapshot.task_status_counts.blocked).toBe(1);

    const blocked = snapshot.agents.find((agent) => agent.agent_id === 'nerve-agent');
    expect(blocked?.state).toBe('blocked');
    const working = snapshot.agents.find((agent) => agent.agent_id === 'implementation-architect');
    expect(working?.state).toBe('working');
    expect(working?.current_story).toContain('手を動かしています');
    expect(working?.current_goal).toContain('virtual office');
    expect(snapshot.live_sessions[0]?.surface).toBe('presence');
    expect(snapshot.live_sessions[0]?.agentIds).toContain('implementation-architect');

    expect(snapshot.performance[0]).toMatchObject({
      agent: 'implementation-architect',
      role: 'implementer',
      samples: 6,
    });
  });

  it('renders self-contained HTML with rooms, desks, and stats', () => {
    const snapshot = mod.collectOfficeSnapshot();
    const html = mod.renderOfficeHtml(snapshot, 30);
    expect(html).toContain('KYBERION VIRTUAL OFFICE');
    expect(html).toContain('MSN-OFFICE-1');
    expect(html).toContain('implementation-architect');
    expect(html).toContain('Now Working');
    expect(html).toContain('新しい virtual office の見せ方を整える');
    expect(html).toContain('http-equiv="refresh" content="30"');
    // self-contained: no external requests
    expect(html).not.toMatch(/src="http|href="http/);
    // archived mission is on the shelf, not a floor room
    expect(html.indexOf('MSN-OFFICE-OLD')).toBeGreaterThan(html.indexOf('Archive'));
  });

  it('office palette meets WCAG AA (design-qa dog-food)', async () => {
    const designQa = await import('@agent/core');
    const issues = designQa.validateThemeContrast({
      background: '#020617',
      surface: '#0f172a',
      text: '#F8FAFC',
      muted_text: '#94a3b8',
      accent: '#00F2FF',
    });
    expect(issues.filter((issue) => issue.severity === 'must_fix')).toEqual([]);
  });
});
