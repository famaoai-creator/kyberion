#!/usr/bin/env node
/**
 * AI company onboarding: materialize a vertical, bind human accountability,
 * create the initial AI workforce, and leave one reviewed first-work plan.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeReadFile, safeMkdir, safeWriteFile } from '@agent/core';
import { bootstrapCompany, listCompanyVerticals } from './company_bootstrap.js';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export interface AiCompanyOnboardingInput {
  vertical: string;
  slug: string;
  companyName: string;
  firstWork: string;
  accountableHumanId?: string;
  ownerName?: string;
  rootDir?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface AiCompanyOnboardingResult {
  status: 'planned' | 'ready';
  customerDir: string;
  readinessPath: string;
  firstWorkPath: string;
  writtenFiles: string[];
  nextCommands: string[];
}

function validateInput(input: AiCompanyOnboardingInput): void {
  if (!SLUG_PATTERN.test(input.slug.trim())) {
    throw new Error(`[company-onboard] invalid slug '${input.slug}'`);
  }
  if (!listCompanyVerticals().includes(input.vertical.trim())) {
    throw new Error(
      `[company-onboard] unknown vertical '${input.vertical}'. Available: ${listCompanyVerticals().join(', ')}`
    );
  }
  if (!input.companyName.trim()) throw new Error('[company-onboard] companyName is required');
  if (!input.firstWork.trim()) throw new Error('[company-onboard] firstWork is required');
}

function writeJson(filePath: string, value: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(value, null, 2));
}

export function onboardAiCompany(input: AiCompanyOnboardingInput): AiCompanyOnboardingResult {
  const normalized = {
    ...input,
    vertical: input.vertical.trim(),
    slug: input.slug.trim(),
    companyName: input.companyName.trim(),
    firstWork: input.firstWork.trim(),
    accountableHumanId: input.accountableHumanId?.trim() || 'human:operator',
    ownerName: input.ownerName?.trim() || 'Operator',
  };
  validateInput(normalized);
  const rootDir = normalized.rootDir || pathResolver.rootDir();
  const customerDir = path.join(rootDir, 'customer', normalized.slug);
  const readinessPath = path.join(customerDir, 'onboarding', 'ai-company-readiness.json');
  const firstWorkPath = path.join(customerDir, 'onboarding', 'first-work-plan.md');
  const nextCommands = [
    `export KYBERION_CUSTOMER=${normalized.slug}`,
    'pnpm setup:report --persona first-time-user',
    `pnpm mission --start "${normalized.firstWork}"`,
  ];

  if (normalized.dryRun) {
    return {
      status: 'planned',
      customerDir,
      readinessPath,
      firstWorkPath,
      writtenFiles: [],
      nextCommands,
    };
  }

  const bootstrapped = bootstrapCompany({
    vertical: normalized.vertical,
    slug: normalized.slug,
    companyName: normalized.companyName,
    rootDir,
    force: normalized.force,
  });
  const profilePath = path.join(customerDir, 'organization-profile.json');
  const profile = JSON.parse(safeReadFile(profilePath, { encoding: 'utf8' }) as string) as Record<
    string,
    unknown
  >;
  profile.accountable_human_resource_id = normalized.accountableHumanId;
  profile.workforce = {
    mode: 'solo_founder_ai_workforce',
    accountable_human_resource_id: normalized.accountableHumanId,
    default_approval_holder: normalized.accountableHumanId,
    default_budget_posture: 'block',
  };
  writeJson(profilePath, profile);

  const now = new Date().toISOString();
  const readiness = {
    version: '1.0.0',
    status: 'ready_for_first_work',
    organization_id: normalized.slug,
    company_name: normalized.companyName,
    vertical: normalized.vertical,
    accountable_human: {
      resource_id: normalized.accountableHumanId,
      display_name: normalized.ownerName,
      actor_type: 'human',
      final_decision_holder: true,
    },
    workforce: [
      {
        resource_id: `agent:${normalized.slug}:ceo-operator`,
        resource_type: 'agent',
        display_name: 'AI CEO Operator',
        accountable_human_id: normalized.accountableHumanId,
        capabilities: ['planning', 'execution', 'review', 'reporting'],
        status: 'active',
      },
    ],
    boundaries: {
      human_approval_required_for: [
        'contract_signature',
        'payment_or_purchase',
        'external_publication',
        'credential_or_authority_change',
        'hiring_or_termination',
      ],
      ai_can_prepare_but_not_finalize: true,
      budget_posture: 'block',
    },
    first_work: {
      goal: normalized.firstWork,
      status: 'planned',
      created_at: now,
      review_before_execution: true,
    },
  };
  writeJson(readinessPath, readiness);
  safeMkdir(path.dirname(firstWorkPath), { recursive: true });
  safeWriteFile(
    firstWorkPath,
    [
      `# First Work Plan: ${normalized.companyName}`,
      '',
      `- Goal: ${normalized.firstWork}`,
      `- Accountable human: ${normalized.accountableHumanId}`,
      `- AI worker: agent:${normalized.slug}:ceo-operator`,
      '- Status: planned (human review required before execution)',
      '',
      '## Next step',
      '- Review this plan and run the mission only after confirming scope, budget, and acceptance criteria.',
      '',
    ].join('\n')
  );
  return {
    status: 'ready',
    customerDir,
    readinessPath,
    firstWorkPath,
    writtenFiles: [...bootstrapped.writtenFiles, profilePath, readinessPath, firstWorkPath],
    nextCommands,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(
      'Usage: pnpm company:onboard --vertical <id> --slug <slug> --name "<company>" --goal "<first work>" [--owner-id human:operator] [--dry-run]'
    );
    return argv.length === 0 ? 1 : 0;
  }
  const result = onboardAiCompany({
    vertical: flag(argv, '--vertical') || '',
    slug: flag(argv, '--slug') || '',
    companyName: flag(argv, '--name') || '',
    firstWork: flag(argv, '--goal') || '',
    accountableHumanId: flag(argv, '--owner-id'),
    ownerName: flag(argv, '--owner-name'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMainModule) process.exit(main());
