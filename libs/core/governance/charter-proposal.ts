/**
 * Charter proposals — an approver drafts the limits, the owner decides.
 *
 * Accountability cannot be delegated by a form: only an owner can accept a
 * charter (`acceptCharterFromForm`). A proposal therefore carries NO authority;
 * it is a validated draft of a `CharterForm` that the owner can load into the
 * ordinary preview → agree flow. At most one proposal is pending per tenant
 * (a newer one replaces it); it is cleared when the owner accepts a charter or
 * dismisses it. Every submit / dismiss is appended to a per-tenant ledger.
 *
 * Records live under `knowledge/confidential/<tenant>/charter-proposals/`.
 */

import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { appendJsonLine } from '../foundation/json.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { parseCharterForm, type CharterForm } from './charter-service.js';

export interface CharterProposalPathOptions {
  rootDir?: string;
}

export interface CharterProposal {
  tenant_slug: string;
  form: CharterForm;
  /** `user:<member_id>` of the approver who drafted it (server-resolved). */
  proposed_by: string;
  proposed_by_name: string;
  proposed_at: string;
  note: string;
}

const MAX_NOTE = 400;

function dir(tenantSlug: string, options: CharterProposalPathOptions): string {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('[charter-proposal] invalid tenant');
  const root = options.rootDir ?? pathResolver.rootDir();
  return path.join(root, 'knowledge', 'confidential', tenantSlug, 'charter-proposals');
}

function safe(file: string, options: CharterProposalPathOptions): string {
  return assertSafeRepositoryPath(file, { allowMissingLeaf: true, rootDir: options.rootDir });
}

const proposalFile = (t: string, o: CharterProposalPathOptions) =>
  safe(path.join(dir(t, o), 'pending.json'), o);
const ledgerFile = (t: string, o: CharterProposalPathOptions) =>
  safe(path.join(dir(t, o), 'proposals.ledger.jsonl'), o);

function record(
  tenant: string,
  entry: Record<string, unknown>,
  options: CharterProposalPathOptions,
  now: Date
): void {
  const file = ledgerFile(tenant, options);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, { ts: now.toISOString(), ...entry });
}

export function readPendingProposal(
  tenantSlug: string,
  options: CharterProposalPathOptions = {}
): CharterProposal | null {
  const file = proposalFile(tenantSlug, options);
  if (!safeExistsSync(file)) return null;
  const raw = parseSafeJsonInput(readTextFile(file), 'charter proposal') as CharterProposal;
  const parsed = parseCharterForm(raw?.form);
  if (!parsed.ok || raw.tenant_slug !== tenantSlug) return null;
  return { ...raw, form: parsed.form };
}

export type SubmitProposalResult =
  { ok: true; proposal: CharterProposal } | { ok: false; error: string };

/** The caller has already established that `proposer` is an approver (not owner) of the tenant. */
export function submitCharterProposal(
  input: {
    form: unknown;
    proposedBy: string;
    proposedByName: string;
    note?: unknown;
    now?: Date;
  },
  options: CharterProposalPathOptions = {}
): SubmitProposalResult {
  const parsed = parseCharterForm(input.form);
  if (parsed.ok === false) return { ok: false, error: parsed.error };
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, MAX_NOTE) : '';
  const now = input.now ?? new Date();
  const proposal: CharterProposal = {
    tenant_slug: parsed.form.tenant_slug,
    form: parsed.form,
    proposed_by: input.proposedBy,
    proposed_by_name: input.proposedByName,
    proposed_at: now.toISOString(),
    note,
  };
  const file = proposalFile(proposal.tenant_slug, options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(proposal, null, 2) + '\n', { encoding: 'utf8' });
  record(proposal.tenant_slug, { event: 'submitted', by: input.proposedBy }, options, now);
  return { ok: true, proposal };
}

/** Owner dismisses, or an accepted charter supersedes it. Returns whether one existed. */
export function clearCharterProposal(
  tenantSlug: string,
  reason: 'dismissed' | 'accepted',
  by: string,
  options: CharterProposalPathOptions = {},
  now: Date = new Date()
): boolean {
  const file = proposalFile(tenantSlug, options);
  if (!safeExistsSync(file)) return false;
  safeRmSync(file, { force: true });
  record(tenantSlug, { event: reason, by }, options, now);
  return true;
}
