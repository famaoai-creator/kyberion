import * as path from 'node:path';
import { nowIso } from './foundation/time.js';
import { readJson } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';
import {
  MISSION_CLASS_VALUES,
  mapMissionClassToMissionTypeTemplate,
} from './mission-classification.js';
import {
  loadAgentProfileIndex,
  loadMissionTeamTemplates,
  loadTeamRoleIndex,
} from './mission-team-index.js';
import { SEPARATION_ROLE_PAIRS } from './mission-team-plan-composer.js';
import { loadTeamCompositionObligations } from './team-composition-obligations.js';

/**
 * TC-11: does the pool actually contain what the roster asks for?
 *
 * Team roles declare `required_capabilities` and agent profiles declare
 * `capabilities`, but nothing ever compared the two. Selection scores a
 * capability shortfall instead of rejecting it, so a role whose requirements
 * no agent satisfies is still filled — by the least-bad candidate, silently.
 * The same silence covers a capability that every agent lacks and a
 * separation-of-duties pair the pool can never make independent.
 *
 * This report turns all three into data, and the checker built on it fails
 * only where the system will actually demand the role: a role an obligation
 * can require, or a role a mission-team template declares required.
 */
export interface TeamRoleCoverage {
  team_role: string;
  required_capabilities: string[];
  candidate_agent_ids: string[];
  /** Candidates holding every capability the role requires. */
  fully_capable_agent_ids: string[];
  /** Required capabilities no candidate for this role holds. */
  unmet_capabilities: string[];
  obligation_required: boolean;
  template_required: boolean;
}

export type StaffingCoverageViolationKind =
  'obligation_role_uncovered' | 'template_role_unstaffable' | 'separation_impossible';

export interface StaffingCoverageViolation {
  kind: StaffingCoverageViolationKind;
  team_role: string;
  detail: string;
}

export interface StaffingCoverageReport {
  generated_at: string;
  roles: TeamRoleCoverage[];
  /** Capabilities some role requires that no agent profile declares at all. */
  unreachable_capabilities: string[];
  /** Roles with candidates but none that satisfy every requirement. */
  partially_covered_roles: string[];
  violations: StaffingCoverageViolation[];
}

