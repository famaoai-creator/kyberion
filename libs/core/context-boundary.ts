export const AGENT_CONTEXT_MODES = ['fresh', 'continue'] as const;

export type AgentContextMode = (typeof AGENT_CONTEXT_MODES)[number];

export function normalizeAgentContextMode(
  value: unknown,
  fallback: AgentContextMode = 'fresh'
): AgentContextMode {
  return value === 'continue' || value === 'fresh' ? value : fallback;
}
