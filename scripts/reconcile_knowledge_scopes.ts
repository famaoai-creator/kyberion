#!/usr/bin/env node
/** KO-19: weekly tenant-scope reconciliation and steward-facing report. */
import {
  listTenantProfileSlugs,
  pathResolver,
  safeWriteFile,
  sendOpsAlert,
  withExecutionContext,
  type ScopeContext,
} from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  runKnowledgeValidationSweep,
  proposeKnowledgeRankingWeightRecalculation,
} from '@agent/core';
import { buildPlan } from './migrate_physical_namespaces.js';
import { scanKnowledgeScopeHealth, buildHealthAlert } from './watch_knowledge_scope_health.js';
import { scan as scanKnowledgeScopeBoundaries } from './check_knowledge_scope_boundaries.js';
import {
  scan as scanTierHygiene,
  type Violation as TierHygieneViolation,
} from './check_tier_hygiene.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface KnowledgeScopeReconciliationReport {
  generated_at: string;
  status: 'healthy' | 'attention';
  health: ReturnType<typeof scanKnowledgeScopeHealth>;
  migration_plans: Array<ReturnType<typeof buildPlan>>;
  validation: ReturnType<typeof runKnowledgeValidationSweep>;
  weight_proposals: Array<ReturnType<typeof proposeKnowledgeRankingWeightRecalculation>>;
  semantic_findings: string[];
  tier_hygiene_findings: TierHygieneViolation[];
}

function reportPath(): string {
  return pathResolver.rootResolve(
    getRegisteredEnvText('KYBERION_KNOWLEDGE_SCOPE_RECONCILIATION_PATH')?.trim() ||
      'active/shared/runtime/reports/knowledge-scope-reconciliation-latest.json'
  );
}

export async function reconcileKnowledgeScopes(): Promise<KnowledgeScopeReconciliationReport> {
  return withExecutionContext('ecosystem_architect', async () => {
    const health = scanKnowledgeScopeHealth({ persistHistory: true });
    const migrationPlans = (['feedback', 'intent', 'ledger', 'promotion'] as const).map((kind) =>
      buildPlan(kind, false)
    );
    const validation = runKnowledgeValidationSweep();
    const weightProposals = listTenantProfileSlugs().flatMap((tenant) => {
      try {
        return [
          proposeKnowledgeRankingWeightRecalculation({
            scope: { tier: 'confidential', tenant_slug: tenant } satisfies ScopeContext,
            persist: false,
          }),
        ];
      } catch {
        return [];
      }
    });
    const semanticFindings = scanKnowledgeScopeBoundaries();
    const tierHygieneFindings = await scanTierHygiene();
    const hasMigrationAttention = migrationPlans.some((plan) =>
      ['quarantine', 'conflict'].some(
        (disposition) => (plan.summary.by_disposition as Record<string, number>)[disposition] > 0
      )
    );
    const report: KnowledgeScopeReconciliationReport = {
      generated_at: new Date().toISOString(),
      status:
        health.status === 'attention' ||
        validation.status === 'attention' ||
        hasMigrationAttention ||
        semanticFindings.length > 0 ||
        tierHygieneFindings.length > 0
          ? 'attention'
          : 'healthy',
      health,
      migration_plans: migrationPlans,
      validation,
      weight_proposals: weightProposals,
      semantic_findings: semanticFindings,
      tier_hygiene_findings: tierHygieneFindings,
    };
    safeWriteFile(reportPath(), `${JSON.stringify(report, null, 2)}\n`, { mkdir: true });
    return report;
  });
}

export const runKnowledgeScopeReconciliation = defineScript({
  name: 'knowledge:scope-reconcile',
  flags: [],
  run: async ({ argv }) => {
    try {
      const report = await reconcileKnowledgeScopes();
      if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else
        console.log(
          `${report.status}: ${report.migration_plans.length} migration plans; report=${reportPath()}`
        );
      if (argv.includes('--alert') && report.status === 'attention') {
        const receipt = sendOpsAlert({
          ...buildHealthAlert(report.health),
          title: 'Weekly tenant knowledge scope reconciliation requires attention',
          context: {
            ...report.health.summary,
            semantic_findings: report.semantic_findings,
            tier_hygiene_findings: report.tier_hygiene_findings,
            validation: report.validation,
          },
          dedupe_key: 'knowledge-scope-reconciliation',
        });
        if (!argv.includes('--quiet')) console.warn(`ops alert: ${receipt.recorded_path}`);
      }
      if (argv.includes('--fail') && report.status !== 'healthy') {
        throw new ScriptExitError(1, '', true);
      }
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      throw new ScriptExitError(
        2,
        `[knowledge-scope-reconciliation] fatal: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

if (
  isDirectScript(import.meta.url, 'reconcile_knowledge_scopes.ts') ||
  isDirectScript(import.meta.url, 'reconcile_knowledge_scopes.js')
)
  void runKnowledgeScopeReconciliation();
