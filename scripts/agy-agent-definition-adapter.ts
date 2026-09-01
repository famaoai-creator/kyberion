/**
 * AGY custom-agent projection.
 *
 * Kyberion role definitions are provider-neutral. AGY's CLI has its own
 * Markdown frontmatter and tool vocabulary, so the translation lives at this
 * concrete boundary instead of leaking AGY names into the shared capability
 * registry.
 */

export type AgyAgentProfile = 'implementer' | 'explorer' | 'planner';

export const AGY_AGENT_NAME_PREFIX = 'kyberion-';

/**
 * AGY CLI tool names, deliberately kept separate from Claude's tools: list.
 * These names are the public custom-subagent vocabulary documented by AGY.
 */
export const AGY_PROFILE_TOOLS: Readonly<Record<AgyAgentProfile, readonly string[]>> = {
  implementer: ['view_file', 'grep_search', 'replace_file_content', 'run_command'],
  explorer: ['view_file', 'grep_search'],
  planner: [],
};

export interface AgyAgentDefinitionInput {
  readonly role: string;
  readonly description: string;
  readonly profile: AgyAgentProfile;
  readonly body: string;
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderTools(tools: readonly string[]): string[] {
  if (tools.length === 0) return ['tools: []'];
  return ['tools:', ...tools.map((tool) => `  - ${tool}`)];
}

export function agyAgentName(role: string): string {
  return `${AGY_AGENT_NAME_PREFIX}${role.replaceAll('_', '-')}`;
}

/** Build an AGY CLI custom-subagent definition from a provider-neutral body. */
export function buildAgyAgentDefinitionSource(input: AgyAgentDefinitionInput): string {
  const tools = AGY_PROFILE_TOOLS[input.profile];
  const frontmatter = [
    '---',
    `name: ${agyAgentName(input.role)}`,
    `description: ${yamlScalar(input.description)}`,
    ...renderTools(tools),
    'subagent: true',
    'mainAgent: true',
    'model: inherit',
    'commandExecutionPolicy: sandbox',
    '---',
  ].join('\n');

  const generatedHeader = [
    '<!--',
    'GENERATED FILE — DO NOT EDIT BY HAND.',
    'Regenerate with: pnpm agents:generate',
    'Check drift with: pnpm agents:generate -- --check',
    'Projection: AGY CLI custom subagent (`.agents/agents/<name>/agent.md`)',
    'Source: Kyberion team-role, procedure, capability-profile, and working-principles SSoT',
    'Adapter: scripts/agy-agent-definition-adapter.ts',
    '-->',
  ].join('\n');

  return `${frontmatter}\n\n${generatedHeader}\n\n${input.body.trim()}\n`;
}

/** Remove the source provider's frontmatter while preserving its governed body. */
export function extractAgentDefinitionBody(source: string): string {
  const match = source.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match?.[1]?.trim() || source.trim();
}
