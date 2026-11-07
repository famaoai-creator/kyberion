import { z } from 'zod';
export {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
} from './personal-identity-state.js';

const sovereignIdentitySchema = z
  .object({ name: z.string().trim().max(200).optional() })
  .passthrough();

const agentIdentitySchema = z
  .object({
    agent_id: z.string().trim().max(200).optional(),
    trust_tier: z.string().trim().max(100).optional(),
  })
  .passthrough();

const sovereignIdentitySummarySchema = sovereignIdentitySchema.extend({
  language: z.string().trim().max(100).optional(),
  interaction_style: z.string().trim().max(100).optional(),
  primary_domain: z.string().trim().max(200).optional(),
  status: z.string().trim().max(100).optional(),
});

const agentIdentitySummarySchema = agentIdentitySchema.extend({
  role: z.string().trim().max(100).optional(),
  owner: z.string().trim().max(200).optional(),
});

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

/** Project the extended identity fields consumed by the Chronos summary UI. */
export function parsePersonalSovereignIdentitySummary(value: unknown): {
  name?: string;
  language?: string;
  interaction_style?: string;
  primary_domain?: string;
  status?: string;
} | null {
  const parsed = sovereignIdentitySummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const { name, language, interaction_style, primary_domain, status } = parsed.data;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(interaction_style !== undefined ? { interaction_style } : {}),
    ...(primary_domain !== undefined ? { primary_domain } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** Project the extended agent fields consumed by the Chronos summary UI. */
export function parsePersonalAgentIdentitySummary(value: unknown): {
  agent_id?: string;
  role?: string;
  owner?: string;
  trust_tier?: string;
} | null {
  const parsed = agentIdentitySummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const { agent_id, role, owner, trust_tier } = parsed.data;
  return {
    ...(agent_id !== undefined ? { agent_id } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(trust_tier !== undefined ? { trust_tier } : {}),
  };
}
