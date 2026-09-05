#!/usr/bin/env node
/**
 * Company Bootstrap — 業態別会社テンプレートの実体化
 *
 * `templates/companies/<vertical>/` に定義された業態テンプレート
 * (organization-profile / org-chart / customer / identity / vision)を
 * `customer/<slug>/` へプレースホルダ({COMPANY_SLUG} / {COMPANY_NAME})を
 * 置換してコピーする。チームテンプレートカタログはテンプレート ID のまま
 * `knowledge/product/governance/organization-team-template-catalogs/` を
 * 参照するためコピー不要。
 *
 * Usage:
 *   pnpm onboard company bootstrap --vertical saas-product-company --slug acme --name "ACME株式会社" [--root-dir <path>] [--force]
 */

import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { loadOrganizationProfileAtPath } from '@agent/core/organization-profile';
import { defineScript, isDirectScript } from './lib/harness.js';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const VERTICAL_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export interface BootstrapCompanyInput {
  vertical: string;
  slug: string;
  companyName?: string;
  rootDir?: string;
  force?: boolean;
}

export interface BootstrapCompanyResult {
  customerDir: string;
  writtenFiles: string[];
  catalogId: string;
}

export function listCompanyVerticals(rootDir?: string): string[] {
  const resolvedRoot = rootDir ?? pathResolver.rootDir();
  const base = assertSafeRepositoryPath(path.join(resolvedRoot, 'templates', 'companies'), {
    allowMissingLeaf: true,
    rootDir: resolvedRoot,
  });
  if (!safeExistsSync(base)) return [];
  return (safeReaddir(base) as string[]).filter((entry) => !entry.includes('.')).sort();
}

export function bootstrapCompany(input: BootstrapCompanyInput): BootstrapCompanyResult {
  // Output goes to rootDir (isolated in tests); templates always ship with
  // the repository itself.
  const rootDir = input.rootDir ?? pathResolver.rootDir();
  const templateRoot = pathResolver.rootDir();
  const vertical = input.vertical.trim();
  const slug = input.slug.trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `[company-bootstrap] invalid slug '${slug}'; must match ${SLUG_PATTERN.source}`
    );
  }
  if (!VERTICAL_PATTERN.test(vertical)) {
    throw new Error(
      `[company-bootstrap] invalid vertical '${vertical}'; must match ${VERTICAL_PATTERN.source}`
    );
  }
  const templateDir = path.join(templateRoot, 'templates', 'companies', vertical);
  const safeTemplateDir = assertSafeRepositoryPath(templateDir, {
    allowMissingLeaf: true,
    rootDir: templateRoot,
  });
  if (!safeExistsSync(safeTemplateDir)) {
    const known = listCompanyVerticals(templateRoot);
    throw new Error(
      `[company-bootstrap] unknown vertical '${vertical}'. Available: ${known.join(', ') || '(none)'}`
    );
  }

  const customerDir = assertSafeRepositoryPath(path.join(rootDir, 'customer', slug), {
    allowMissingLeaf: true,
    rootDir,
  });
  const profileTarget = assertSafeRepositoryPath(
    path.join(customerDir, 'organization-profile.json'),
    {
      allowMissingLeaf: true,
      rootDir,
    }
  );
  if (safeExistsSync(profileTarget) && !input.force) {
    throw new Error(
      `[company-bootstrap] customer '${slug}' already has an organization profile. Re-run with --force to overwrite.`
    );
  }

  const companyName = input.companyName?.trim() || slug;
  safeMkdir(customerDir, { recursive: true });
  const writtenFiles: string[] = [];
  for (const entry of safeReaddir(safeTemplateDir) as string[]) {
    const sourcePath = assertSafeRepositoryPath(path.join(safeTemplateDir, entry), {
      rootDir: templateRoot,
    });
    if (!safeLstat(sourcePath).isFile()) continue;
    const raw = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
    const materialized = raw
      .replaceAll('{COMPANY_SLUG}', slug)
      .replaceAll('{COMPANY_NAME}', companyName);
    const targetPath = assertSafeRepositoryPath(path.join(customerDir, entry), {
      allowMissingLeaf: true,
      rootDir,
    });
    safeWriteFile(targetPath, materialized);
    writtenFiles.push(targetPath);
  }

  // Fail fast on a broken template rather than at first mission creation.
  if (!safeLstat(profileTarget).isFile()) {
    throw new Error('[company-bootstrap] materialized organization profile must be a regular file');
  }
  const profile = loadOrganizationProfileAtPath(profileTarget);
  const catalogId = profile.team_defaults?.team_template_catalog_id ?? 'default';
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(catalogId)) {
    throw new Error(`[company-bootstrap] invalid team template catalog id '${catalogId}'`);
  }
  const catalogRel = path.join(
    'knowledge',
    'product',
    'governance',
    'organization-team-template-catalogs',
    `${catalogId}.json`
  );
  // Catalogs ship with the repository; when bootstrapping into an isolated
  // rootDir (tests), fall back to the repo's own knowledge tree.
  const catalogCandidates = [
    assertSafeRepositoryPath(path.join(rootDir, catalogRel), {
      allowMissingLeaf: true,
      rootDir,
    }),
    assertSafeRepositoryPath(path.join(pathResolver.rootDir(), catalogRel), {
      allowMissingLeaf: true,
      rootDir: pathResolver.rootDir(),
    }),
  ];
  if (
    !catalogCandidates.some(
      (candidate) => safeExistsSync(candidate) && safeLstat(candidate).isFile()
    )
  ) {
    throw new Error(
      `[company-bootstrap] team template catalog '${catalogId}' not found at ${catalogCandidates[0]}`
    );
  }

  return { customerDir, writtenFiles, catalogId };
}

function getFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function main(argv: string[], print: (value: unknown) => void = () => undefined): number {
  // Operator-run scaffolding CLI: same execution context as the onboarding
  // wizard, which also writes under customer/ (see scripts/onboarding_wizard.ts).
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'mission_controller');
  }
  setRegisteredEnv('KYBERION_PERSONA', getRegisteredEnvText('KYBERION_PERSONA') || 'sovereign');
  const vertical = getFlag(argv, '--vertical');
  const slug = getFlag(argv, '--slug');
  const companyName = getFlag(argv, '--name');
  const rootDir = getFlag(argv, '--root-dir');
  const force = argv.includes('--force');

  if (argv.includes('--list') || (!vertical && !slug)) {
    const verticals = listCompanyVerticals();
    print(
      [
        'Available company verticals:',
        ...verticals.map((entry) => `  - ${entry}`),
        '',
        '\nUsage: pnpm onboard company bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--root-dir <path>] [--force]',
      ].join('\n')
    );
    return vertical || slug ? 1 : 0;
  }
  if (!vertical || !slug) {
    logger.error(
      'Usage: pnpm onboard company bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--root-dir <path>] [--force]'
    );
    return 1;
  }

  const result = bootstrapCompany({
    vertical,
    slug,
    companyName,
    rootDir: rootDir ? path.resolve(rootDir) : undefined,
    force,
  });
  logger.success(`🏢 Company '${slug}' bootstrapped from vertical '${vertical}'.`);
  logger.info(`   Customer dir: ${result.customerDir}`);
  logger.info(`   Team template catalog: ${result.catalogId}`);
  logger.info('   Next steps:');
  logger.info(`     export KYBERION_CUSTOMER=${slug}`);
  logger.info('     node dist/scripts/mission_controller.js organization-profile --summary');
  logger.info(`     edit customer/${slug}/vision.md and customer.json with real company facts`);
  return 0;
}

if (
  isDirectScript(import.meta.url, 'company_bootstrap.ts') ||
  isDirectScript(import.meta.url, 'company_bootstrap.js')
)
  void defineScript({
    name: 'onboard:company-bootstrap',
    flags: ['json', 'quiet'],
    run(context) {
      const status = main(context.argv, context.print);
      if (status !== 0) throw new Error(`company bootstrap failed with exit code ${status}`);
    },
  })();
