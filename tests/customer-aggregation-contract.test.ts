import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Customer aggregation contract', () => {
  it('documents stance:create as an available command', () => {
    const doc = read('docs/developer/CUSTOMER_AGGREGATION.md');
    const jp = read('docs/developer/CUSTOMER_AGGREGATION.ja.md');
    const customerReadme = read('customer/README.md');
    expect(doc).toContain('pnpm stance:create <slug>');
    expect(doc).toContain('[x] CLI: `pnpm stance:create <slug>`');
    expect(doc).toContain('[x] CLI: `pnpm stance:list`');
    expect(doc).toContain('[x] CLI: `pnpm stance:switch <slug>`');
    expect(doc).toContain('[x] Migration helper: `pnpm stance:migrate-from-personal`');
    expect(doc).toContain('[x] Connections consumer (`libs/core/service/service-engine.ts`)');
    expect(doc).toContain('[x] Policy consumer (`libs/core/governance/approval-policy.ts`)');
    expect(doc).toContain(
      '[x] Mission seeds consumer (`libs/core/mission/mission-seed-registry.ts`)'
    );
    expect(doc).toContain(
      '[x] Voice profile registry consumer (`libs/core/voice/voice-profile-registry.ts`)'
    );
    expect(doc).toContain('[x] Vital check consumer (`scripts/vital_check.ts`)');
    expect(doc).toContain('[x] Baseline check consumer (`scripts/run_baseline_check.ts`)');
    expect(doc).toContain('[x] Onboarding apply consumer (`scripts/onboarding_apply.ts`)');
    expect(doc).toContain(
      '[x] Slack onboarding consumer (`libs/core/integrations/slack-onboarding.ts`)'
    );
    expect(doc).toContain('legacy personal fallback');
    expect(doc).toContain('legacy `knowledge/personal/` behavior');
    expect(doc).toContain(
      'knowledge/personal/` remains the legacy personal fallback when no customer is active'
    );
    expect(doc).toContain('Legacy personal fallback (`knowledge/personal/`)');
    expect(doc).toContain('knowledge/personal/{path}     ← existing, legacy fallback');
    expect(jp).toContain('[x] `pnpm stance:create`');
    expect(jp).toContain('[x] `stance:list`');
    expect(jp).toContain('[x] `stance:switch`');
    expect(jp).toContain('[x] 移行ヘルパ');
    expect(jp).toContain('customer overlay がないレガシー単一利用前提');
    expect(jp).toContain('レガシーフォールバック');
    expect(jp).toContain('レガシーフォールバックとして使う');
    expect(jp).toContain('[x] baseline check consumer (`scripts/run_baseline_check.ts`)');
    expect(jp).toContain('[x] onboarding apply consumer (`scripts/onboarding_apply.ts`)');
    expect(jp).toContain(
      '[x] slack onboarding consumer (`libs/core/integrations/slack-onboarding.ts`)'
    );
    expect(customerReadme).toContain('pnpm stance:create acme-corp');
    expect(customerReadme).toContain('pnpm stance:list');
    expect(customerReadme).toContain(
      'required customer.json / identity.json / vision.md files are present'
    );
    expect(customerReadme).toContain('pnpm stance:migrate-from-personal acme-corp');
    expect(customerReadme).toContain('pnpm stance:switch acme-corp');
    expect(customerReadme).toContain(
      'stance:switch requires customer.json / identity.json / vision.md to be present'
    );
  });
});
