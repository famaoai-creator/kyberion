import { evaluateMissionStartMandate, loadMandateCatalog } from '../governance/mandate-shadow.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal, DotWorkShape } from './dot-proposals.js';

/** The model sees only current, tenant-bound mandate scopes owned by this Dot. */
export function dotMissionAdmissionPrompt(
  charter: DotCharter,
  shapes: readonly DotWorkShape[],
  now: Date
): string[] {
  const refs = charter.authority.mission_mandate_refs ?? [];
  if (!shapes.includes('mission') || !refs.length) return [];
  try {
    const mandates = loadMandateCatalog().mandates.filter(
      (mandate) =>
        refs.includes(mandate.id) &&
        mandate.authority?.status === 'active' &&
        mandate.authority.tenant_slug === charter.scope.tenant_slug &&
        Date.parse(mandate.expires_at) > now.getTime()
    );
    return [
      `Allowed mission_admission mandates: ${JSON.stringify(mandates)}.`,
      'For mission work you may propose mission_admission {mandate_ref, mandate_facts:{work_type,paths,estimated_cost,currency,external_effects,risk_level}} within these bounds. Facts request internal mission admission only; they never grant tool effects or external operations.',
    ];
  } catch {
    return ['Mission admission catalog unavailable; do not attach mission_admission.'];
  }
}

/** Recheck admission independently of prompt disclosure, including approval settlement. */
export function dotMissionAdmissionRefusal(
  charter: DotCharter,
  proposal: Pick<DotProposal, 'mission_admission' | 'work_shape' | 'handoff_to'>,
  now?: Date
): string | undefined {
  const admission = proposal.mission_admission;
  if (!admission) return;
  if (
    proposal.work_shape !== 'mission' ||
    proposal.handoff_to ||
    !charter.authority.mission_mandate_refs?.includes(admission.mandate_ref)
  ) {
    return 'mission admission requires an explicitly authorized mandate on the owning DotCharter';
  }
  try {
    const verdict = evaluateMissionStartMandate(
      {
        tenant_slug: charter.scope.tenant_slug ?? '',
        mandate_id: admission.mandate_ref,
        facts: admission.mandate_facts,
      },
      { now }
    );
    if (!verdict.covered) return `mission admission refused: ${verdict.reasons.join('; ')}`;
  } catch (error) {
    return `mission admission authority unavailable: ${String(error)}`;
  }
}
