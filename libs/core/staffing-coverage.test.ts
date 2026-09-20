import { describe, expect, it } from 'vitest';
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
