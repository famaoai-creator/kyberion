/**
 * Cursor custom-subagent projection.
 *
 * Kyberion role definitions are provider-neutral. Cursor loads custom
 * subagents from `.cursor/agents/<name>.md` (also reads `.claude/agents/`
 * and `.codex/agents/` for compatibility). Cursor does **not** support a
 * per-tool allowlist in frontmatter — subagents inherit the parent's tool
 * surface (including MCP). The only frontmatter restriction is
 * `readonly: true`, which blocks file edits and state-changing shell.
 * Capability tiers therefore project to `readonly` rather than a tool list;
 * Claude/AGY/Devin tool names must never leak into Cursor frontmatter.
 *
 * Docs: https://cursor.com/docs/subagents
 */

export type CursorAgentProfile = 'implementer' | 'explorer' | 'planner';

/**
 * Whether the KD-05 tier should run with Cursor's `readonly` flag.
 * Explorer / planner are read-only tiers; implementer may write and exec.
 */
export const CURSOR_PROFILE_READONLY: Readonly<Record<CursorAgentProfile, boolean>> = {
  implementer: false,
  explorer: true,
  planner: true,
};

export interface CursorAgentDefinitionInput {
  readonly role: string;
  readonly description: string;
  readonly profile: CursorAgentProfile;
  readonly body: string;
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build a Cursor custom-subagent definition from a provider-neutral body. */
export function buildCursorAgentDefinitionSource(input: CursorAgentDefinitionInput): string {
  const readonly = CURSOR_PROFILE_READONLY[input.profile];
  const frontmatter = [
    '---',
    `name: ${input.role}`,
    `description: ${yamlScalar(input.description)}`,
    'model: inherit',
    `readonly: ${readonly}`,
    '---',
  ].join('\n');

  const generatedHeader = [
    '<!--',
    'GENERATED FILE — DO NOT EDIT BY HAND.',
    'Regenerate with: pnpm agents:generate',
    'Check drift with: pnpm agents:generate -- --check',
    'Projection: Cursor custom subagent (`.cursor/agents/<name>.md`)',
    'Source: Kyberion team-role, procedure, capability-profile, and working-principles SSoT',
    'Adapter: scripts/cursor-agent-definition-adapter.ts',
    'Note: Cursor has no per-tool allowlist; capability is enforced via readonly + prompt body.',
    '-->',
  ].join('\n');

  return `${frontmatter}\n\n${generatedHeader}\n\n${input.body.trim()}\n`;
}
