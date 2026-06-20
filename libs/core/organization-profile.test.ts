import { afterEach, describe, expect, it } from 'vitest';
import { loadOrganizationProfile } from './organization-profile.js';
import {
  listOrganizationMissionTeamTemplateCatalogSummaries,
  listOrganizationMissionTeamTemplateCatalogSummariesForOrganization,
} from './mission-team-index.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('organization-profile', () => {
  const originalCustomer = process.env.KYBERION_CUSTOMER;
  const overlayRoot = pathResolver.sharedTmp('organization-profile-test-org');
  const overlayPath = `${overlayRoot}/customer/test-org/organization-profile.json`;
  const demoRoot = pathResolver.sharedTmp('organization-profile-demo-org');
  const demoOverlayPath = `${demoRoot}/customer/demo-org/organization-profile.json`;

  afterEach(() => {
    if (originalCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = originalCustomer;

    if (safeExistsSync(overlayRoot)) {
      safeRmSync(overlayRoot, { recursive: true, force: true });
    }
    if (safeExistsSync(demoRoot)) {
      safeRmSync(demoRoot, { recursive: true, force: true });
    }
  });

  it('loads the organization overlay from the provided root before the public default', () => {
    process.env.KYBERION_CUSTOMER = 'test-org';
    safeMkdir(overlayRoot, { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify(
        {
          $schema: 'https://kyberion.local/schemas/organization-profile.schema.json',
          version: '1.0.0',
          organization_id: 'test-org',
          name: 'Test Org',
          mission_defaults: {
            default_mission_class: 'decision_support',
            default_team_template: 'default',
            default_agent_profile: 'planner-agent',
          },
          team_defaults: {
            default_team_template: 'default',
            default_lifecycle_template: 'default',
            max_parallel_missions: 2,
          },
          llm: {
            default_profile: 'light',
            profile_overrides: {
              heavy: {
                command: 'org-codex',
                args: ['--org'],
                adapter: 'codex-cli',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const profile = loadOrganizationProfile(overlayRoot);

    expect(profile?.organization_id).toBe('test-org');
    expect(profile?.mission_defaults?.default_agent_profile).toBe('planner-agent');
    expect(profile?.llm?.default_profile).toBe('light');
  });

  it('falls back to the public organization profile when no customer overlay exists', () => {
    delete process.env.KYBERION_CUSTOMER;

    const profile = loadOrganizationProfile();

    expect(profile?.organization_id).toBe('default');
    expect(profile?.mission_defaults?.default_team_template).toBe('default');
  });

  it('loads the repository customer overlay when the active customer is set', () => {
    process.env.KYBERION_CUSTOMER = 'demo-org';

    const profile = loadOrganizationProfile();

    expect(profile?.organization_id).toBe('demo-org');
    expect(profile?.team_defaults?.team_template_catalog_id).toBe('demo-org');
    expect(profile?.mission_defaults?.default_team_template).toBe('development');
  });

  it('loads the customer overlay from a different root when provided', () => {
    process.env.KYBERION_CUSTOMER = 'demo-org';
    safeMkdir(`${demoRoot}/customer/demo-org`, { recursive: true });
    safeWriteFile(
      demoOverlayPath,
      JSON.stringify(
        {
          $schema: 'https://kyberion.local/schemas/organization-profile.schema.json',
          version: '1.0.0',
          organization_id: 'demo-org-root',
          name: 'Demo Org Root',
          mission_defaults: {
            default_mission_class: 'analysis',
            default_team_template: 'default',
            default_agent_profile: 'review-agent',
          },
          team_defaults: {
            default_team_template: 'default',
            default_lifecycle_template: 'default',
            max_parallel_missions: 1,
          },
          llm: {
            default_profile: 'light',
          },
        },
        null,
        2,
      ),
    );

    const profile = loadOrganizationProfile(demoRoot);

    expect(profile?.organization_id).toBe('demo-org-root');
    expect(profile?.mission_defaults?.default_agent_profile).toBe('review-agent');
  });

  it('lists the public organization team template catalogs', () => {
    const catalogs = listOrganizationMissionTeamTemplateCatalogSummaries();

    expect(catalogs.map((catalog) => catalog.catalog_id)).toEqual([
      'default',
      'demo-org',
      'ops-org',
    ]);
    expect(catalogs.find((catalog) => catalog.catalog_id === 'demo-org')?.template_ids).toContain('development');
    expect(catalogs.find((catalog) => catalog.catalog_id === 'ops-org')?.template_ids).toEqual([
      'incident',
      'operations',
    ]);
  });

  it('marks the selected catalog for an organization profile', () => {
    const catalogs = listOrganizationMissionTeamTemplateCatalogSummariesForOrganization({
      version: '1.0.0',
      organization_id: 'demo-org',
      name: 'Demo Org',
      mission_defaults: {
        default_team_template: 'default',
        default_agent_profile: 'planner-agent',
      },
      team_defaults: {
        default_team_template: 'default',
        team_template_catalog_id: 'demo-org',
      },
      llm: {},
    });

    expect(catalogs.find((catalog) => catalog.catalog_id === 'demo-org')?.selected).toBe(true);
    expect(catalogs.find((catalog) => catalog.catalog_id === 'ops-org')?.selected).toBe(false);
  });
});
