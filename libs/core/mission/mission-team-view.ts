import type { MissionTeamPlan } from './mission-team-plan-composer.js';

/**
 * TC-05: render a team plan as the four things an operator actually asks
 * about — who is on the roster, who is working, who is waiting, and what is
 * missing.
 *
 * `mission_controller team` printed the raw plan JSON. Everything needed was
 * in there, but the distinction TC-01 introduced — a standby role is staffed
 * on demand, an unfilled role is a real gap in the pool — is exactly the kind
 * of thing that disappears into a hundred lines of JSON. So does the TC-04
 * justification for each role. Reading those out is the whole job here.
 */
const STATE_LABEL: Record<string, string> = {
  assigned: 'staffed',
  standby: 'standby',
  unfilled: 'UNFILLED',
};

function describeSources(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) return '-';
  return sources.join('+');
}

export function formatMissionTeamPlanView(plan: MissionTeamPlan): string {
  const lines: string[] = [];
  const classification = plan.mission_classification;
  const governance = plan.team_governance;

  lines.push(
    `mission ${plan.mission_id}  template=${plan.template}  tier=${plan.tier}` +
      (plan.tenant_slug ? `  tenant=${plan.tenant_slug}` : '')
  );
  if (classification) {
    lines.push(
      `  class=${classification.mission_class}  delivery=${classification.delivery_shape}  ` +
        `risk=${classification.risk_profile}  stage=${classification.stage}`
    );
  }
  if (plan.organization_profile) {
    lines.push(
      `  organization=${plan.organization_profile.name} (${plan.organization_profile.organization_id})`
    );
  }

  const staffed = plan.assignments.filter((entry) => entry.status === 'assigned');
  const standby = plan.assignments.filter((entry) => entry.status === 'standby');
  const unfilled = plan.assignments.filter((entry) => entry.status === 'unfilled');
  const lifecycle = governance?.lifecycle;
  lines.push('');
  lines.push(
    `roster=${plan.assignments.length}` +
      (lifecycle ? `/${lifecycle.max_members}` : '') +
      `  staffed=${staffed.length}  standby=${standby.length}  unfilled=${unfilled.length}`
  );

  if (governance?.obligations && governance.obligations.length > 0) {
    lines.push('');
    lines.push('obligations that shaped this roster');
    for (const obligation of governance.obligations) {
      lines.push(`  ${obligation.id} -> ${obligation.require_roles.join(', ')}`);
      lines.push(`    ${obligation.reason}`);
    }
  }

  lines.push('');
  lines.push(
    '  role                 state      source              actor                provider/model'
  );
  for (const assignment of plan.assignments) {
    const actor = assignment.agent_id || '-';
    const route = [assignment.provider, assignment.modelId].filter(Boolean).join(' / ') || '-';
    lines.push(
      `  ${assignment.team_role.padEnd(20)} ${(STATE_LABEL[assignment.status] || assignment.status).padEnd(10)} ` +
        `${describeSources(assignment.role_sources).padEnd(19)} ${actor.padEnd(20)} ${route}`
    );
  }

  const unfilledRequired = governance?.composition.unfilled_required_roles || [];
  lines.push('');
  if (unfilledRequired.length > 0) {
    // The only state here that needs a human: no compatible actor exists.
    lines.push(`gaps: no compatible actor for required role(s) ${unfilledRequired.join(', ')}`);
  } else if (standby.length > 0) {
    lines.push(
      `gaps: none. ${standby.length} role(s) wait on standby and are staffed when work demands them.`
    );
  } else {
    lines.push('gaps: none.');
  }
  return lines.join('\n');
}
