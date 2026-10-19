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
 *   pnpm onboarding company bootstrap --vertical saas-product-company --slug acme --name "ACME株式会社" [--root-dir <path>] [--force]
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import { readTextFile } from '../foundation/index.js';
import { loadOrganizationProfileAtPath } from './organization-profile.js';

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
    const raw = readTextFile(sourcePath);
    // Company placeholders in JSON templates are string contents, while
    // Markdown must retain the name verbatim. Escape only the JSON content;
    // callback replacements also keep dollar replacement tokens literal.
    const templateCompanyName = entry.endsWith('.json')
      ? JSON.stringify(companyName).slice(1, -1)
      : companyName;
    const materialized = raw
      .replaceAll('{COMPANY_SLUG}', slug)
      .replaceAll('{COMPANY_NAME}', () => templateCompanyName);
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
