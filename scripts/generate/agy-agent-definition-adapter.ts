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
 * AGY CLI tool names verified against the agy 1.4.11 binary and the vendor
 * custom-subagent docs. This list is the validation boundary: vendor docs
 * warn that an unmapped or misspelled tool name can hang a subagent, so
 * {@link AGY_PROFILE_TOOLS} entries are checked against this set in tests
 * rather than trusted to be right.
 */
export const AGY_KNOWN_TOOLS: readonly string[] = [
  'view_file',
  'view_code_item',
  'view_file_outline',
  'view_content_chunk',
  'grep_search',
  'search_in_file',
  'find_by_name',
  'list_dir',
  'read_terminal',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'run_command',
  'command_status',
  'search_web',
  'read_url_content',
  'invoke_subagent',
  'define_subagent',
  'notify_user',
  'memory',
  'trajectory_search',
];

/**
 * AGY CLI tool names, deliberately kept separate from Claude's tools: list.
 * These names are the public custom-subagent vocabulary documented by AGY.
 * `write_to_file` is the create-file tool — without it an implementer-tier
 * agent can edit but can never create files.
 */
export const AGY_PROFILE_TOOLS: Readonly<Record<AgyAgentProfile, readonly string[]>> = {
  implementer: [
    'view_file',
    'view_code_item',
    'grep_search',
    'find_by_name',
    'list_dir',
    'read_terminal',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'run_command',
  ],
  explorer: [
    'view_file',
    'view_code_item',
    'grep_search',
    'find_by_name',
    'list_dir',
    'search_web',
    'read_url_content',
  ],
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
