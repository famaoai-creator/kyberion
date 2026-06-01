import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readSchema(fileName: string): any {
  const schemaPath = pathResolver.knowledge(`public/schemas/${fileName}`);
  return JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string);
}

describe('organization discovery report schemas', () => {
  it('defines the organization catalog report contract', () => {
    const schema = readSchema('organization-catalog-report.schema.json');

    expect(schema.title).toBe('Organization Catalog Report');
    expect(schema.required).toContain('requested');
    expect(schema.required).toContain('catalogs');
    expect(schema.properties.selected_only.type).toBe('boolean');
    expect(schema.properties.summary.required).toContain('total_count');
    expect(schema.properties.summary.required).toContain('selected_count');
  });

  it('defines the organization profile report contract', () => {
    const schema = readSchema('organization-profile-report.schema.json');

    expect(schema.title).toBe('Organization Profile Report');
    expect(schema.required).toContain('selected_catalog');
    expect(schema.required).toContain('profile');
  });

  it('defines the organization profiles inventory contract', () => {
    const schema = readSchema('organization-profiles-report.schema.json');

    expect(schema.title).toBe('Organization Profiles Report');
    expect(schema.required).toContain('selected_organization_id');
    expect(schema.required).toContain('profiles');
    expect(schema.properties.ready_only.type).toBe('boolean');
    expect(schema.properties.missing_only.type).toBe('boolean');
    expect(schema.properties.summary.required).toContain('total_count');
    expect(schema.properties.summary.required).toContain('missing_count');
  });

  it('locks the organization discovery examples array to four canonical entries', () => {
    const schema = readSchema('organization-discovery-report.schema.json');

    expect(schema.title).toBe('Organization Discovery Report');
    expect(schema.required).toContain('examples');
    expect(schema.properties.examples.type).toBe('array');
    expect(schema.properties.examples.minItems).toBe(4);
    expect(schema.properties.examples.maxItems).toBe(4);
    expect(schema.properties.examples.items.required).toEqual([
      'name',
      'path',
      'schema',
      'purpose',
    ]);
  });

  it('accepts the canonical organization discovery examples', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);

    const organizationProfileSchema = readSchema('organization-profile.schema.json');
    ajv.addSchema(organizationProfileSchema, 'https://kyberion.local/schemas/organization-profile.schema.json');

    const organizationProfileReportSchema = readSchema('organization-profile-report.schema.json');
    const organizationProfileExample = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('public/schemas/organization-profile-report.example.json'),
        { encoding: 'utf8' },
      ) as string,
    );
    expect(ajv.validate(organizationProfileReportSchema, organizationProfileExample), JSON.stringify(ajv.errors || [])).toBe(true);

    const organizationProfilesReportSchema = readSchema('organization-profiles-report.schema.json');
    const organizationProfilesExample = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('public/schemas/organization-profiles-report.example.json'),
        { encoding: 'utf8' },
      ) as string,
    );
    expect(ajv.validate(organizationProfilesReportSchema, organizationProfilesExample), JSON.stringify(ajv.errors || [])).toBe(true);

    const organizationCatalogReportSchema = readSchema('organization-catalog-report.schema.json');
    const organizationCatalogExample = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('public/schemas/organization-catalog-report.example.json'),
        { encoding: 'utf8' },
      ) as string,
    );
    expect(ajv.validate(organizationCatalogReportSchema, organizationCatalogExample), JSON.stringify(ajv.errors || [])).toBe(true);

    const organizationDiscoveryReportSchema = readSchema('organization-discovery-report.schema.json');
    const organizationDiscoveryExample = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('public/schemas/organization-discovery-report.example.json'),
        { encoding: 'utf8' },
      ) as string,
    );
    expect(organizationDiscoveryExample.examples).toHaveLength(4);
    expect(ajv.validate(organizationDiscoveryReportSchema, organizationDiscoveryExample), JSON.stringify(ajv.errors || [])).toBe(true);
  });
});
