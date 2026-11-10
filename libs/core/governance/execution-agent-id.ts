/**
 * S4 slice 4 of the scope/identity/grant consolidation (ADR concept-model-v2
 * D3/D5): the agent id the governance gates record and decide on — the
 * policy-engine `agentId` (rate-limit buckets), the kill-switch action log and
 * the audit-chain `agentId` — is the running process's NHI id, never the raw
 * Execution Persona text it used to be.
 *
 * 1. `KYBERION_NHI_ID` when it is an nhi_id (the runtime supervisor / dispatch
 *    env stamps it for spawned workers);
 * 2. else `kyberion://agent/<tenant>/<org|_>/<slug>` built from the process
 *    tenant (`KYBERION_TENANT`) and organization (`KYBERION_ORGANIZATION_ID`),
 *    or the tenantless `kyberion://agent/_/_/<slug>`. The slug is the base
 *    role the execution runs on (`ecosystem_architect` → `ecosystem-architect`),
 *    else the caller's component fallback, else `unknown`.
 *
 * Tenant and organization are process-level settings, so within one process
 * two executions share an id exactly when they shared the persona text before
 * (equivalence: `libs/core/testing/agent-nhi-id-equivalence.test.ts`). Base
 * role text that is not slug-shaped and a claimed `KYBERION_NHI_ID` can only
 * merge ids, never split them, so a rate limit keyed on the id never loosens.
 * The id is a label, not a credential: it grants nothing.
 *
 * Pure leaf: no secure-io / authority import (secure-io and the policy gates
 * call it on every decision).
 */
import {
  NHI_SLUG_PATTERN,
  buildNhiId,
  buildTenantlessNhiId,
  parseNhiId,
} from '../contracts/nhi-id.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { executionPersonaText } from '../foundation/execution-scope.js';
import { isValidTenantSlug } from '../foundation/scope.js';

/** Slug of an execution whose base role and component are both unknown. */
export const UNKNOWN_AGENT_SLUG = 'unknown';

function agentSlug(value: string | undefined): string | undefined {
  const slug = value?.trim().replaceAll('_', '-');
  return slug && NHI_SLUG_PATTERN.test(slug) ? slug : undefined;
}

/**
 * The NHI id of the current execution. `fallback` names the component when
 * the execution runs on no base role (e.g. `organization_controller`).
 */
export function executionAgentId(fallback: string = UNKNOWN_AGENT_SLUG): string {
  const claimed = getRegisteredEnvText('KYBERION_NHI_ID')?.trim();
  if (claimed && parseNhiId(claimed)) return claimed;
  const slug = agentSlug(executionPersonaText()) ?? agentSlug(fallback) ?? UNKNOWN_AGENT_SLUG;
  const tenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  if (!tenant || !isValidTenantSlug(tenant)) return buildTenantlessNhiId(slug);
  const organization = getRegisteredEnvText('KYBERION_ORGANIZATION_ID')?.trim();
  return buildNhiId(
    tenant,
    organization && NHI_SLUG_PATTERN.test(organization) ? organization : null,
    slug
  );
}
