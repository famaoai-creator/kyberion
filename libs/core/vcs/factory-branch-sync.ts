import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  matchHighRiskPaths,
  type AutonomousOpsDecision,
  type AutonomousOpsPolicy,
} from '../governance/autonomous-ops-gate.js';
import {
  evaluateDiffAgainstFactoryEnvelope,
  verifyFactoryEnvelopeIntegrity,
  type FactoryDeliveryEnvelope,
} from '../governance/factory-delivery-envelope.js';
import type { FactoryAutonomyPolicy } from '../governance/factory-policy.js';
import { runHardenedGitProbe } from '../shell/git-probe-hardening.js';
import type { VcsCommandRunner } from './git.js';

export const FACTORY_MECHANICAL_REGENERABLE_PATHS: readonly string[] = [
  'docs/developer/CONFIGURATION.md',
  'docs/developer/env.example',
  'docs/CLI_REFERENCE.md',
  'CAPABILITIES_GUIDE.md',
  'knowledge/_index.md',
  'knowledge/_integrity-manifest.json',
  'libs/core/foundation/config.generated.ts',
  'libs/core/foundation/runtime-state-roots.ts',
  'knowledge/product/governance/role-authority-map.json',
  'knowledge/product/governance/actuator-op-registry.json',
  'knowledge/product/orchestration/actuator-op-discovery.json',
  'knowledge/product/governance/env-registry.json',
  'knowledge/product/orchestration/vocabulary-types.generated.ts',
];

export type FactoryMainSyncClassification = 'clean' | 'mechanical' | 'semantic';
export type FactoryMainSyncActionId =
  'main_sync_clean' | 'conflict_mechanical' | 'conflict_semantic';
export type FactoryMainSyncStrategy = 'sync_and_test' | 'regenerate_and_test' | 'escalate_human';

export interface FactoryMergeTreeProbeResult {
  status: 'clean' | 'conflict' | 'unavailable';
  tree_oid?: string;
  conflict_paths: string[];
  reason?: string;
}

export interface FactoryMainSyncPlanInput {
  conflictPaths: readonly string[];
  tenantSlug?: string;
  factoryPolicy?: FactoryAutonomyPolicy;
  envelope?: FactoryDeliveryEnvelope;
  policy?: AutonomousOpsPolicy;
}

export interface FactoryMainSyncPlan {
  classification: FactoryMainSyncClassification;
  action_id: FactoryMainSyncActionId;
  strategy: FactoryMainSyncStrategy;
  allowed: boolean;
  conflict_paths: string[];
  mechanical_paths: string[];
  semantic_paths: string[];
  high_risk_paths: string[];
  commands: string[];
  reason: string;
  gate_decision: AutonomousOpsDecision;
  gate_shadow: boolean;
}

const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const REGENERABLE_SET = new Set(FACTORY_MECHANICAL_REGENERABLE_PATHS);

function normalizeRepoPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/u, '');
}

function normalizePathList(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeRepoPath).filter(Boolean))].sort();
}

export function classifySyncConflictPaths(
  conflictPaths: readonly string[],
  policy: AutonomousOpsPolicy = getAutonomousOpsPolicy()
): {
  classification: FactoryMainSyncClassification;
  conflict_paths: string[];
  mechanical_paths: string[];
  semantic_paths: string[];
  high_risk_paths: string[];
} {
  const normalized = normalizePathList(conflictPaths);
  if (normalized.length === 0) {
    return {
      classification: 'clean',
      conflict_paths: [],
      mechanical_paths: [],
      semantic_paths: [],
      high_risk_paths: [],
    };
  }

  const highRiskSet = new Set(matchHighRiskPaths(normalized, policy.high_risk_paths ?? []));
  for (const entry of normalized) {
    if (entry.split('/').includes('.git') || entry === 'pnpm-lock.yaml') highRiskSet.add(entry);
  }

  const mechanical: string[] = [];
  const semantic: string[] = [];
  for (const entry of normalized) {
    if (highRiskSet.has(entry)) {
      semantic.push(entry);
    } else if (REGENERABLE_SET.has(entry)) {
      mechanical.push(entry);
    } else {
      semantic.push(entry);
    }
  }

  const highRiskPaths = [...highRiskSet].sort();
  const classification: FactoryMainSyncClassification =
    semantic.length > 0 || highRiskPaths.length > 0 ? 'semantic' : 'mechanical';

  return {
    classification,
    conflict_paths: normalized,
    mechanical_paths: mechanical,
    semantic_paths: semantic,
    high_risk_paths: highRiskPaths,
  };
}

