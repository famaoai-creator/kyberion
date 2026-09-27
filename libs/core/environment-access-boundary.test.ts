import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const SOURCES = [
  ['libs/core/core.ts', /process\.env\.(?:LOG_LEVEL|NODE_ENV|DEBUG)/u],
  ['libs/core/provider/agy-cli-backend.ts', /process\.env\.NODE_ENV/u],
  ['libs/core/knowledge/memory-promotion-queue.ts', /process\.env\.NODE_ENV/u],
  ['libs/core/ops-alert.ts', /process\.env\[OPS_ALERT_WEBHOOK_ENV\]/u],
  ['libs/core/workforce/worker-context-compaction.ts', /process\.env\[name\]/u],
  ['libs/core/media/media-backend-registry.ts', /process\.env\[name\]/u],
  ['libs/core/actuator/actuator-capability.ts', /process\.env\[envName\]/u],
  [
    'libs/core/environment-capability.ts',
    /process\.env\[(?:MANIFEST_SIGNING_KEY_ENV|probe\.name)\]/u,
  ],
  ['libs/core/secret/secret-guard.ts', /process\.env\[key\]/u],
  ['libs/core/secret/secret-bridge.ts', /(?:process\.env\[key\]|delete process\.env\[key\])/u],
  ['libs/core/organization/organization-operating-model-persistence.ts', /process\.env\.VITEST/u],
  ['libs/core/project/project-management.ts', /process\.env\.VITEST/u],
  ['libs/core/workforce/work-coordination.ts', /process\.env\.VITEST/u],
  ['libs/core/mission/mission-creation.ts', /process\.env\.VITEST/u],
  ['libs/core/nhi-lifecycle-governance.ts', /process\.env\.VITEST/u],
  ['libs/core/agent/agent-identity.ts', /process\.env\.VITEST/u],
  ['libs/core/nhi-actor-verification.ts', /process\.env\.VITEST/u],
  ['libs/core/chain-integrity.ts', /process\.env\.VITEST/u],
  ['libs/core/analysis/observability-gate.ts', /process\.env\.VITEST/u],
  ['libs/core/governance/audit-chain.ts', /process\.env\.VITEST/u],
  ['libs/core/foundation/lock-utils.ts', /process\.env\.VITEST/u],
  ['libs/core/provider/provider-health-registry.ts', /process\.env\.VITEST/u],
  ['libs/core/share-grant-graph.ts', /process\.env\.VITEST/u],
  ['libs/core/task/task-scoped-grants.ts', /process\.env\.VITEST/u],
  ['libs/core/spend-guard.ts', /process\.env\.VITEST/u],
  ['libs/core/surface/operator-notifications.ts', /process\.env\.VITEST/u],
  ['scripts/run_baseline_check.ts', /process\.env\.VITEST/u],
  ['scripts/peer_network_register.ts', /process\.env\[secretEnv\]/u],
  ['scripts/backup.ts', /process\.env\[(?:envName|options\.passphraseEnv)\]/u],
  [
    'libs/core/mission/mission-work-reconciliation.ts',
    /process\.env\.GITHUB_(?:HEAD_REF|REF_NAME|SHA)/u,
  ],
  // 1d92b899f moved the harness body to @agent/core/script-harness; scripts/lib/harness.ts
  // is now a pure re-export barrel, so the env boundary lives at the new location.
  ['libs/core/script-harness.ts', /process\.env\.LOG_LEVEL/u],
  ['scripts/demos/demo_telegram_flow.ts', /process\.env\.MISSION_ROLE/u],
  ['scripts/soak_restart_e2e.ts', /process\.env\.(?:VITEST|NODE_ENV)/u],
  [
    'scripts/generate_avatar.ts',
    /process\.env\.(?:CODEX_CLI|CODEX_VERSION|TERM_PROGRAM|AGY_CLI|ANTIGRAVITY_CLI|CURSOR_CLI|CURSOR_AGENT|CURSOR_API_KEY|KYBERION_CURSOR_CLI_BIN)/u,
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
