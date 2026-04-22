/**
 * Requirements Draft Store — persist / load the requirements artifact for
 * customer_engagement missions, and evaluate the two associated review
 * gates (REQUIREMENTS_COMPLETENESS, CUSTOMER_SIGNOFF).
 *
 * The canonical location is
 *   active/missions/<mission_id>/evidence/requirements-draft.json
 * conforming to schemas/requirements-draft.schema.json.
 */

import * as path from 'node:path';
import { missionEvidenceDir } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import type {
  ExtractedRequirements,
  FunctionalRequirement,
  NonFunctionalRequirement,
  OpenQuestion,
  RequirementAssumption,
  RequirementConstraint,
} from './reasoning-backend.js';

const DRAFT_FILE = 'requirements-draft.json';

export type SignoffChannel = 'in_meeting' | 'email' | 'docusign' | 'slack' | 'other';

export interface StakeholderSignoff {
  customer_signed_off: boolean;
  signed_at?: string;
  signed_by?: string;
  channel?: SignoffChannel;
  notes?: string;
}

export interface RequirementsDraft {
  version: string;
  project_name: string;
  customer?: { name?: string; person_slug?: string; org?: string };
  elicitation_source?: {
    type: 'call_recording' | 'call_transcript' | 'meeting_notes' | 'document_pack' | 'chat_log' | 'mixed';
    refs?: string[];
    language?: string;
  };
  functional_requirements: FunctionalRequirement[];
  non_functional_requirements: NonFunctionalRequirement[];
  constraints: RequirementConstraint[];
  assumptions: RequirementAssumption[];
  open_questions: OpenQuestion[];
  scope?: { in_scope?: string[]; out_of_scope?: string[] };
  stakeholder_signoff?: StakeholderSignoff;
  generated_at: string;
  generated_by?: string;
}

function draftPath(missionId: string): string | null {
  const dir = missionEvidenceDir(missionId);
  if (!dir) return null;
  return path.join(dir, DRAFT_FILE);
}

export function readRequirementsDraft(missionId: string): RequirementsDraft | null {
  const file = draftPath(missionId);
  if (!file || !safeExistsSync(file)) return null;
  return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as RequirementsDraft;
}

export interface SaveRequirementsDraftParams {
  missionId: string;
  projectName: string;
  extracted: ExtractedRequirements;
  customer?: { name?: string; person_slug?: string; org?: string };
  elicitationSource?: RequirementsDraft['elicitation_source'];
  generatedBy?: string;
  version?: string;
}

/**
 * Persist an extracted requirements result as the mission's draft. If a
 * draft already exists, the version field is incremented (v1 → v2) and
 * any existing stakeholder_signoff is cleared — re-extraction invalidates
 * prior customer acceptance.
 */
export function saveRequirementsDraft(params: SaveRequirementsDraftParams): RequirementsDraft {
  const existing = readRequirementsDraft(params.missionId);
  const version = params.version ?? bumpVersion(existing?.version);
  const draft: RequirementsDraft = {
    version,
    project_name: params.projectName,
    ...(params.customer ? { customer: params.customer } : {}),
    ...(params.elicitationSource ? { elicitation_source: params.elicitationSource } : {}),
    functional_requirements: params.extracted.functional_requirements,
    non_functional_requirements: params.extracted.non_functional_requirements,
    constraints: params.extracted.constraints,
    assumptions: params.extracted.assumptions,
    open_questions: params.extracted.open_questions,
    ...(params.extracted.scope ? { scope: params.extracted.scope } : {}),
    generated_at: new Date().toISOString(),
    ...(params.generatedBy ? { generated_by: params.generatedBy } : {}),
  };
  const file = draftPath(params.missionId);
  if (!file) {
    throw new Error(
      `[requirements-draft-store] mission evidence dir not found for ${params.missionId}`,
    );
  }
  safeWriteFile(file, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mkdir: true });
  return draft;
}

function bumpVersion(previous?: string): string {
  if (!previous) return 'v1';
  const match = previous.match(/^v(\d+)$/u);
  if (!match) return 'v1';
  return `v${parseInt(match[1], 10) + 1}`;
}

export interface RecordSignoffParams {
  missionId: string;
  signedBy: string;
  channel: SignoffChannel;
  notes?: string;
}

/** Mark a draft as signed off. Returns the updated draft. */
export function recordCustomerSignoff(params: RecordSignoffParams): RequirementsDraft {
  const existing = readRequirementsDraft(params.missionId);
  if (!existing) {
    throw new Error(
      `[requirements-draft-store] cannot record signoff — no draft found for ${params.missionId}`,
    );
  }
  existing.stakeholder_signoff = {
    customer_signed_off: true,
    signed_at: new Date().toISOString(),
    signed_by: params.signedBy,
    channel: params.channel,
    ...(params.notes ? { notes: params.notes } : {}),
  };
  const file = draftPath(params.missionId);
  if (!file) {
    throw new Error(
      `[requirements-draft-store] mission evidence dir not found for ${params.missionId}`,
    );
  }
  safeWriteFile(file, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', mkdir: true });
  return existing;
}

// ----- Gate evaluators --------------------------------------------------

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/**
 * REQUIREMENTS_COMPLETENESS — the draft must:
 *   - include ≥1 functional requirement
 *   - every must-have FR has ≥1 acceptance_criterion
 *   - no blocking open questions (status='open')
 */
export function evaluateRequirementsCompletenessGate(missionId: string): GateResult {
  const draft = readRequirementsDraft(missionId);
  const reasons: string[] = [];
  if (!draft) {
    return { passed: false, reasons: ['no requirements-draft.json present in mission evidence'] };
  }
  if (draft.functional_requirements.length === 0) {
    reasons.push('functional_requirements is empty');
  }
  const mustsWithoutCriteria = draft.functional_requirements.filter(
    (r) =>
      r.priority === 'must' &&
      (!r.acceptance_criteria || r.acceptance_criteria.length === 0),
  );
  if (mustsWithoutCriteria.length > 0) {
    reasons.push(
      `must-have FRs without acceptance_criteria: ${mustsWithoutCriteria.map((r) => r.id).join(', ')}`,
    );
  }
  const openBlocking = draft.open_questions.filter((q) => (q.status ?? 'open') === 'open');
  if (openBlocking.length > 0) {
    reasons.push(`${openBlocking.length} open question(s) unresolved`);
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * CUSTOMER_SIGNOFF — stakeholder_signoff.customer_signed_off must be true.
 */
export function evaluateCustomerSignoffGate(missionId: string): GateResult {
  const draft = readRequirementsDraft(missionId);
  if (!draft) {
    return { passed: false, reasons: ['no requirements-draft.json present'] };
  }
  if (!draft.stakeholder_signoff?.customer_signed_off) {
    return { passed: false, reasons: ['stakeholder_signoff.customer_signed_off is false or absent'] };
  }
  return { passed: true, reasons: [] };
}
