#!/usr/bin/env node
/** CLI compatibility wrapper for the canonical company bootstrap service. */
import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { bootstrapCompany, listCompanyVerticals } from '@agent/core/organization/company-bootstrap';
import { defineScript, isDirectScript } from './lib/harness.js';

export { bootstrapCompany, listCompanyVerticals } from '@agent/core/organization/company-bootstrap';
export type {
  BootstrapCompanyInput,
  BootstrapCompanyResult,
} from '@agent/core/organization/company-bootstrap';

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
        '\nUsage: pnpm onboarding company bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--root-dir <path>] [--force]',
      ].join('\n')
    );
    return vertical || slug ? 1 : 0;
  }
  if (!vertical || !slug) {
    logger.error(
      'Usage: pnpm onboarding company bootstrap --vertical <id> --slug <slug> [--name "<会社名>"] [--root-dir <path>] [--force]'
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
