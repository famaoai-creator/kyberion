/**
 * Devin CLI custom-subagent projection.
 *
 * Kyberion role definitions are provider-neutral. Devin CLI loads custom
 * subagent profiles from `.devin/agents/` (and `.agents/agents/`), where the
 * `allowed-tools:` frontmatter is a strict allowlist interpreted against
 * Devin's own tool vocabulary, so the translation lives at this concrete
 * boundary instead of leaking Devin names into the shared capability
 * registry.
 *
 * Devin profile names intentionally reuse the bare team-role name
 * (`implementer`, `reviewer`, …) rather than the `kyberion-*` AGY prefix:
 * Devin also scans `.agents/agents/`, so reusing the AGY names would make
 * the two projections collide inside the same Devin profile list.
 */

export type DevinAgentProfile = 'implementer' | 'explorer' | 'planner';

/**
 * Devin CLI tool names, deliberately kept separate from Claude's tools: list
 * and AGY's. `allowed-tools` on a subagent profile is a true restriction —
 * unlisted tools are unavailable to the subagent — so every capability the
 * tier needs must appear here. `glob` is the documented permission name for
 * the file-glob tool; `find_file_by_name` is listed alongside it so the
 * allowlist still matches on builds where the internal tool name is used
 * verbatim. Unknown names are inert (they simply match no tool), so listing
 * both is safe.
 */
export const DEVIN_PROFILE_TOOLS: Readonly<Record<DevinAgentProfile, readonly string[]>> = {
  implementer: [
    'read',
    'edit',
    'write',
    'grep',
    'glob',
    'find_file_by_name',
    'exec',
    'get_output',
    'kill_shell',
    'write_to_process',
    'notebook_read',
    'notebook_edit',
  ],
  explorer: [
    'read',
    'grep',
    'glob',
    'find_file_by_name',
    'notebook_read',
    'web_search',
    'webfetch',
  ],
  planner: [],
};

export interface DevinAgentDefinitionInput {
  readonly role: string;
  readonly description: string;
  readonly profile: DevinAgentProfile;
  readonly body: string;
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderTools(tools: readonly string[]): string[] {
  if (tools.length === 0) return ['allowed-tools: []'];
  return ['allowed-tools:', ...tools.map((tool) => `  - ${tool}`)];
}

/** Build a Devin CLI custom-subagent definition from a provider-neutral body. */
export function buildDevinAgentDefinitionSource(input: DevinAgentDefinitionInput): string {
  const tools = DEVIN_PROFILE_TOOLS[input.profile];
  const frontmatter = [
    '---',
    `name: ${input.role}`,
    `description: ${yamlScalar(input.description)}`,
    ...renderTools(tools),
    '---',
  ].join('\n');

  const generatedHeader = [
    '<!--',
    'GENERATED FILE — DO NOT EDIT BY HAND.',
    'Regenerate with: pnpm agents:generate',
    'Check drift with: pnpm agents:generate -- --check',
    'Projection: Devin CLI custom subagent (`.devin/agents/<name>.md`)',
    'Source: Kyberion team-role, procedure, capability-profile, and working-principles SSoT',
    'Adapter: scripts/devin-agent-definition-adapter.ts',
    '-->',
  ].join('\n');

  return `${frontmatter}\n\n${generatedHeader}\n\n${input.body.trim()}\n`;
}