function normalize(values: string[] | undefined): string[] {
  return (values || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function buildStaffingCoverageReport(): StaffingCoverageReport {
  const teamRoles = loadTeamRoleIndex();
  const agents = loadAgentProfileIndex();
  const templates = loadMissionTeamTemplates();
  const obligations = loadTeamCompositionObligations();

  const obligationRoles = new Set(
    obligations.obligations
      .flatMap((rule) => rule.require_roles)
      .concat(obligations.always_staffed_roles)
  );
  const templateRequiredRoles = new Set(
    Object.values(templates).flatMap((template) => template.required_roles || [])
  );

  const candidatesByRole = new Map<string, string[]>();
  for (const role of Object.keys(teamRoles)) {
    candidatesByRole.set(
      role,
      Object.entries(agents)
        .filter(([, profile]) => profile.team_roles.includes(role))
        .map(([agentId]) => agentId)
        .sort()
    );
  }

  const declaredCapabilities = new Set(
    Object.values(agents).flatMap((profile) => normalize(profile.capabilities))
  );

  const roles: TeamRoleCoverage[] = [];
  const unreachableCapabilities = new Set<string>();

  for (const [role, record] of Object.entries(teamRoles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const required = normalize(record.required_capabilities);
    const candidates = candidatesByRole.get(role) || [];
    const fullyCapable = candidates.filter((agentId) => {
      const held = new Set(normalize(agents[agentId]?.capabilities));
      return required.every((capability) => held.has(capability));
    });
    const unmet = required.filter(
      (capability) =>
        !candidates.some((agentId) => normalize(agents[agentId]?.capabilities).includes(capability))
    );
    for (const capability of required) {
      if (!declaredCapabilities.has(capability)) unreachableCapabilities.add(capability);
    }
    roles.push({
      team_role: role,
      required_capabilities: required,
      candidate_agent_ids: candidates,
      fully_capable_agent_ids: fullyCapable,
      unmet_capabilities: unmet,
      obligation_required: obligationRoles.has(role),
      template_required: templateRequiredRoles.has(role),
    });
  }

  const violations: StaffingCoverageViolation[] = [];
  for (const role of roles) {
    if (role.candidate_agent_ids.length === 0 && role.template_required) {
      violations.push({
        kind: 'template_role_unstaffable',
        team_role: role.team_role,
        detail:
          'A mission-team template declares this role required, but no agent profile lists it.',
      });
    }
    if (role.fully_capable_agent_ids.length === 0 && role.obligation_required) {
      violations.push({
        kind: 'obligation_role_uncovered',
        team_role: role.team_role,
        detail: `An obligation can require this role, but no candidate holds every required capability (missing: ${
          role.unmet_capabilities.join(', ') || 'n/a'
        }).`,
      });
    }
  }

  for (const pair of SEPARATION_ROLE_PAIRS) {
    if (pair.strength !== 'hard') continue;
    const roleCandidates = candidatesByRole.get(pair.role) || [];
    const counterpartCandidates = new Set(candidatesByRole.get(pair.mustDifferFrom) || []);
    if (roleCandidates.length === 0) continue;
    const independent = roleCandidates.filter((agentId) => !counterpartCandidates.has(agentId));
    if (independent.length === 0) {
      violations.push({
        kind: 'separation_impossible',
        team_role: pair.role,
        detail: `Every ${pair.role} candidate is also a ${pair.mustDifferFrom} candidate, so the pool can never guarantee independence.`,
      });
    }
  }

  return {
    generated_at: nowIso(),
    roles,
    unreachable_capabilities: [...unreachableCapabilities].sort(),
    partially_covered_roles: roles
      .filter(
        (role) => role.candidate_agent_ids.length > 0 && role.fully_capable_agent_ids.length === 0
      )
      .map((role) => role.team_role),
    violations,
  };
}

export function formatStaffingCoverageReport(report: StaffingCoverageReport): string {
  const lines: string[] = [];
  lines.push('team role              candidates  fully-capable  unmet capabilities');
  for (const role of report.roles) {
    const flags = [
      role.obligation_required ? 'obligation' : '',
      role.template_required ? 'template' : '',
    ]
      .filter(Boolean)
      .join('/');
    lines.push(
      `${role.team_role.padEnd(22)} ${String(role.candidate_agent_ids.length).padStart(10)} ` +
        `${String(role.fully_capable_agent_ids.length).padStart(14)}  ` +
        `${role.unmet_capabilities.join(', ') || '-'}${flags ? `  [${flags}]` : ''}`
    );
  }
  if (report.unreachable_capabilities.length > 0) {
    lines.push('');
    lines.push(`capabilities no agent declares: ${report.unreachable_capabilities.join(', ')}`);
  }
  if (report.partially_covered_roles.length > 0) {
    lines.push(
      `roles with no fully capable candidate: ${report.partially_covered_roles.join(', ')}`
    );
  }
  lines.push('');
  if (report.violations.length === 0) {
    lines.push('violations: none');
  } else {
    lines.push(`violations: ${report.violations.length}`);
    for (const violation of report.violations) {
      lines.push(`  [${violation.kind}] ${violation.team_role}: ${violation.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * TC-14: does every declared route to a mission-team template actually land
 * on one?
 *
 * `composeMissionTeamPlan` resolves an unknown template by falling back to the
 * organization default and then to `default`. That keeps composition running,
 * but it also means a typo in the intent ontology or in an organization
 * catalog silently fields the default team for a mission that asked for a
 * specialist one. A dangling reference is therefore a failure; a template no
 * route reaches is only reported, since a mission may still select it by an
 * explicit `--mission-type`.
 */
export interface TemplateReachabilityReport {
  generated_at: string;
  templates: Array<{ template_id: string; referenced_by: string[] }>;
  /** References that name a template the catalog does not define. */
  dangling_references: Array<{ template_id: string; referenced_by: string[] }>;
  /** Templates no automatic route reaches (explicit mission_type only). */
  unreferenced_templates: string[];
}

function collectTemplateReferences(): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const add = (templateId: string, source: string) => {
    const id = templateId.trim();
    if (!id) return;
    const sources = references.get(id) || new Set<string>();
    sources.add(source);
    references.set(id, sources);
  };

  for (const missionClass of MISSION_CLASS_VALUES) {
    add(mapMissionClassToMissionTypeTemplate(missionClass), `mission_class:${missionClass}`);
  }

  const ontologyPath = pathResolver.knowledge('product/governance/intent-domain-ontology.json');
  if (safeExistsSync(ontologyPath)) {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'team_template' && typeof value === 'string') add(value, 'intent_ontology');
        else walk(value);
      }
    };
    walk(readJson<unknown>(ontologyPath));
  }

  const catalogDir = pathResolver.knowledge(
    'product/governance/organization-team-template-catalogs'
  );
  if (safeExistsSync(catalogDir)) {
    for (const file of safeReaddir(catalogDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const catalog = readJson<{ templates?: Record<string, unknown> }>(
        path.join(catalogDir, file)
      );
      for (const templateId of Object.keys(catalog.templates || {})) {
        add(templateId, `org_catalog:${file}`);
      }
    }
  }

  return references;
}

export function buildTemplateReachabilityReport(): TemplateReachabilityReport {
  const templates = loadMissionTeamTemplates();
  const references = collectTemplateReferences();

  const dangling = [...references.entries()]
    .filter(([templateId]) => !templates[templateId])
    .map(([templateId, sources]) => ({
      template_id: templateId,
      referenced_by: [...sources].sort(),
    }))
    .sort((left, right) => left.template_id.localeCompare(right.template_id));

  const declared = Object.keys(templates).sort();
  return {
    generated_at: nowIso(),
    templates: declared.map((templateId) => ({
      template_id: templateId,
      referenced_by: [...(references.get(templateId) || [])].sort(),
    })),
    dangling_references: dangling,
    unreferenced_templates: declared.filter((templateId) => !references.has(templateId)),
  };
}

export function formatTemplateReachabilityReport(report: TemplateReachabilityReport): string {
  const lines: string[] = ['', 'mission-team template routes'];
  for (const entry of report.templates) {
    lines.push(
      `  ${entry.template_id.padEnd(22)} ${entry.referenced_by.join(', ') || 'explicit mission_type only'}`
    );
  }
  if (report.unreferenced_templates.length > 0) {
    lines.push(`  note: no automatic route reaches ${report.unreferenced_templates.join(', ')}`);
  }
  if (report.dangling_references.length > 0) {
    lines.push('  dangling references:');
    for (const entry of report.dangling_references) {
      lines.push(`    ${entry.template_id} <- ${entry.referenced_by.join(', ')}`);
    }
  }
  return lines.join('\n');
}
