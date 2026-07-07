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
 *   pnpm company:bootstrap --vertical saas-product-company --slug acme --name "ACME株式会社" [--force]
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  logger,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

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
  const base = path.join(rootDir ?? pathResolver.rootDir(), 'templates', 'companies');
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
  const templateDir = path.join(templateRoot, 'templates', 'companies', vertical);
  if (!safeExistsSync(templateDir)) {
    const known = listCompanyVerticals(templateRoot);
    throw new Error(
      `[company-bootstrap] unknown vertical '${vertical}'. Available: ${known.join(', ') || '(none)'}`
    );
  }

  const customerDir = path.join(rootDir, 'customer', slug);
  if (safeExistsSync(path.join(customerDir, 'organization-profile.json')) && !input.force) {
    throw new Error(
      `[company-bootstrap] customer '${slug}' already has an organization profile. Re-run with --force to overwrite.`
    );
  }

  const companyName = input.companyName?.trim() || slug;
  safeMkdir(customerDir, { recursive: true });
  const writtenFiles: string[] = [];
  for (const entry of safeReaddir(templateDir) as string[]) {
    const sourcePath = path.join(templateDir, entry);
    const raw = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
    const materialized = raw
      .replaceAll('{COMPANY_SLUG}', slug)
      .replaceAll('{COMPANY_NAME}', companyName);
    const targetPath = path.join(customerDir, entry);
    safeWriteFile(targetPath, materialized);
    writtenFiles.push(targetPath);
  }

  // Fail fast on a broken template rather than at first mission creation.
  const profile = JSON.parse(
    safeReadFile(path.join(customerDir, 'organization-profile.json'), {
      encoding: 'utf8',
    }) as string
  ) as { team_defaults?: { team_template_catalog_id?: string } };
  const catalogId = profile.team_defaults?.team_template_catalog_id ?? 'default';
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
    path.join(rootDir, catalogRel),
    path.join(pathResolver.rootDir(), catalogRel),
  ];
  if (!catalogCandidates.some((candidate) => safeExistsSync(candidate))) {
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

function main(): number {
  // Operator-run scaffolding CLI: same execution context as the onboarding
  // wizard, which also writes under customer/ (see scripts/onboarding_wizard.ts).
  process.env.MISSION_ROLE = process.env.MISSION_ROLE || 'mission_controller';
  process.env.KYBERION_PERSONA = process.env.KYBERION_PERSONA || 'sovereign';
  const argv = process.argv.slice(2);
  const vertical = getFlag(argv, '--vertical');
  const slug = getFlag(argv, '--slug');
  const companyName = getFlag(argv, '--name');
  const force = argv.includes('--force');

  if (argv.includes('--list') || (!vertical && !slug)) {
    const verticals = listCompanyVerticals();
    console.log('Available company verticals:');
    for (const entry of verticals) console.log(`  - ${entry}`);
    console.log(
      '\nUsage: pnpm company:bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--force]'
    );
    return vertical || slug ? 1 : 0;
  }
  if (!vertical || !slug) {
    logger.error(
      'Usage: pnpm company:bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--force]'
    );
    return 1;
  }

  const result = bootstrapCompany({ vertical, slug, companyName, force });
  logger.success(`🏢 Company '${slug}' bootstrapped from vertical '${vertical}'.`);
  logger.info(`   Customer dir: ${result.customerDir}`);
  logger.info(`   Team template catalog: ${result.catalogId}`);
  logger.info('   Next steps:');
  logger.info(`     export KYBERION_CUSTOMER=${slug}`);
  logger.info('     node dist/scripts/mission_controller.js organization-profile --summary');
  logger.info(`     edit customer/${slug}/vision.md and customer.json with real company facts`);
  return 0;
}

const isDirectExecution = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  process.exit(main());
}
