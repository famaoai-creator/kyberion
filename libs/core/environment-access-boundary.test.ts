import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const SOURCES = [
  ['libs/core/core.ts', /process\.env\.(?:LOG_LEVEL|NODE_ENV|DEBUG)/u],
  ['libs/core/agy-cli-backend.ts', /process\.env\.NODE_ENV/u],
  ['libs/core/memory-promotion-queue.ts', /process\.env\.NODE_ENV/u],
  ['libs/core/organization-operating-model-persistence.ts', /process\.env\.VITEST/u],
  ['libs/core/project-management.ts', /process\.env\.VITEST/u],
  ['libs/core/work-coordination.ts', /process\.env\.VITEST/u],
  ['libs/core/mission-creation.ts', /process\.env\.VITEST/u],
  ['libs/core/nhi-lifecycle-governance.ts', /process\.env\.VITEST/u],
  ['libs/core/agent-identity.ts', /process\.env\.VITEST/u],
  ['libs/core/nhi-actor-verification.ts', /process\.env\.VITEST/u],
  ['libs/core/chain-integrity.ts', /process\.env\.VITEST/u],
  ['libs/core/observability-gate.ts', /process\.env\.VITEST/u],
  ['libs/core/audit-chain.ts', /process\.env\.VITEST/u],
  ['libs/core/src/lock-utils.ts', /process\.env\.VITEST/u],
  ['libs/core/provider-health-registry.ts', /process\.env\.VITEST/u],
  ['libs/core/share-grant-graph.ts', /process\.env\.VITEST/u],
  ['libs/core/task-scoped-grants.ts', /process\.env\.VITEST/u],
  ['libs/core/spend-guard.ts', /process\.env\.VITEST/u],
  ['libs/core/operator-notifications.ts', /process\.env\.VITEST/u],
  ['scripts/run_baseline_check.ts', /process\.env\.VITEST/u],
  ['libs/core/mission-work-reconciliation.ts', /process\.env\.GITHUB_(?:HEAD_REF|REF_NAME|SHA)/u],
  ['scripts/lib/harness.ts', /process\.env\.LOG_LEVEL/u],
  ['scripts/demos/demo_telegram_flow.ts', /process\.env\.MISSION_ROLE/u],
  ['scripts/soak_restart_e2e.ts', /process\.env\.(?:VITEST|NODE_ENV)/u],
  [
    'scripts/generate_avatar.ts',
    /process\.env\.(?:CODEX_CLI|CODEX_VERSION|TERM_PROGRAM|AGY_CLI|ANTIGRAVITY_CLI)/u,
  ],
] as const;

describe('environment access boundary', () => {
  it('keeps shared runtime settings behind the registered environment API', () => {
    for (const [relativePath, directAccessPattern] of SOURCES) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      expect(source, relativePath).not.toMatch(directAccessPattern);
      expect(source, relativePath).toMatch(/getRegisteredEnvText|isVitestProcess/u);
    }
  });
});
