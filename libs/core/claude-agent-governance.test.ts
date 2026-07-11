import { describe, expect, it, vi } from 'vitest';

vi.mock('./tier-guard.js', () => ({
  detectTier: (p: string) =>
    p.includes('knowledge/personal')
      ? 'personal'
      : p.includes('knowledge/confidential')
        ? 'confidential'
        : 'public',
  validateWritePermission: (p: string) =>
    p.includes('knowledge/personal')
      ? { allowed: false, reason: 'not authorized' }
      : { allowed: true },
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn(() => ({ id: 'AUD-1' })) } }));
// SA-05 Task 3.3: require_approval routes through the approval gate; keep
// unit tests hermetic — the pending path (allowed: false) is the default.
vi.mock('./risky-op-registry.js', () => ({
  requireApprovalForOp: vi.fn(() => ({
    allowed: false,
    message: 'operator approval required',
  })),
}));
vi.mock('./shell-command-policy.js', () => ({
  evaluateShellCommandPolicy: (command: string) =>
    command.includes('pnpm install')
      ? {
          verdict: 'require_approval',
          command,
          executable: 'pnpm',
          args: ['install'],
          reason: 'Shell command requires approval under Kyberion governance.',
        }
      : {
          verdict: 'allow',
          command,
          executable: 'ls',
          args: [],
          reason: 'Allowed by shell command policy.',
        },
}));

import {
  GOVERNED_AGENT_ALLOWED_TOOLS,
  buildGovernedAgentSystemPrompt,
  buildKyberionMcpServerConfig,
  createKyberionCanUseTool,
} from './claude-agent-governance.js';

const opts = { signal: new AbortController().signal } as any;

describe('claude-agent-governance — canUseTool gate', () => {
  const gate = createKyberionCanUseTool();

  it('allows read-only tools', async () => {
    expect((await gate('Read', { file_path: 'x' }, opts)).behavior).toBe('allow');
    expect((await gate('Grep', { pattern: 'x' }, opts)).behavior).toBe('allow');
  });

  it('allows governed kyberion.* MCP tools', async () => {
    const r = await gate(
      'mcp__kyberion__kyberion.pipeline.run',
      { input: 'pipelines/x.json' },
      opts
    );
    expect(r.behavior).toBe('allow');
  });

  it('tier-guards file writes: denies protected tier, allows source', async () => {
    const denied = await gate('Write', { file_path: 'knowledge/personal/s.md' }, opts);
    expect(denied.behavior).toBe('deny');
    if (denied.behavior === 'deny') expect(denied.message).toContain('personal tier');

    const allowed = await gate('Edit', { file_path: 'libs/core/x.ts' }, opts);
    expect(allowed.behavior).toBe('allow');
  });

  it('policy-gates Bash and denies unknown tools (least privilege)', async () => {
    expect((await gate('Bash', { command: 'ls' }, opts)).behavior).toBe('allow');
    const denied = await gate('Bash', { command: 'pnpm install' }, opts);
    expect(denied.behavior).toBe('deny');
    if (denied.behavior === 'deny') expect(denied.message).toContain('approval');
    const unknown = await gate('SomeRandomTool', {}, opts);
    expect(unknown.behavior).toBe('deny');
  });
});

describe('claude-agent-governance — config + prompt', () => {
  it('builds a stdio MCP config pointing at the kyberion server', () => {
    const cfg = buildKyberionMcpServerConfig('/repo');
    expect(cfg.kyberion).toBeDefined();
    expect((cfg.kyberion as any).command).toBe('node');
    expect((cfg.kyberion as any).args[0]).toContain('mcp_server.js');
  });

  it('allowlist includes governed file + read tools', () => {
    expect(GOVERNED_AGENT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(['Read', 'Write', 'Bash']));
  });

  it('system prompt injects deterministic-first + tier rules + context', () => {
    const p = buildGovernedAgentSystemPrompt({
      base: 'BASE',
      missionContext: 'MSN-1 goal',
      tierScope: 'confidential/acme',
    });
    expect(p).toContain('BASE');
    expect(p).toContain('deterministic-first');
    expect(p).toContain('knowledge/confidential');
    expect(p).toContain('MSN-1 goal');
    expect(p).toContain('confidential/acme');
  });
});
