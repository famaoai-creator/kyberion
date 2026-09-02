import { z } from 'zod';

const sovereignIdentitySchema = z
  .object({ name: z.string().trim().max(200).optional() })
  .passthrough();

const agentIdentitySchema = z
  .object({
    agent_id: z.string().trim().max(200).optional(),
    trust_tier: z.string().trim().max(100).optional(),
  })
  .passthrough();

/** Project the operator identity to fields safe for surface display. */
export function parsePersonalSovereignIdentity(value: unknown): { name?: string } | null {
  const parsed = sovereignIdentitySchema.safeParse(value);
  return parsed.success ? { name: parsed.data.name } : null;
}

/** Project the agent identity to fields safe for surface display. */
export function parsePersonalAgentIdentity(
  value: unknown
): { agent_id?: string; trust_tier?: string } | null {
  const parsed = agentIdentitySchema.safeParse(value);
  return parsed.success
    ? { agent_id: parsed.data.agent_id, trust_tier: parsed.data.trust_tier }
    : null;
}
