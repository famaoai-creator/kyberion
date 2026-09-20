import { describe, expect, it } from 'vitest';
import { loadAgentProfileIndex, loadTeamRoleIndex } from './mission-team-index.js';
import {
  buildStaffingCoverageReport,
  buildTemplateReachabilityReport,
  formatStaffingCoverageReport,
} from './staffing-coverage.js';

describe('staffing capability coverage (TC-11)', () => {
  const report = buildStaffingCoverageReport();

  it('covers every role the system can actually demand', () => {
    // Governed invariant: a role an obligation can require, or a template
    // declares required, must be supplyable by the current agent pool. This
    // is the assertion the CI gate enforces; it fails loudly instead of
    // letting selection fill the role with the least-bad candidate.
    expect(
      report.violations.map((violation) => `${violation.kind}:${violation.team_role}`)
    ).toEqual([]);
  });

  it('reports every team role with its candidate depth', () => {
    expect(report.roles.length).toBeGreaterThan(10);
    for (const role of report.roles) {
      expect(role.fully_capable_agent_ids.length).toBeLessThanOrEqual(
        role.candidate_agent_ids.length
      );
      for (const agentId of role.fully_capable_agent_ids) {
        expect(role.candidate_agent_ids).toContain(agentId);
      }
    }
  });

  it('keeps hard separation-of-duties achievable with the current pool', () => {
    const reviewer = report.roles.find((role) => role.team_role === 'reviewer');
    const implementer = report.roles.find((role) => role.team_role === 'implementer');
    const independent = (reviewer?.candidate_agent_ids || []).filter(
      (agentId) => !(implementer?.candidate_agent_ids || []).includes(agentId)
    );
    expect(independent.length).toBeGreaterThan(0);
  });

  it('names capabilities no agent declares instead of hiding them', () => {
    // These are open staffing decisions, not failures: no obligation or
    // template requires the roles that need them.
    for (const capability of report.unreachable_capabilities) {
      const requiringRoles = report.roles.filter((role) =>
        role.required_capabilities.includes(capability)
      );
      expect(requiringRoles.length).toBeGreaterThan(0);
      for (const role of requiringRoles) {
        expect(role.obligation_required).toBe(false);
      }
    }
  });

  it('renders a readable table', () => {
    const text = formatStaffingCoverageReport(report);
    expect(text).toContain('team role');
    expect(text).toContain('violations:');
  });
});

describe('mission-team template reachability (TC-14)', () => {
  const report = buildTemplateReachabilityReport();

  it('has no route pointing at a template that does not exist', () => {
    // An unknown template resolves to the default team rather than failing,
    // so a typo'd route would silently field the wrong line-up.
    expect(report.dangling_references).toEqual([]);
  });

  it('routes every mission class to a defined template', () => {
    const byMissionClass = report.templates.filter((entry) =>
      entry.referenced_by.some((source) => source.startsWith('mission_class:'))
    );
    expect(byMissionClass.length).toBeGreaterThan(0);
  });

  it('reports templates that only an explicit mission_type reaches', () => {
    // Reported, never failed: a mission may still select these directly.
    for (const templateId of report.unreferenced_templates) {
      expect(report.templates.map((entry) => entry.template_id)).toContain(templateId);
    }
  });
});

describe('separation of duties readiness (TC-10)', () => {
  const report = buildStaffingCoverageReport();
  const readiness = report.separation_readiness;

  it('reports readiness for every declared separation pair', () => {
    expect(readiness.length).toBeGreaterThan(0);
    for (const entry of readiness) {
      expect(['hard', 'soft']).toContain(entry.strength);
      const roleCoverage = report.roles.find((role) => role.team_role === entry.role);
      for (const agentId of entry.independent_agent_ids) {
        // Independence is judged among actors that can actually do the role.
        expect(roleCoverage?.fully_capable_agent_ids).toContain(agentId);
      }
    }
  });

  it('can field an independent reviewer for the implementer', () => {
    const reviewer = readiness.find(
      (entry) => entry.role === 'reviewer' && entry.must_differ_from === 'implementer'
    );
    expect(reviewer?.independent_agent_ids.length).toBeGreaterThan(0);
  });

  it('can field a reviewer from a different model family than the implementer', () => {
    // The heterogeneous-review rule in selection prefers a different provider.
    // While every profile preferred the same one, that preference could never
    // be satisfied and the rule was decorative.
    const reviewer = readiness.find(
      (entry) => entry.role === 'reviewer' && entry.must_differ_from === 'implementer'
    );
    expect(reviewer?.provider_independent).toBe(true);
  });

  it('records the provider families behind each role', () => {
    const reviewer = report.roles.find((role) => role.team_role === 'reviewer');
    expect(reviewer?.provider_families.length).toBeGreaterThan(1);
  });
});

describe('every declared role is staffable (TC-10)', () => {
  const report = buildStaffingCoverageReport();

  it('has a fully capable candidate for every team role', () => {
    // A role no template or obligation requires is still a promise the
    // catalog makes, and an unstaffable one is a promise selection quietly
    // fills with the least-bad actor.
    expect(report.partially_covered_roles).toEqual([]);
  });

  it('has an actor behind every capability some role requires', () => {
    expect(report.unreachable_capabilities).toEqual([]);
  });

  it('names no authority role that cannot carry the scope the role needs', () => {
    expect(report.dead_authority_declarations).toEqual([]);
  });

  it('keeps the relationship curator on the least-privilege authority that fits', () => {
    // The role owns confidential relationship nodes under knowledge/.
    // `ecosystem_architect` also satisfies its scope class but carries write
    // access to libs/core, scripts and pipelines, which curating a
    // relationship graph has no business holding.
    const roleRecord = loadTeamRoleIndex().relationship_curator;
    expect(roleRecord?.compatible_authority_roles).toContain('knowledge_steward');
    const profile = loadAgentProfileIndex()['relationship-curator'];
    expect(profile?.authority_roles[0]).toBe('knowledge_steward');
    expect(profile?.team_roles).toEqual(['relationship_curator']);
  });

  it('lets the egress policy decide which provider may hold confidential data', () => {
    // The curator declares no provider preference: which providers may receive
    // confidential material is decided by provider-egress-policy.json and
    // enforced at the delegation boundary.
    const profile = loadAgentProfileIndex()['relationship-curator'];
    expect(profile?.selection_hints?.preferred_provider).toBeUndefined();
  });
});
