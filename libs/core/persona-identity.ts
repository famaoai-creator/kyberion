/** Conversational persona links are descriptive metadata, never execution authority. */
import { z } from 'zod';
import { NHI_ID_PATTERN } from './contracts/nhi-id.js';
import { isValidTenantSlug } from './entity-scope.js';
import { getAgentIdentity, type AgentIdentityRecord } from './agent/agent-identity.js';
import {
  loadPersonalAgentIdentityAtPath,
  writePersonalAgentIdentityAtPath,
  personalAgentIdentityRevision,
} from './personal-identity-state.js';

export const personaIdentityBindingsSchema = z
  .object({
    version: z.literal(1),
    persona_id: z.string().min(1),
    accountable_human_id: z.string().min(1),
    personal_nhi_id: z.string().regex(NHI_ID_PATTERN).optional(),
    tenant_bindings: z.array(
      z
        .object({
          tenant_slug: z.string().refine(isValidTenantSlug),
          nhi_id: z.string().regex(NHI_ID_PATTERN),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const tenants = value.tenant_bindings.map((entry) => entry.tenant_slug);
    const identities = [
      value.personal_nhi_id,
      ...value.tenant_bindings.map((entry) => entry.nhi_id),
    ].filter(Boolean);
    if (new Set(tenants).size !== tenants.length || new Set(identities).size !== identities.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Each scope and NHI must have one distinct binding.',
      });
  });

export type PersonaIdentityBindings = z.infer<typeof personaIdentityBindingsSchema>;
export type PersonaIdentityScope =
  | { kind: 'person'; accountableHumanId: string }
  | { kind: 'tenant'; accountableHumanId: string; tenantSlug: string };

type Lookup = (id: string) => AgentIdentityRecord | null | undefined;

/** Exact affiliation, not the organization component of an NHI URI. */
export function agentIdentityMatchesTenant(
  record: AgentIdentityRecord,
  tenantSlug: string
): boolean {
  return isValidTenantSlug(tenantSlug) && record.affiliation.tenant_slug === tenantSlug;
}

function eligible(
  record: AgentIdentityRecord | null | undefined,
  scope: PersonaIdentityScope
): record is AgentIdentityRecord {
  return Boolean(
    record &&
    record.kind === 'agent' &&
    ['provisioned', 'active'].includes(record.lifecycle_status) &&
    record.accountable_human_id === scope.accountableHumanId &&
    (scope.kind === 'person'
      ? !record.affiliation.tenant_slug
      : agentIdentityMatchesTenant(record, scope.tenantSlug))
  );
}

/** Resolve one explicit scope; absent/invalid mappings never fall back to another scope. */
export function resolvePersonaIdentity(
  profile: Record<string, unknown>,
  scope: PersonaIdentityScope,
  lookup: Lookup = getAgentIdentity
): AgentIdentityRecord | null {
  let id: string | undefined;
  if (profile.persona_identity_bindings !== undefined) {
    const parsed = personaIdentityBindingsSchema.safeParse(profile.persona_identity_bindings);
    if (
      !parsed.success ||
      parsed.data.persona_id !== profile.agent_id ||
      parsed.data.accountable_human_id !== scope.accountableHumanId
    )
      return null;
    id =
      scope.kind === 'person'
        ? parsed.data.personal_nhi_id
        : parsed.data.tenant_bindings.find((entry) => entry.tenant_slug === scope.tenantSlug)
            ?.nhi_id;
  } else if (scope.kind === 'person' && typeof profile.nhi_id === 'string') {
    // Historical links are names, not proof: always re-check the current journal.
    id = profile.nhi_id;
  }
  if (!id || !NHI_ID_PATTERN.test(id)) return null;
  const record = lookup(id);
  return record?.nhi_id === id && eligible(record, scope) ? record : null;
}

/** Validate a complete replacement. Does not issue, activate, admit, or grant anything. */
export function validatePersonaIdentityBindings(
  profile: Record<string, unknown>,
  input: unknown,
  lookup: Lookup = getAgentIdentity
): PersonaIdentityBindings {
  const bindings = personaIdentityBindingsSchema.parse(input);
  if (bindings.persona_id !== profile.agent_id) throw new Error('Persona handle mismatch.');
  const candidate = { ...profile, persona_identity_bindings: bindings };
  const scopes: PersonaIdentityScope[] = [
    ...(bindings.personal_nhi_id
      ? [{ kind: 'person' as const, accountableHumanId: bindings.accountable_human_id }]
      : []),
    ...bindings.tenant_bindings.map((entry) => ({
      kind: 'tenant' as const,
      tenantSlug: entry.tenant_slug,
      accountableHumanId: bindings.accountable_human_id,
    })),
  ];
  if (scopes.some((scope) => !resolvePersonaIdentity(candidate, scope, lookup)))
    throw new Error(
      'Every persona binding requires a current, matching, non-suspended registered agent.'
    );
  return bindings;
}

/** Governed profile write; full replacement, not a concurrent merge or an authority ceremony. */
export function writePersonaIdentityBindingsAtPath(
  filePath: string,
  input: unknown,
  expectedRevision: string
): PersonaIdentityBindings {
  const profile = loadPersonalAgentIdentityAtPath(filePath);
  if (!profile) throw new Error('Existing persona profile required.');
  if (personalAgentIdentityRevision(profile) !== expectedRevision)
    throw new Error('Agent profile changed; review a fresh preview before applying.');
  const bindings = validatePersonaIdentityBindings(profile, input);
  writePersonalAgentIdentityAtPath(
    filePath,
    { ...profile, persona_identity_bindings: bindings },
    expectedRevision
  );
  return bindings;
}
