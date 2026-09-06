import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();
const allowedCoreFsImports = [
  'libs/core/action-item-store.test.ts',
  'libs/core/approval-rejection-reason.test.ts',
  'libs/core/approval-session-runtime.test.ts',
  'libs/core/reasoning-backend.failover-events.test.ts',
  'libs/core/reasoning-degradation.test.ts',
  'libs/core/reasoning-failover.test.ts',
  'libs/core/reconcile-ops.test.ts',
  'libs/core/review-reentry.test.ts',
  'libs/core/audit-chain-tenant.test.ts',
  // Mock-loader fixtures that read tmp-dir JSON outside the project root (secure-io denies it).
  'libs/core/policy-engine.test.ts',
  'libs/core/recovery-policy.test.ts',
  'libs/core/browser-extension-bridge.test.ts',
  'libs/core/chrome-extension-meeting-driver.test.ts',
  'libs/core/cli-subagent-team.e2e.test.ts',
  'libs/core/data-vault.test.ts',
  'libs/core/creative-design-resolver.test.ts',
  'libs/core/delegation-concurrency.test.ts',
  'libs/core/deliverable-inbox.test.ts',
  'libs/core/distill-knowledge-injector.test.ts',
  'libs/core/operator-home-summary.test.ts',
  'libs/core/operator-notifications.test.ts',
  'libs/core/mission-retrospective.test.ts',
  'libs/core/mission-hygiene.test.ts',
  'libs/core/mission-lifecycle-service.test.ts',
  'libs/core/src/pipeline-scheduler.test.ts',
  'libs/core/environment-capability.test.ts',
  'libs/core/evidence-chain.test.ts',
  'libs/core/fs-primitives.ts',
  'libs/core/heuristic-feedback.test.ts',
  'libs/core/intent-handoff.test.ts',
  'libs/core/jsonl-tail.test.ts',
  'libs/core/ledger.test.ts',
  'libs/core/meeting-participation-coordinator.test.ts',
  'libs/core/metrics.test.ts',
  'libs/core/mission-evidence-doc.test.ts',
  // AL-02 hermetic scoped-artifact tests: raw fs to seed/inspect a temp KYBERION_ROOT.
  'libs/core/artifact-store.test.ts',
  'libs/core/mission-seal.test.ts',
  'libs/core/output-artifacts.test.ts',
  // AL-01 hermetic purge test: raw fs to seed/inspect a temp KYBERION_ROOT.
  'libs/core/mission-maintenance.purge.test.ts',
  // AL-03 hermetic closure test: raw fs to seed/inspect a temp KYBERION_ROOT.
  'libs/core/mission-artifact-closure.test.ts',
  // AL-04 / NI-05 hermetic tests: raw fs to seed/inspect a temp repo root
  // (scope trees, trash, identity ledger) — secure-io is the module under
  // test's own seam, so the fixtures must bypass it.
  'libs/core/scope-offboarding.test.ts',
  'libs/core/nhi-lifecycle-governance.test.ts',
  'libs/core/mission-phase-exit-gates.test.ts',
  'libs/core/process-logger.test.ts',
  'libs/core/promoted-memory.test.ts',
  'libs/core/python-voice-bridge.test.ts',
  'libs/core/relationship-graph-store.test.ts',
  'libs/core/requirements-draft-store.test.ts',
  'libs/core/sdlc-artifact-store.test.ts',
  // Fixture setup needs raw fs to create symlinks and verify 0600/0700 modes.
  'libs/core/secret-bridge.test.ts',
  'libs/core/secure-io.branch.test.ts',
  'libs/core/secure-io.test.ts',
  'libs/core/secure-io.ts',
  'libs/core/security-boundary.contract.test.ts',
  'libs/core/speech-to-text-bridge.test.ts',
  'libs/core/src/actuator-capability.test.ts',
  'libs/core/src/feedback-loop.test.ts',
  'libs/core/src/knowledge-cache-budget.test.ts',
  'libs/core/src/knowledge-index.test.ts',
  'libs/core/src/native-docx-engine/__tests__/docx-engine.test.ts',
  'libs/core/src/native-pdf-engine/__tests__/pdf-binary.test.ts',
  'libs/core/src/native-pptx-engine/__tests__/pptx-engine.test.ts',
  'libs/core/src/native-pptx-engine/__tests__/pptx-filter-slides.test.ts',
  'libs/core/src/native-xlsx-engine/__tests__/xlsx-engine.test.ts',
  'libs/core/src/pfc/PfcController.test.ts',
  'libs/core/src/pfc/SovereignSentinel.test.ts',
  'libs/core/src/pipeline-engine.test.ts',
  'libs/core/src/pipeline-fragments-catalog.test.ts',
  'libs/core/src/pipeline-preview.test.ts',
  'libs/core/storage-janitor.test.ts',
  // AL-01 catalog loader test: raw fs for temp catalog fixtures.
  'libs/core/storage-retention-catalog.test.ts',
  'libs/core/tenant-registry.test.ts',
  'libs/core/tier-guard-tenant.test.ts',
  'libs/core/trust-engine.test.ts',
  'libs/core/validators.test.ts',
  'libs/core/worker-event-stream.test.ts',
  // Symlink/directory boundary probe fixtures: raw fs (mkdir/symlink/unlink/rm) to
  // construct a path that secure-io must reject as a traversal or type mismatch —
  // the negative case can't be exercised through the safe* API it is asserting against.
  'libs/core/agent-activity-board.test.ts',
  'libs/core/agent-input-queue.test.ts',
  'libs/core/agent-manifest.test.ts',
  'libs/core/analysis-corpus.test.ts',
  'libs/core/artifact-bundle.test.ts',
  'libs/core/artifact-review.test.ts',
  'libs/core/background-review-patch.test.ts',
  'libs/core/browser-extension-bridge.observation-boundary.test.ts',
  'libs/core/customer-channel-binding.test.ts',
  'libs/core/history-search-index.test.ts',
  'libs/core/intent-reconciliation.test.ts',
  'libs/core/intent-track-resolver.test.ts',
  'libs/core/knowledge-provider.test.ts',
  'libs/core/mission-context-pack.test.ts',
  'libs/core/mission-governance.test.ts',
  'libs/core/mission-orchestration-events.test.ts',
  'libs/core/mission-orchestration-progress.test.ts',
  'libs/core/model-registry-directory.test.ts',
  'libs/core/openai-compatible-backend.test.ts',
  'libs/core/openrouter-backend.test.ts',
  'libs/core/operator-learning-dispatch-registry.test.ts',
  'libs/core/persona-loader.test.ts',
  'libs/core/procedure-registry.test.ts',
  'libs/core/runtime-health-history.test.ts',
  'libs/core/tenant-design-resolver.test.ts',
  'libs/core/virtual-audio-input-recording-bridge.test.ts',
  'libs/core/virtual-audio-output-playback-bridge.test.ts',
  'libs/core/voice-profile-registry.test.ts',
  'libs/core/voice-sample-collection.test.ts',
  'libs/core/voice-sample-ingestion-policy.test.ts',
  'libs/core/work-graph-projection.test.ts',
  // Module-mock fixtures: these tests vi.mock (or vi.spyOn) `./secure-io.js` /
  // `node:fs` itself, or seed a real OS-tmpdir root outside the repo, so the
  // fixture setup and real-schema reads inside the mock factory must use raw
  // fs rather than the API under test / mock.
  'libs/core/agent-collaboration-projection.test.ts',
  'libs/core/baseline-check-cache.test.ts',
  'libs/core/cowork-health-check.test.ts',
  'libs/core/cowork-knowledge-bridge.test.ts',
  'libs/core/knowledge-scope-health-history.test.ts',
  'libs/core/model-performance-index.test.ts',
  'libs/core/preference-adapter.persistence.test.ts',
  'libs/core/procedure-self-repair.test.ts',
  'libs/core/promotion-candidates.test.ts',
  'libs/core/provider-discovery.test.ts',
].sort((a, b) => a.localeCompare(b));

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

describe('Core fs exception boundary', () => {
  it('keeps remaining direct fs imports in libs/core confined to the declared exception set', () => {
    const codeFiles = getAllFiles(path.join(rootDir, 'libs/core')).filter((filePath) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)
    );
    const directFsImports = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.endsWith('.js'))
      .filter((relPath) => !relPath.endsWith('.js.map'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return /from\s+['"](?:node:)?fs['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/.test(content);
      })
      .sort((a, b) => a.localeCompare(b));

    expect(directFsImports).toEqual(allowedCoreFsImports);
  });
});