export function probeFactoryBranchMergeTree(input: {
  cwd: string;
  baseSha: string;
  headSha: string;
  run?: VcsCommandRunner;
}): FactoryMergeTreeProbeResult {
  const baseSha = input.baseSha.trim();
  const headSha = input.headSha.trim();
  if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
    return {
      status: 'unavailable',
      conflict_paths: [],
      reason: 'git merge-tree requires exact commit SHAs for baseSha and headSha',
    };
  }
  try {
    const res = runHardenedGitProbe(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, headSha],
      { cwd: input.cwd, timeoutMs: 30_000, maxOutputMB: 1 },
      input.run
    );
    if (res.error) {
      return {
        status: 'unavailable',
        conflict_paths: [],
        reason: `git merge-tree failed: ${res.error.message}`,
      };
    }
    const lines = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const treeOid = lines[0] && SHA_RE.test(lines[0]) ? lines[0] : undefined;
    if (res.status === 0 && treeOid) {
      return {
        status: 'clean',
        tree_oid: treeOid,
        conflict_paths: [],
      };
    }
    if (res.status === 1 && treeOid) {
      const conflictPaths = normalizePathList(lines.slice(1).filter((line) => !SHA_RE.test(line)));
      if (conflictPaths.length === 0) {
        return {
          status: 'unavailable',
          tree_oid: treeOid,
          conflict_paths: [],
          reason: 'git merge-tree exited with conflict status 1 without conflict path names',
        };
      }
      return {
        status: 'conflict',
        tree_oid: treeOid,
        conflict_paths: conflictPaths,
      };
    }
    return {
      status: 'unavailable',
      conflict_paths: [],
      reason: `git merge-tree exited with status ${String(res.status)}${res.stderr ? `: ${res.stderr.trim()}` : ''}`,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      conflict_paths: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function planFactoryBranchMainSync(input: FactoryMainSyncPlanInput): FactoryMainSyncPlan {
  if (input.envelope && !verifyFactoryEnvelopeIntegrity(input.envelope)) {
    return {
      classification: 'semantic',
      action_id: 'conflict_semantic',
      strategy: 'escalate_human',
      allowed: false,
      conflict_paths: normalizePathList(input.conflictPaths),
      mechanical_paths: [],
      semantic_paths: normalizePathList(input.conflictPaths),
      high_risk_paths: [],
      commands: [],
      reason: 'Factory delivery envelope failed integrity verification during main sync check',
      gate_decision: 'approve',
      gate_shadow: false,
    };
  }

  let policy: AutonomousOpsPolicy;
  try {
    policy = input.policy ?? getAutonomousOpsPolicy();
  } catch (error) {
    const normalized = normalizePathList(input.conflictPaths);
    return {
      classification: 'semantic',
      action_id: 'conflict_semantic',
      strategy: 'escalate_human',
      allowed: false,
      conflict_paths: normalized,
      mechanical_paths: [],
      semantic_paths: normalized,
      high_risk_paths: [],
      commands: [],
      reason: `Autonomous ops policy unavailable (${error instanceof Error ? error.message : String(error)}); failing closed`,
      gate_decision: 'approve',
      gate_shadow: false,
    };
  }

  const classified = classifySyncConflictPaths(input.conflictPaths, policy);
  const actionId: FactoryMainSyncActionId =
    classified.classification === 'clean'
      ? 'main_sync_clean'
      : classified.classification === 'mechanical'
        ? 'conflict_mechanical'
        : 'conflict_semantic';

  if (input.envelope && classified.conflict_paths.length > 0) {
    const diffCheck = evaluateDiffAgainstFactoryEnvelope({
      envelope: input.envelope,
      changed_paths: classified.conflict_paths,
      policy,
    });
    const blocking = diffCheck.violations.filter(
      (violation) =>
        violation.code === 'integrity_mismatch' ||
        violation.code === 'high_risk_path' ||
        violation.code === 'scope_out'
    );
    if (blocking.length > 0) {
      const gate = evaluateAutonomousOpsAction({
        actionId: 'conflict_semantic',
        tenantSlug: input.tenantSlug,
        executionMode: 'apply',
        changedPaths: classified.conflict_paths,
        factoryPolicy: input.factoryPolicy,
      });
      return {
        classification: 'semantic',
        action_id: 'conflict_semantic',
        strategy: 'escalate_human',
        allowed: false,
        conflict_paths: classified.conflict_paths,
        mechanical_paths: [],
        semantic_paths: classified.conflict_paths,
        high_risk_paths: diffCheck.high_risk_matches,
        commands: [],
        reason: `Factory delivery envelope blocks main sync conflict: ${blocking.map((v) => v.detail).join('; ')}`,
        gate_decision: gate.decision,
        gate_shadow: gate.shadow,
      };
    }
  }

  const gate = evaluateAutonomousOpsAction({
    actionId,
    tenantSlug: input.tenantSlug,
    executionMode: 'apply',
    changedPaths: classified.conflict_paths,
    factoryPolicy: input.factoryPolicy,
  });

  if (classified.classification === 'semantic') {
    return {
      classification: 'semantic',
      action_id: 'conflict_semantic',
      strategy: 'escalate_human',
      allowed: false,
      conflict_paths: classified.conflict_paths,
      mechanical_paths: classified.mechanical_paths,
      semantic_paths: classified.semantic_paths,
      high_risk_paths: classified.high_risk_paths,
      commands: [],
      reason: `Semantic or protected conflicts require human review: ${classified.semantic_paths.join(', ')}`,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  if (!gate.allowed) {
    return {
      classification: classified.classification,
      action_id: actionId,
      strategy: 'escalate_human',
      allowed: false,
      conflict_paths: classified.conflict_paths,
      mechanical_paths: classified.mechanical_paths,
      semantic_paths: classified.semantic_paths,
      high_risk_paths: [
        ...new Set([...classified.high_risk_paths, ...gate.highRiskPathMatches]),
      ].sort(),
      commands: [],
      reason: `${actionId} requires approval or shadow graduation: ${gate.reason}`,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  if (classified.classification === 'clean') {
    return {
      classification: 'clean',
      action_id: 'main_sync_clean',
      strategy: 'sync_and_test',
      allowed: true,
      conflict_paths: [],
      mechanical_paths: [],
      semantic_paths: [],
      high_risk_paths: [],
      commands: ['pnpm check -- --changed', 'pnpm exec vitest run --changed origin/main'],
      reason:
        'git merge-tree reported zero conflicts; clean branch sync permitted after test verification',
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  return {
    classification: 'mechanical',
    action_id: 'conflict_mechanical',
    strategy: 'regenerate_and_test',
    allowed: true,
    conflict_paths: classified.conflict_paths,
    mechanical_paths: classified.mechanical_paths,
    semantic_paths: [],
    high_risk_paths: [],
    commands: ['pnpm kyberion resolve generated', 'pnpm check -- --changed'],
    reason: `Mechanical generated-file conflict (${classified.mechanical_paths.join(', ')}); regenerate and re-run tests`,
    gate_decision: gate.decision,
    gate_shadow: gate.shadow,
  };
}

export function assessFactoryBranchMainSync(input: {
  cwd: string;
  baseSha: string;
  headSha: string;
  tenantSlug?: string;
  factoryPolicy?: FactoryAutonomyPolicy;
  envelope?: FactoryDeliveryEnvelope;
  policy?: AutonomousOpsPolicy;
  run?: VcsCommandRunner;
}): FactoryMainSyncPlan & { probe: FactoryMergeTreeProbeResult } {
  const probe = probeFactoryBranchMergeTree({
    cwd: input.cwd,
    baseSha: input.baseSha,
    headSha: input.headSha,
    run: input.run,
  });
  if (probe.status === 'unavailable') {
    return {
      classification: 'semantic',
      action_id: 'conflict_semantic',
      strategy: 'escalate_human',
      allowed: false,
      conflict_paths: [],
      mechanical_paths: [],
      semantic_paths: [],
      high_risk_paths: [],
      commands: [],
      reason: probe.reason ?? 'git merge-tree unavailable; failing closed to escalate_human',
      gate_decision: 'approve',
      gate_shadow: false,
      probe,
    };
  }
  const plan = planFactoryBranchMainSync({
    conflictPaths: probe.conflict_paths,
    tenantSlug: input.tenantSlug,
    factoryPolicy: input.factoryPolicy,
    envelope: input.envelope,
    policy: input.policy,
  });
  return { ...plan, probe };
}
