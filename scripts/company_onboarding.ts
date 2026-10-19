#!/usr/bin/env node
/** CLI compatibility wrapper for the canonical company onboarding service. */
import * as path from 'node:path';
import { onboardAiCompany } from '@agent/core/organization/company-onboarding';
import { listCompanyVerticals } from '@agent/core/organization/company-bootstrap';
import { defineScript, isDirectScript } from './lib/harness.js';

export { onboardAiCompany } from '@agent/core/organization/company-onboarding';
export type {
  AiCompanyOnboardingInput,
  AiCompanyOnboardingResult,
} from '@agent/core/organization/company-onboarding';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

export function main(argv: string[], print: (value: unknown) => void = () => undefined): number {
  if (argv.includes('--help') || argv.length === 0) {
    print(
      'Usage: pnpm onboarding company --vertical <id> --slug <slug> --name "<company>" --goal "<first work>" [--owner-id human:operator] [--tenant-slug <tenant>] [--root-dir <path>] [--dry-run]'
    );
    print(`Verticals: ${listCompanyVerticals().join(', ')}`);
    return argv.length === 0 ? 1 : 0;
  }
  const result = onboardAiCompany({
    vertical: flag(argv, '--vertical') || '',
    slug: flag(argv, '--slug') || '',
    companyName: flag(argv, '--name') || '',
    firstWork: flag(argv, '--goal') || '',
    accountableHumanId: flag(argv, '--owner-id'),
    ownerName: flag(argv, '--owner-name'),
    tenantSlug: flag(argv, '--tenant-slug'),
    rootDir: flag(argv, '--root-dir') ? path.resolve(flag(argv, '--root-dir')!) : undefined,
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
  });
  print(result);
  return 0;
}

if (
  isDirectScript(import.meta.url, 'company_onboarding.ts') ||
  isDirectScript(import.meta.url, 'company_onboarding.js')
)
  void defineScript({
    name: 'onboard:company',
    flags: ['json', 'dry-run', 'quiet'],
    run(context) {
      const status = main(context.argv, context.print);
      if (status !== 0) throw new Error(`company onboarding failed with exit code ${status}`);
    },
  })();
