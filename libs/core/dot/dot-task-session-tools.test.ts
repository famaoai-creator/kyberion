import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import {
  createDotTaskSessionToolRuntime,
  DOT_TASK_SESSION_TOOL_NAMES,
} from './dot-task-session-tools.js';

function makeCharter(overrides: Partial<DotCharter> = {}): DotCharter {
  return {
    dot_id: 'ops-dot',
    version: '1.0.0',
    title: 'Ops Dot',
    purpose: 'Execute scoped tasks',
    status: 'active',
    scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' },
    goal: { statement: 'Assist ops' },
    attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_execution_shapes: ['task_session', 'direct_reply'],
    },
    decisions: { default_decision: 'notify' },
    notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'dot-ops' },
    ...overrides,
  } as DotCharter;
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    item_id: 'WI-TS-1',
    title: 'Prepare summary',
    description: 'Search knowledge and write report',
    status: 'in_progress',
    version: 2,
    created_at: '2026-11-25T00:00:00Z',
    current_attempt_id: 'att-1',
    lease_id: 'lease-1',
    context: { tier: 'confidential', tenant_slug: 'acme', mission_id: 'MSN-1' },
    metadata: { dot_id: 'ops-dot', requested_execution_shape: 'task_session' },
    ...overrides,
  } as WorkItem;
}

