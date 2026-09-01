import * as path from 'node:path';
import * as customerResolver from '@agent/core/customer-resolver';
import {
  listOrganizationMissionTeamTemplateCatalogSummariesForOrganization,
  resolveOrganizationMissionTeamTemplateCatalogId,
} from '@agent/core/mission-team-index';
import { loadOrganizationProfile } from '@agent/core/organization-profile';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { getOptionValue } from './mission-cli-args.js';
import { withOrganizationContext } from './organization-context.js';

export function listOrganizationCatalogs(
  organizationId?: string,
  jsonOutput = false,
  argv: readonly string[] = []
) {
  return withOrganizationContext(organizationId, () => {
    const summaryOnly = argv.includes('--summary') || argv.includes('--compact');
    const selectedOnly = argv.includes('--selected-only');
    const organizationProfile = loadOrganizationProfile();
    const catalogs =
      listOrganizationMissionTeamTemplateCatalogSummariesForOrganization(organizationProfile);
    const selectedCatalogId =
      resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile) || 'default';
    const requestedLabel = organizationId?.trim() || 'default';
    const organizationLabel = organizationProfile
      ? `${organizationProfile.name} (${organizationProfile.organization_id})`
      : 'default';
    const filteredCatalogs = selectedOnly
      ? catalogs.filter((catalog) => catalog.selected)
      : catalogs;
    const summary = {
      total_count: filteredCatalogs.length,
      selected_count: filteredCatalogs.filter((catalog) => catalog.selected).length,
      template_count: filteredCatalogs.reduce((acc, catalog) => acc + catalog.template_count, 0),
      required_role_count: filteredCatalogs.reduce(
        (acc, catalog) => acc + catalog.required_role_count,
        0
      ),
      optional_role_count: filteredCatalogs.reduce(
        (acc, catalog) => acc + catalog.optional_role_count,
        0
      ),
    };

    if (jsonOutput) {
      const payload = {
        requested: requestedLabel,
        resolved: organizationLabel,
        selected_catalog: selectedCatalogId,
        selected_only: selectedOnly,
        summary,
        catalogs: filteredCatalogs.map((catalog) => ({
          catalog_id: catalog.catalog_id,
          organization_id: catalog.organization_id,
          selected: catalog.selected,
          template_ids: catalog.template_ids,
          template_count: catalog.template_count,
          required_role_count: catalog.required_role_count,
          optional_role_count: catalog.optional_role_count,
        })),
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (filteredCatalogs.length === 0) {
      logger.info('No organization team template catalogs found.');
      return;
    }

    logger.info(
      `[organization] requested=${requestedLabel} resolved=${organizationLabel} selected=${selectedCatalogId || 'default'}`
    );
    if (selectedOnly) {
      logger.info('[organization] filters=selected-only');
    }
    logger.info(
      `[organization] summary total=${summary.total_count} selected=${summary.selected_count} templates=${summary.template_count} required_roles=${summary.required_role_count} optional_roles=${summary.optional_role_count}`
    );
    if (summaryOnly) {
      return;
    }

    const header = `${'SEL'.padEnd(4)} ${'CATALOG'.padEnd(20)} ${'ORG'.padEnd(14)} ${'TEMPLATES'.padEnd(10)} ${'REQ'.padStart(4)} ${'OPT'.padStart(4)} TEMPLATE IDS`;
    console.log('');
    console.log(header);
    console.log('-'.repeat(header.length + 6));
    for (const catalog of filteredCatalogs) {
      const templateIds = catalog.template_ids.length ? catalog.template_ids.join(', ') : '-';
      const marker = catalog.selected ? '*' : ' ';
      console.log(
        `${marker.padEnd(4)} ${catalog.catalog_id.padEnd(20)} ${catalog.organization_id.padEnd(14)} ${String(catalog.template_count).padEnd(10)} ${String(catalog.required_role_count).padStart(4)} ${String(catalog.optional_role_count).padStart(4)} ${templateIds}`
      );
    }
    console.log('');
    logger.info(`${filteredCatalogs.length} organization team template catalog(s) found.`);
  });
}

export function listOrganizationProfiles(
  organizationId?: string,
  argv: readonly string[] = [],
  rootDir = pathResolver.rootDir()
) {
  const jsonOutput = argv.includes('--json');
  const summaryOnly = argv.includes('--summary') || argv.includes('--compact');
  const activeOnly = argv.includes('--active-only');
  const readyOnly = argv.includes('--ready-only');
  const missingOnly = argv.includes('--missing-only');
  const sourceFilter = getOptionValue('--source', [...argv])?.trim();
  const customerRoot = path.join(rootDir, 'customer');
  const activeCustomer = customerResolver.activeCustomer();
  const requestedLabel = organizationId?.trim() || activeCustomer || 'default';
  const resolvedOrganizationProfile = organizationId
    ? withOrganizationContext(organizationId, () => loadOrganizationProfile())
    : null;
  const selectedOrganizationId =
    resolvedOrganizationProfile?.organization_id || organizationId || activeCustomer || 'default';
  const rows: Array<{
    slug: string;
    active: boolean;
    ready: boolean;
    profile: ReturnType<typeof loadOrganizationProfile> | null;
    source: 'customer' | 'public';
  }> = [];

  const publicProfile = loadOrganizationProfile();
  const publicProfileLabel = publicProfile
    ? `${publicProfile.name} (${publicProfile.organization_id})`
    : 'default';
  rows.push({
    slug: publicProfile?.organization_id || 'default',
    active: selectedOrganizationId === (publicProfile?.organization_id || 'default'),
    ready: Boolean(publicProfile),
    profile: publicProfile,
    source: 'public',
  });

  if (safeExistsSync(customerRoot) && safeLstat(customerRoot).isDirectory()) {
    for (const entry of safeReaddir(customerRoot).sort()) {
      if (entry === 'README.md' || entry === '_template') continue;
      const full = path.join(customerRoot, entry);
      if (!safeLstat(full).isDirectory()) continue;
      const profilePath = path.join(full, 'organization-profile.json');
      const profile = safeExistsSync(profilePath)
        ? withOrganizationContext(entry, () => loadOrganizationProfile())
        : null;
      rows.push({
        slug: entry,
        active: entry === selectedOrganizationId,
        ready: Boolean(profile),
        profile,
        source: 'customer',
      });
    }
  }

  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'public' ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  const filteredRows = rows.filter((row) => {
    if (activeOnly && !row.active) return false;
    if (readyOnly && !row.ready) return false;
    if (missingOnly && row.ready) return false;
    if (sourceFilter && row.source !== sourceFilter) return false;
    return true;
  });

  if (filteredRows.length === 0) {
    logger.info('No organization profiles found.');
    return;
  }

  const summary = {
    total_count: filteredRows.length,
    ready_count: filteredRows.filter((row) => row.ready).length,
    missing_count: filteredRows.filter((row) => !row.ready).length,
    customer_count: filteredRows.filter((row) => row.source === 'customer').length,
    public_count: filteredRows.filter((row) => row.source === 'public').length,
    active_count: filteredRows.filter((row) => row.active).length,
  };

  const jsonRows = filteredRows.map((row) => ({
    slug: row.slug,
    source: row.source,
    active: row.active,
    ready: row.ready,
    organization_id: row.profile?.organization_id || row.slug,
    name: row.profile?.name || row.slug,
    mission_default_template:
      row.profile?.mission_defaults?.default_team_template ||
      row.profile?.team_defaults?.default_team_template ||
      'default',
    team_default_template:
      row.profile?.team_defaults?.default_team_template ||
      row.profile?.mission_defaults?.default_team_template ||
      'default',
    team_template_catalog_id: row.profile?.team_defaults?.team_template_catalog_id || 'default',
    llm_default: row.profile?.llm?.default_profile || 'default',
    operating_principles_count: row.profile?.operating_principles?.length || 0,
  }));

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          requested: requestedLabel,
          resolved: resolvedOrganizationProfile
            ? `${resolvedOrganizationProfile.name} (${resolvedOrganizationProfile.organization_id})`
            : publicProfileLabel,
          selected_organization_id: selectedOrganizationId,
          active_only: activeOnly,
          ready_only: readyOnly,
          missing_only: missingOnly,
          source_filter: sourceFilter || null,
          summary,
          profiles: jsonRows,
        },
        null,
        2
      )
    );
    return;
  }

  logger.info(`[organization] requested=${requestedLabel} selected=${selectedOrganizationId}`);
  if (activeOnly || readyOnly || missingOnly || sourceFilter) {
    logger.info(
      `[organization] filters=${[
        activeOnly ? 'active-only' : null,
        readyOnly ? 'ready-only' : null,
        missingOnly ? 'missing-only' : null,
        sourceFilter ? `source=${sourceFilter}` : null,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
  }
  logger.info(
    `[organization] summary total=${summary.total_count} ready=${summary.ready_count} missing=${summary.missing_count} customer=${summary.customer_count} public=${summary.public_count} active=${summary.active_count}`
  );
  if (summaryOnly) {
    return;
  }
  const header = `${'SEL'.padEnd(4)} ${'SOURCE'.padEnd(10)} ${'ORG'.padEnd(14)} ${'TEAM'.padEnd(14)} ${'CATALOG'.padEnd(12)} ${'LLM'.padEnd(10)} STATUS`;
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 6));
  for (const row of jsonRows) {
    const status = row.ready ? 'ready' : 'missing profile';
    const marker = row.active ? '*' : ' ';
    console.log(
      `${marker.padEnd(4)} ${row.source.padEnd(10)} ${`${row.name} (${row.organization_id})`.padEnd(14)} ${row.team_default_template.padEnd(14)} ${row.team_template_catalog_id.padEnd(12)} ${row.llm_default.padEnd(10)} ${status}`
    );
  }
  console.log('');
  logger.info(`${jsonRows.length} organization profile(s) found.`);
}

export function showOrganizationProfile(
  organizationId?: string,
  summaryOnly = false,
  jsonOutput = false
) {
  return withOrganizationContext(organizationId, () => {
    const requestedLabel = organizationId?.trim() || 'default';
    const organizationProfile = loadOrganizationProfile();
    if (!organizationProfile) {
      const payload = {
        requested: requestedLabel,
        resolved: 'default',
        selected_catalog: 'default',
        template_catalogs: 0,
        selected_catalog_templates: [] as string[],
        profile: null,
      };
      if (jsonOutput) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      logger.info(`[organization] requested=${requestedLabel} resolved=default selected=default`);
      console.log(
        JSON.stringify(
          { organization_id: 'default', selected_catalog: 'default', profile: null },
          null,
          2
        )
      );
      return;
    }

    const selectedCatalogId =
      resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile) || 'default';
    const catalogs =
      listOrganizationMissionTeamTemplateCatalogSummariesForOrganization(organizationProfile);
    const selectedCatalog = catalogs.find((catalog) => catalog.catalog_id === selectedCatalogId);
    const payload = {
      requested: requestedLabel,
      resolved: `${organizationProfile.name} (${organizationProfile.organization_id})`,
      selected_catalog: selectedCatalogId,
      mission_default_template:
        organizationProfile.mission_defaults?.default_team_template || 'default',
      agent_profile: organizationProfile.mission_defaults?.default_agent_profile || 'default',
      team_default_template: organizationProfile.team_defaults?.default_team_template || 'default',
      lifecycle: organizationProfile.team_defaults?.default_lifecycle_template || 'default',
      max_parallel_missions: organizationProfile.team_defaults?.max_parallel_missions ?? null,
      llm_default: organizationProfile.llm?.default_profile || 'default',
      template_catalogs: catalogs.length,
      selected_catalog_templates: selectedCatalog?.template_ids || [],
      operating_principles: organizationProfile.operating_principles || [],
      profile: organizationProfile,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    logger.info(
      `[organization] requested=${requestedLabel} resolved=${organizationProfile.name} (${organizationProfile.organization_id}) selected=${selectedCatalogId}`
    );
    logger.info(
      `[organization] mission_default_template=${payload.mission_default_template} ` +
        `agent_profile=${payload.agent_profile} ` +
        `catalog=${selectedCatalogId} llm_default=${payload.llm_default}`
    );
    logger.info(
      `[organization] team_default_template=${payload.team_default_template} ` +
        `lifecycle=${payload.lifecycle} ` +
        `max_parallel_missions=${payload.max_parallel_missions ?? 'n/a'}`
    );
    logger.info(
      `[organization] template_catalogs=${payload.template_catalogs} ` +
        `selected_catalog=${selectedCatalogId}`
    );
    logger.info(
      `[organization] selected_catalog_templates=${payload.selected_catalog_templates.length ? payload.selected_catalog_templates.join(', ') : '-'}`
    );
    if (payload.operating_principles.length) {
      logger.info(`[organization] operating_principles=${payload.operating_principles.length}`);
    }
    if (summaryOnly) {
      return;
    }
    console.log(
      JSON.stringify(
        {
          organization_id: organizationProfile.organization_id,
          selected_catalog: selectedCatalogId,
          profile: organizationProfile,
        },
        null,
        2
      )
    );
  });
}

export function buildOrganizationDiscoveryReport() {
  const documents = [
    {
      name: 'Organization Selection Guide',
      path: 'knowledge/product/orchestration/organization-selection-guide.md',
      purpose: 'Select or switch the active organization context',
      text_command:
        'node dist/scripts/mission_controller.js organization-profile --organization-id <ORG> --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-profile --organization-id <ORG> --json --summary',
    },
    {
      name: 'Organization Discovery Reports',
      path: 'knowledge/product/orchestration/organization-discovery-reports.md',
      purpose: 'Inspect inventory, readiness, and template overlays',
      text_command: 'node dist/scripts/mission_controller.js organization-profiles --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-profiles --json --summary',
    },
    {
      name: 'Organization Discovery Copy/Paste',
      path: 'knowledge/product/orchestration/README.md',
      purpose: 'Copy the most common organization discovery commands',
      text_command:
        'node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary',
    },
  ];

  const examples = [
    {
      name: 'Organization Discovery Example',
      path: 'knowledge/product/schemas/organization-discovery-report.example.json',
      schema: 'knowledge/product/schemas/organization-discovery-report.schema.json',
      purpose: 'Validate the discovery overview contract and operator entrypoints',
    },
    {
      name: 'Organization Profile Example',
      path: 'knowledge/product/schemas/organization-profile-report.example.json',
      schema: 'knowledge/product/schemas/organization-profile-report.schema.json',
      purpose: 'Validate the resolved organization profile contract',
    },
    {
      name: 'Organization Profiles Example',
      path: 'knowledge/product/schemas/organization-profiles-report.example.json',
      schema: 'knowledge/product/schemas/organization-profiles-report.schema.json',
      purpose: 'Validate the organization roster and readiness inventory contract',
    },
    {
      name: 'Organization Catalog Example',
      path: 'knowledge/product/schemas/organization-catalog-report.example.json',
      schema: 'knowledge/product/schemas/organization-catalog-report.schema.json',
      purpose: 'Validate the selected template overlay contract',
    },
  ];

  const commonQuestions = [
    {
      question: 'What organization is selected right now?',
      command: 'node dist/scripts/mission_controller.js organization-profile --summary',
    },
    {
      question: 'Which customer orgs are missing a profile?',
      command:
        'node dist/scripts/mission_controller.js organization-profiles --missing-only --summary',
    },
    {
      question: 'Which team template overlays are active for this org?',
      command:
        'node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary',
    },
    {
      question: 'Which organization profiles are ready to use?',
      command:
        'node dist/scripts/mission_controller.js organization-profiles --ready-only --summary',
    },
  ];

  return {
    title: 'Organization Discovery',
    summary:
      'Operator entrypoint for organization selection, inventory, and template overlay inspection.',
    documents,
    examples,
    common_questions: commonQuestions,
  };
}

export function showOrganizationDiscovery(jsonOutput = false, summaryOnly = false) {
  const report = buildOrganizationDiscoveryReport();

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  logger.info('Organization Discovery');
  logger.info(
    'Use these entry points to switch organization context, inspect inventory, or copy commands.'
  );
  console.log('');
  for (const doc of report.documents) {
    console.log(`${doc.name}`);
    console.log(`  path: ${doc.path}`);
    console.log(`  purpose: ${doc.purpose}`);
    console.log(`  text: ${doc.text_command}`);
    console.log(`  json: ${doc.json_command}`);
    console.log('');
  }
  console.log('Canonical examples:');
  for (const example of report.examples) {
    console.log(`  - ${example.name}`);
    console.log(`    path: ${example.path}`);
    console.log(`    schema: ${example.schema}`);
    console.log(`    purpose: ${example.purpose}`);
  }
  console.log('');
  if (summaryOnly) {
    return;
  }
  console.log('Common questions:');
  for (const item of report.common_questions) {
    console.log(`  - ${item.question}`);
    console.log(`    ${item.command}`);
  }
  console.log('');
}
