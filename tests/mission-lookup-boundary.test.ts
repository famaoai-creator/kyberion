import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * `findMissionPath` is the strict mission lookup: an id that exists in several
 * tenants (OWNER_AMBIGUOUS) or whose directory holds a state this process may
 * not see (OWNER_NOT_VISIBLE) THROWS, because for most callers "absent" is not
 * a safe answer:
 *
 *  - lifecycle:         mutation / governance / planning / operator tooling;
 *                       a thrown, structured refusal is reported to the caller.
 *  - scope-derivation:  tier, tenant, visibility or classification is derived
 *                       from the mission; absent means a looser default, so it
 *                       must fail closed.
 *  - placement:         absent means "use another location" (or create there);
 *                       a hidden mission would end up with a second copy.
 *
 * A path where absent is a conservative no-op (optional evidence write, a
 * report row, "no mission identity" for a permission check) uses
 * `missionPathOrNull(findMissionPath, id)` from `@agent/core/mission-lookup`
 * instead and does not appear here. Adding a direct caller is a deliberate
 * choice: register it below with its category.
 */
type LookupCategory = 'lifecycle' | 'scope-derivation' | 'placement';

const DIRECT_CALLERS: Record<string, LookupCategory> = {
  // lifecycle
  'libs/core/mission/mission-artifact-closure.ts': 'lifecycle',
  'libs/core/mission/mission-creation.ts': 'lifecycle',
  'libs/core/mission/mission-distill.ts': 'lifecycle',
  'libs/core/mission/mission-governance.ts': 'lifecycle',
  'libs/core/mission/mission-lifecycle-completion.ts': 'lifecycle',
  'libs/core/mission/mission-lifecycle-operator-actions.ts': 'lifecycle',
  'libs/core/mission/mission-lifecycle.ts': 'lifecycle',
  'libs/core/mission/mission-maintenance.ts': 'lifecycle',
  'libs/core/mission/mission-process-planning.ts': 'lifecycle',
  'libs/core/mission/mission-retrospective.ts': 'lifecycle',
  'libs/core/mission/mission-runtime.ts': 'lifecycle',
  'libs/core/mission/mission-scope-approval.ts': 'lifecycle',
  'libs/core/mission/mission-seal.ts': 'lifecycle',
  'libs/core/mission/mission-triage.ts': 'lifecycle',
  'libs/core/mission/mission-work-reconciliation.ts': 'lifecycle',
  'libs/core/workforce/work-inventory-promotion.ts': 'lifecycle',
  'scripts/background_review_mission_e2e.ts': 'lifecycle',
  'scripts/backup.ts': 'lifecycle',
  'scripts/export_validation_bundle.ts': 'lifecycle',
  'scripts/mission-alignment-gate/serve-brief.ts': 'lifecycle',
  'scripts/mission_alignment_decision.ts': 'lifecycle',
  'scripts/pipeline-execution-part-results.ts': 'lifecycle',
  'scripts/pipeline-reasoning-visibility.ts': 'lifecycle',
  // scope-derivation
  'libs/core/history-search-index.ts': 'scope-derivation',
  'libs/core/injection-signal.ts': 'scope-derivation',
  'libs/core/mark-target-resolver.ts': 'scope-derivation',
  'libs/core/mesh/a2a-conversation-store.ts': 'scope-derivation',
  'libs/core/mission/mission-read-model.ts': 'scope-derivation',
  'libs/core/mission/mission-team-plan-composer.ts': 'scope-derivation',
  'libs/core/reasoning/reasoning-backend.ts': 'scope-derivation',
  'libs/core/scope-context.ts': 'scope-derivation',
  'libs/core/tool/runtime-scope.ts': 'scope-derivation',
  'libs/core/untrusted-content.ts': 'scope-derivation',
  'libs/core/visual-raster.ts': 'scope-derivation',
  'presence/displays/chronos-mirror-v2/src/app/api/deliverable-preview/route.ts':
    'scope-derivation',
  'presence/displays/chronos-mirror-v2/src/app/api/mission-asset/helpers.ts': 'scope-derivation',
  'presence/displays/chronos-mirror-v2/src/lib/knowledge-scope.ts': 'scope-derivation',
  'presence/displays/chronos-mirror-v2/src/lib/su-surface-data.ts': 'scope-derivation',
  'presence/displays/chronos-mirror-v2/src/lib/trace-feed.ts': 'scope-derivation',
  'presence/displays/presence-studio/hearing-mission-routes.ts': 'scope-derivation',
  // placement
  'libs/actuators/system-actuator/src/system-pipeline-core-helpers.ts': 'placement',
  'libs/actuators/vision-actuator/src/vision-scope.ts': 'placement',
  'libs/actuators/wisdom-actuator/src/wisdom-pipeline-helpers.ts': 'placement',
  'libs/core/ledger.ts': 'placement',
  'libs/core/mission/mission-context-pack.ts': 'placement',
  'libs/core/mission/mission-state.ts': 'placement',
  'libs/core/mission/mission-ticket-dispatch.ts': 'placement',
  'libs/core/mission/mission-working-memory.ts': 'placement',
  'libs/core/mission/mission-workitem-dispatch.ts': 'placement',
  'libs/core/organization/organization-operation-run-recording.ts': 'placement',
  'libs/core/path-resolver.ts': 'placement',
  'libs/core/pipeline/pipeline-run-journal.ts': 'placement',
  'libs/core/video/ingest/video-brief.ts': 'placement',
  'libs/core/workforce/workspace-sweep.ts': 'placement',
};

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('Mission lookup boundary', () => {
  it('pins the direct findMissionPath callers to a registered category', () => {
    const callers = getAllFiles(rootDir)
      .filter((filePath) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(filePath))
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => /^(libs|scripts|presence)\//.test(relPath))
      .filter((relPath) => !/(^|\/)(node_modules|dist|\.next)\//.test(relPath))
      .filter((relPath) => !/\.test\.[cm]?[jt]sx?$/.test(relPath))
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return /(?<![\w$])(?:\w+\.)?findMissionPath\s*\(/.test(stripComments(content));
      })
      .sort((a, b) => a.localeCompare(b));

    expect(
      callers,
      'A new direct findMissionPath caller must be registered in DIRECT_CALLERS with its ' +
        'category (strict: throws on OWNER_AMBIGUOUS / OWNER_NOT_VISIBLE), or use ' +
        "missionPathOrNull(findMissionPath, id) from '@agent/core/mission-lookup' when absent " +
        'is a conservative no-op. Remove an entry here when its last caller goes away.'
    ).toEqual(Object.keys(DIRECT_CALLERS).sort((a, b) => a.localeCompare(b)));
  }, 60000);
});
