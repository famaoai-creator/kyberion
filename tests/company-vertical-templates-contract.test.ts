import * as path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReaddir, safeReadFile } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const ROOT = pathResolver.rootDir();
const COMPANIES_DIR = path.join(ROOT, 'templates', 'companies');
const SCHEMAS = 'knowledge/product/schemas';

function readJson(relOrAbs: string): any {
  const target = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  return JSON.parse(safeReadFile(target, { encoding: 'utf8' }) as string);
}

function listVerticals(): string[] {
  return (safeReaddir(COMPANIES_DIR) as string[]).filter((entry) => !entry.includes('.')).sort();
}

const profileValidate = ajv.compile(readJson(`${SCHEMAS}/organization-profile.schema.json`));
const chartValidate = ajv.compile(readJson(`${SCHEMAS}/org-chart.schema.json`));
const catalogValidate = ajv.compile(
  readJson(`${SCHEMAS}/organization-team-template-catalog.schema.json`)
);

const businessRoles = new Set(
  safeReaddir(path.join(ROOT, 'knowledge', 'product', 'roles')) as string[]
);
const teamRoles = new Set(
  (safeReaddir(path.join(ROOT, 'knowledge', 'product', 'orchestration', 'team-roles')) as string[])
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.replace(/\.json$/u, ''))
);
const authorityRoles = new Set(
  (
    safeReaddir(
      path.join(ROOT, 'knowledge', 'product', 'governance', 'authority-roles')
    ) as string[]
  )
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.replace(/\.json$/u, ''))
);

describe('company vertical templates contract', () => {
  const verticals = listVerticals();

  it('ships at least five verticals with the full file set', () => {
    expect(verticals.length).toBeGreaterThanOrEqual(5);
    for (const vertical of verticals) {
      for (const file of [
        'organization-profile.json',
        'org-chart.json',
        'customer.json',
        'identity.json',
        'vision.md',
        'README.md',
      ]) {
        expect(
          safeExistsSync(path.join(COMPANIES_DIR, vertical, file)),
          `${vertical}/${file}`
        ).toBe(true);
      }
    }
  });

  for (const vertical of listVerticals()) {
    it(`validates ${vertical} against the organization schemas`, () => {
      const profile = readJson(path.join(COMPANIES_DIR, vertical, 'organization-profile.json'));
      expect(profileValidate(profile), JSON.stringify(profileValidate.errors ?? [], null, 2)).toBe(
        true
      );
      expect(profile.organization_id).toBe('{COMPANY_SLUG}');

      const chart = readJson(path.join(COMPANIES_DIR, vertical, 'org-chart.json'));
      expect(chartValidate(chart), JSON.stringify(chartValidate.errors ?? [], null, 2)).toBe(true);

      // Org chart integrity: every role must exist in the business role
      // registry, reporting lines must resolve, and the top position must be
      // held by a human (final accountability stays with a person).
      const positionIds = new Set(chart.positions.map((position: any) => position.role_id));
      for (const domain of chart.domains) {
        for (const roleId of domain.role_ids) {
          expect(businessRoles.has(roleId), `${vertical}: unknown role ${roleId}`).toBe(true);
        }
      }
      for (const position of chart.positions) {
        expect(
          businessRoles.has(position.role_id),
          `${vertical}: unknown position role ${position.role_id}`
        ).toBe(true);
        if (position.reports_to !== null) {
          expect(
            positionIds.has(position.reports_to),
            `${vertical}: ${position.role_id} reports_to missing ${position.reports_to}`
          ).toBe(true);
        }
        if (position.authority_role_ref !== null) {
          expect(
            authorityRoles.has(position.authority_role_ref),
            `${vertical}: unknown authority ${position.authority_role_ref}`
          ).toBe(true);
        }
      }
      const roots = chart.positions.filter((position: any) => position.reports_to === null);
      expect(roots.length, `${vertical}: exactly one root position`).toBe(1);
      expect(roots[0].held_by).toBe('human');

      // Team template catalog referenced by the profile must exist, validate,
      // and only use known team roles.
      const catalogId = profile.team_defaults.team_template_catalog_id;
      const catalog = readJson(
        `knowledge/product/governance/organization-team-template-catalogs/${catalogId}.json`
      );
      expect(catalogValidate(catalog), JSON.stringify(catalogValidate.errors ?? [], null, 2)).toBe(
        true
      );
      for (const [templateId, template] of Object.entries<any>(catalog.templates)) {
        for (const role of [
          ...(template.required_roles ?? []),
          ...(template.optional_roles ?? []),
        ]) {
          expect(
            teamRoles.has(role),
            `${vertical}/${catalogId}/${templateId}: unknown team role ${role}`
          ).toBe(true);
        }
      }
    });
  }
});