describe('dot-task-session-tools', () => {
  const tmpRoot = pathResolver.sharedTmp(`dot-task-session-tools-${process.pid}`);

  beforeEach(() => {
    safeRmSync(tmpRoot, { recursive: true, force: true });
    safeMkdir(path.join(tmpRoot, 'knowledge/public/dir-entry'), { recursive: true });
    safeMkdir(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-1/projects/proj-1'),
      {
        recursive: true,
      }
    );
    safeMkdir(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-1/projects/proj-2'),
      {
        recursive: true,
      }
    );
    safeMkdir(path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-2'), {
      recursive: true,
    });
    safeMkdir(path.join(tmpRoot, 'knowledge/confidential/globex'), { recursive: true });
    safeWriteFile(path.join(tmpRoot, 'knowledge/public/guide.md'), '# Public Guide\n');
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/acme/tenant-wide.md'),
      '# Acme Tenant Wide\n'
    );
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-1/runbook.md'),
      '# Acme Org-1 Runbook\n'
    );
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-1/projects/proj-1/spec.md'),
      '# Proj-1 Spec\n'
    );
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-1/projects/proj-2/spec.md'),
      '# Proj-2 Secret\n'
    );
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/acme/organizations/org-2/other.md'),
      '# Acme Org-2 Other\n'
    );
    safeWriteFile(
      path.join(tmpRoot, 'knowledge/confidential/globex/secret-plan.md'),
      '# Globex Only\n'
    );
    safeWriteFile(path.join(tmpRoot, 'knowledge/public/.env.local'), 'TOKEN=nope\n');
  });

  afterEach(() => {
    safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('exposes the 4 governed task_session tools and runs search -> deliverable -> cite end to end', async () => {
    const recordDelivery = vi.fn((input) => ({
      deliveryRecordPath: 'delivery.jsonl',
      refs: input.refs.map((ref: Record<string, unknown>) => ({ ...ref, delivery_id: 'del-1' })),
    }));
    const recordUsage = vi.fn(() => ({ usageUpdated: true, promotionCandidateIds: [] }));
    const writeArtifact = vi.fn((input) => ({
      absolute_path: path.join(
        tmpRoot,
        'active/shared/artifacts/confidential/acme/report',
        input.name
      ),
      repo_relative_path: `active/shared/artifacts/confidential/acme/report/${input.name}`,
      index_path: path.join(
        tmpRoot,
        'active/shared/artifacts/confidential/acme/artifacts-index.jsonl'
      ),
      scope_kind: 'tenant' as const,
    }));
    const audit = vi.fn();

    const runtime = createDotTaskSessionToolRuntime({
      charter: makeCharter(),
      item: makeItem(),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      findKnowledge: vi.fn(async () => [
        {
          path: 'knowledge/product/evolution/wisdom/generated/ops.md',
          title: 'Ops pattern',
          excerpt: 'Check lease before write',
          tags: ['ops'],
          score: 0.9,
        },
      ]),
      recordDelivery: recordDelivery as never,
      recordUsage: recordUsage as never,
      writeArtifact: writeArtifact as never,
      audit,
    });

    expect(runtime.definitions.map((d) => d.name)).toEqual([...DOT_TASK_SESSION_TOOL_NAMES]);

    const readRes = await runtime.executeTool({
      name: 'dot_read_scoped_file',
      input: { path: 'knowledge/confidential/acme/organizations/org-1/runbook.md' },
    });
    expect(JSON.parse(readRes.resultText).content).toContain('Acme Org-1 Runbook');

    const searchRes = await runtime.executeTool({
      name: 'dot_search_knowledge',
      input: { topic: 'ops lease', limit: 3 },
    });
    expect(JSON.parse(searchRes.resultText).hits).toHaveLength(1);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ recipientKind: 'dot_task_session' })
    );

    const writeRes = await runtime.executeTool({
      name: 'dot_write_scoped_deliverable',
      input: { name: 'ops-summary.md', content: '# Summary\nAll good.\n' },
    });
    expect(writeRes.externalEffect).toBe(true);
    expect(JSON.parse(writeRes.resultText).path).toContain('dot-ops-dot/WI-TS-1/ops-summary.md');

    const citeRes = await runtime.executeTool({
      name: 'dot_cite_knowledge_used',
      input: {
        document_path: 'knowledge/product/evolution/wisdom/generated/ops.md',
        useful: true,
      },
    });
    expect(JSON.parse(citeRes.resultText)).toMatchObject({ useful: true, usage_updated: true });
    expect(recordUsage).toHaveBeenCalledTimes(1);

    const summary = runtime.getSummary();
    expect(summary.toolCalls).toBe(4);
    expect(summary.readPaths).toEqual([
      'knowledge/confidential/acme/organizations/org-1/runbook.md',
    ]);
    expect(summary.deliveredKnowledgePaths).toEqual([
      'knowledge/product/evolution/wisdom/generated/ops.md',
    ]);
    expect(summary.citedKnowledgePaths).toEqual([
      'knowledge/product/evolution/wisdom/generated/ops.md',
    ]);
    expect(summary.deliverables).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(4);
  });

  it('denies cross-tenant reads, traversal, directories, and .env files', async () => {
    const runtime = createDotTaskSessionToolRuntime({
      charter: makeCharter(),
      item: makeItem(),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      audit: vi.fn(),
    });

    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/confidential/globex/secret-plan.md' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/public/../../etc/passwd' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/public/dir-entry' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/public/.env.local' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);
  });

  it('fails closed when lease assertion fails or tool-call budget is exceeded', async () => {
    let active = true;
    const runtime = createDotTaskSessionToolRuntime({
      charter: makeCharter(),
      item: makeItem(),
      rootDir: tmpRoot,
      maxToolCalls: 1,
      assertCurrent: () => {
        if (!active) throw new Error('lease expired');
      },
      audit: vi.fn(),
    });

    await runtime.executeTool({
      name: 'dot_read_scoped_file',
      input: { path: 'knowledge/public/guide.md' },
    });
    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/public/guide.md' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_BUDGET_EXCEEDED/);

    active = false;
    await expect(
      runtime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/public/guide.md' },
      })
    ).rejects.toThrow(/lease expired/);
  });

  it('refuses citing knowledge that was not delivered in the session', async () => {
    const runtime = createDotTaskSessionToolRuntime({
      charter: makeCharter(),
      item: makeItem(),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      audit: vi.fn(),
    });

    await expect(
      runtime.executeTool({
        name: 'dot_cite_knowledge_used',
        input: {
          document_path: 'knowledge/product/evolution/wisdom/generated/unseen.md',
          useful: true,
        },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);
  });

  it('enforces organization, project, personal owner_nhi, and item context coherence', async () => {
    const orgRuntime = createDotTaskSessionToolRuntime({
      charter: makeCharter(),
      item: makeItem(),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      audit: vi.fn(),
    });
    await expect(
      orgRuntime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/confidential/acme/organizations/org-2/other.md' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);
    await expect(
      orgRuntime.executeTool({
        name: 'dot_read_scoped_file',
        input: { path: 'knowledge/confidential/acme/tenant-wide.md' },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    const projRuntime = createDotTaskSessionToolRuntime({
      charter: makeCharter({
        scope: {
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'org-1',
          project_id: 'proj-1',
        },
      }),
      item: makeItem({
        context: {
          tenant_slug: 'acme',
          organization_id: 'org-1',
          project_id: 'proj-1',
        },
      }),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      audit: vi.fn(),
    });
    const okProj = await projRuntime.executeTool({
      name: 'dot_read_scoped_file',
      input: {
        path: 'knowledge/confidential/acme/organizations/org-1/projects/proj-1/spec.md',
      },
    });
    expect(JSON.parse(okProj.resultText).content).toContain('Proj-1 Spec');
    await expect(
      projRuntime.executeTool({
        name: 'dot_read_scoped_file',
        input: {
          path: 'knowledge/confidential/acme/organizations/org-1/projects/proj-2/spec.md',
        },
      })
    ).rejects.toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    expect(() =>
      createDotTaskSessionToolRuntime({
        charter: makeCharter({ scope: { tier: 'personal' } }),
        item: makeItem({ context: {} }),
        rootDir: tmpRoot,
        assertCurrent: () => undefined,
        audit: vi.fn(),
      })
    ).toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    expect(() =>
      createDotTaskSessionToolRuntime({
        charter: makeCharter(),
        item: makeItem({
          context: {
            tenant_slug: 'acme',
            organization_id: 'org-2',
          },
        }),
        rootDir: tmpRoot,
        assertCurrent: () => undefined,
        audit: vi.fn(),
      })
    ).toThrow(/DOT_TASK_TOOL_SCOPE_DENIED/);

    const writeArtifact = vi.fn((input) => ({
      absolute_path: path.join(tmpRoot, input.name),
      repo_relative_path: `active/shared/artifacts/personal/shared/report/${input.name}`,
      index_path: path.join(tmpRoot, 'artifacts-index.jsonl'),
      scope_kind: 'tenant' as const,
    }));
    const personalRuntime = createDotTaskSessionToolRuntime({
      charter: makeCharter({ scope: { tier: 'personal', owner_nhi: 'user:alice' } }),
      item: makeItem({ context: {}, assignee_user_id: 'user:alice' }),
      rootDir: tmpRoot,
      assertCurrent: () => undefined,
      writeArtifact: writeArtifact as never,
      audit: vi.fn(),
    });
    const personalRes = await personalRuntime.executeTool({
      name: 'dot_write_scoped_deliverable',
      input: { name: 'note.md', content: '# Personal Note\n' },
    });
    expect(JSON.parse(personalRes.resultText).path).toMatch(/owners\/[0-9a-f]{12}\/dot-ops-dot/);
  });
});
