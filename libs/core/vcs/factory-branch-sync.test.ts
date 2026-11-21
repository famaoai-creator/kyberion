import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomousOpsPolicy } from '../governance/autonomous-ops-gate.js';
import { createFactoryDeliveryEnvelope } from '../governance/factory-delivery-envelope.js';
import type { FactoryAutonomyPolicy } from '../governance/factory-policy.js';
import { pathResolver } from '../path-resolver.js';
import { safeExecResult, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  assessFactoryBranchMainSync,
  classifySyncConflictPaths,
  planFactoryBranchMainSync,
} from './factory-branch-sync.js';

const testPolicy: AutonomousOpsPolicy = {
  version: '1.2.0',
  decision_thresholds: { auto_max_score: 3, notify_max_score: 6 },
  axis_weights: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
  high_risk_paths: ['AGENTS.md', 'pnpm-lock.yaml', '**/package.json'],
  actions: {},
};

const graduatedSyncPolicy: FactoryAutonomyPolicy = {
  version: '1.0.0',
  tenants: {
    acme: {
      enabled: true,
      graduated_actions: ['main_sync_clean', 'conflict_mechanical'],
    },
  },
};

describe('factory-branch-sync', () => {
  let root: string;

  const git = (args: string[]): string => {
    const res = safeExecResult('git', args, { cwd: root });
    if (res.status !== 0 || res.error) {
      throw new Error(res.stderr || `git ${args.join(' ')} failed`);
    }
    return res.stdout.trim();
  };

  const commitFile = (relPath: string, content: string, message: string): string => {
    const full = path.join(root, relPath);
    safeMkdir(path.dirname(full), { recursive: true });
    safeWriteFile(full, content);
    git(['add', '--', relPath]);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };

  beforeEach(() => {
    root = pathResolver.sharedTmp(`factory-branch-sync-${randomUUID()}`);
    safeMkdir(root, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    commitFile('README.md', '# fixture\n', 'init');
  });

  afterEach(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  it('classifies mechanical generated files separately from code and high-risk paths', () => {
    expect(classifySyncConflictPaths([], testPolicy).classification).toBe('clean');
    expect(
      classifySyncConflictPaths(['knowledge/_index.md', 'docs/CLI_REFERENCE.md'], testPolicy)
        .classification
    ).toBe('mechanical');
    expect(
      classifySyncConflictPaths(['knowledge/_index.md', 'libs/core/example.ts'], testPolicy)
        .classification
    ).toBe('semantic');
    const lockConflict = classifySyncConflictPaths(['pnpm-lock.yaml'], testPolicy);
    expect(lockConflict.classification).toBe('semantic');
    expect(lockConflict.high_risk_paths).toEqual(['pnpm-lock.yaml']);
  });

  it('enforces shadow graduation and factory envelope constraints on sync plans', () => {
    const ungraduated = planFactoryBranchMainSync({
      conflictPaths: [],
      tenantSlug: 'acme',
      policy: testPolicy,
    });
    expect(ungraduated.allowed).toBe(false);
    expect(ungraduated.strategy).toBe('escalate_human');

    const clean = planFactoryBranchMainSync({
      conflictPaths: [],
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      policy: testPolicy,
    });
    expect(clean.allowed).toBe(true);
    expect(clean.strategy).toBe('sync_and_test');

    const mechanical = planFactoryBranchMainSync({
      conflictPaths: ['knowledge/_index.md'],
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      policy: testPolicy,
    });
    expect(mechanical.allowed).toBe(true);
    expect(mechanical.strategy).toBe('regenerate_and_test');
    expect(mechanical.commands).toContain('pnpm kyberion resolve generated');

    const envelope = createFactoryDeliveryEnvelope({
      mission_id: 'MSN-SYNC-1',
      tenant_slug: 'acme',
      authority_kind: 'alignment_brief',
      alignment_approval_ref: 'apr-sync',
      development_branch: 'agent/factory-sync-1',
      scope_in: ['libs/core/example.ts'],
      scope_out: ['knowledge/_index.md'],
      allowed_paths: ['libs/core/example.ts'],
      merge_mode: 'veto_window',
    });
    const blockedByScopeOut = planFactoryBranchMainSync({
      conflictPaths: ['knowledge/_index.md'],
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      envelope,
      policy: testPolicy,
    });
    expect(blockedByScopeOut.allowed).toBe(false);
    expect(blockedByScopeOut.strategy).toBe('escalate_human');
  });

  it('probes real git merge-tree cleanly across clean, mechanical, and semantic conflicts', () => {
    const baseSha = git(['rev-parse', 'HEAD']);

    // Diverge branch from main: non-overlapping file + knowledge/_index.md + code.ts
    git(['checkout', '-qb', 'agent/factory-sync-test']);
    commitFile('knowledge/_index.md', 'branch-index\n', 'branch index');
    const branchCodeHead = commitFile(
      'libs/core/example.ts',
      'export const x = 1;\n',
      'branch code'
    );

    // Clean sync case: main edits an unrelated doc
    git(['checkout', '-q', 'main']);
    const mainCleanSha = commitFile('docs/other.md', 'other doc\n', 'main unrelated');
    const cleanAssessment = assessFactoryBranchMainSync({
      cwd: root,
      baseSha: mainCleanSha,
      headSha: branchCodeHead,
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      policy: testPolicy,
    });
    expect(cleanAssessment.probe.status).toBe('clean');
    expect(cleanAssessment.classification).toBe('clean');
    expect(cleanAssessment.strategy).toBe('sync_and_test');

    // Mechanical conflict case: main also edits knowledge/_index.md against a branch that only touched knowledge/_index.md
    git(['checkout', '-qb', 'agent/factory-mechanical-only', baseSha]);
    const branchMechanicalSha = commitFile('knowledge/_index.md', 'branch-only\n', 'branch mech');
    git(['checkout', '-q', 'main']);
    const mainMechanicalSha = commitFile('knowledge/_index.md', 'main-only\n', 'main mech');
    const mechanicalAssessment = assessFactoryBranchMainSync({
      cwd: root,
      baseSha: mainMechanicalSha,
      headSha: branchMechanicalSha,
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      policy: testPolicy,
    });
    expect(mechanicalAssessment.probe.status).toBe('conflict');
    expect(mechanicalAssessment.probe.conflict_paths).toEqual(['knowledge/_index.md']);
    expect(mechanicalAssessment.classification).toBe('mechanical');
    expect(mechanicalAssessment.strategy).toBe('regenerate_and_test');

    // Semantic conflict case: main also edits libs/core/example.ts
    const mainSemanticSha = commitFile(
      'libs/core/example.ts',
      'export const x = 2;\n',
      'main code'
    );
    const semanticAssessment = assessFactoryBranchMainSync({
      cwd: root,
      baseSha: mainSemanticSha,
      headSha: branchCodeHead,
      tenantSlug: 'acme',
      factoryPolicy: graduatedSyncPolicy,
      policy: testPolicy,
    });
    expect(semanticAssessment.probe.status).toBe('conflict');
    expect(semanticAssessment.probe.conflict_paths).toContain('libs/core/example.ts');
    expect(semanticAssessment.classification).toBe('semantic');
    expect(semanticAssessment.strategy).toBe('escalate_human');
    expect(semanticAssessment.allowed).toBe(false);
  });
});
