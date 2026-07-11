import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpRoot: string;
let mod: typeof import('./virtual_office.js');

describe('virtual office surface', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-office-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    // the @agent/core barrel eagerly compiles schemas at import time
    const repoSchemas = fileURLToPath(new URL('../schemas', import.meta.url));
    fs.cpSync(repoSchemas, path.join(tmpRoot, 'schemas'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'knowledge', 'product'), { recursive: true });
    fs.cpSync(
      fileURLToPath(new URL('../knowledge/product/schemas', import.meta.url)),
      path.join(tmpRoot, 'knowledge', 'product', 'schemas'),
      { recursive: true }
    );
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.KYBERION_CUSTOMER = 'acme';

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
    const otherMissionDir = path.join(tmpRoot, 'active', 'missions', 'MSN-OFFICE-2');
    fs.mkdirSync(otherMissionDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherMissionDir, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'MSN-OFFICE-2',
        status: 'active',
        mission_type: 'operations',
        tenant_slug: 'beta',
      })
    );
    fs.writeFileSync(
      path.join(otherMissionDir, 'NEXT_TASKS.json'),
      JSON.stringify([
        {
          task_id: 'T-9',
          status: 'in_progress',
          assigned_to: { role: 'operator', agent_id: 'nerve-agent' },
          description: 'should stay hidden from acme',
        },
      ])
    );
    // one archived mission (must land on the shelf, not the floor)
    const archivedDir = path.join(tmpRoot, 'active', 'missions', 'MSN-OFFICE-OLD');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      path.join(archivedDir, 'mission-state.json'),
      JSON.stringify({ mission_id: 'MSN-OFFICE-OLD', status: 'archived', tenant_slug: 'acme' })
    );
    const customerRoot = path.join(tmpRoot, 'customer', 'acme');
    fs.mkdirSync(customerRoot, { recursive: true });
    fs.writeFileSync(
      path.join(customerRoot, 'organization-profile.json'),
      JSON.stringify(
        {
          $schema: 'https://kyberion.local/schemas/organization-profile.schema.json',
          version: '1.0.0',
          organization_id: 'acme',
          name: 'Acme Org',
          mission_defaults: {
            default_mission_class: 'operations_and_release',
            default_team_template: 'default',
            default_agent_profile: 'implementation-architect',
          },
          team_defaults: {
            default_team_template: 'default',
            team_template_catalog_id: 'default',
            default_lifecycle_template: 'default',
            max_parallel_missions: 4,
          },
          llm: {
            default_profile: 'standard',
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(customerRoot, 'org-chart.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          organization_id: 'acme',
          name: 'Acme Org Chart',
          source_kind: 'customer',
          source_path: 'customer/acme/org-chart.json',
          domains: [
            {
              domain_id: 'delivery',
              name: 'Delivery',
              role_ids: ['planner', 'implementer'],
            },
          ],
          positions: [
            {
              role_id: 'planner',
              reports_to: null,
              held_by: 'implementation-architect',
              responsibility_scope: 'mission intake and sequencing',
              authority_role_ref: 'ecosystem_architect',
            },
            {
              role_id: 'implementer',
              reports_to: 'planner',
              held_by: 'implementation-architect',
              responsibility_scope: 'build execution',
              authority_role_ref: 'software_developer',
            },
          ],
        },
        null,
        2
      )
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
    delete process.env.KYBERION_CUSTOMER;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collects rooms, agent states, performance, and archive shelf from disk', () => {
    const snapshot = mod.collectOfficeSnapshot();
    expect(snapshot.tenant_slug).toBe('acme');
    expect(snapshot.organization?.organization_id).toBe('acme');
    expect(snapshot.organization_chart?.name).toBe('Acme Org Chart');
    const room = snapshot.rooms.find((entry) => entry.mission_id === 'MSN-OFFICE-1');
    expect(room).toBeTruthy();
    expect(room!.tasks).toHaveLength(3);
    expect(snapshot.rooms.map((entry) => entry.mission_id)).not.toContain('MSN-OFFICE-2');
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
    expect(html).toContain('tenant acme');
    expect(html).toContain('Acme Org Chart');
    expect(html).toContain('MSN-OFFICE-1');
    expect(html).toContain('implementation-architect');
    expect(html).toContain('planner');
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
