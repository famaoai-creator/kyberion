import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { resolveMissionWorkflowDesign } from '../libs/core/mission-workflow-catalog.js';

type PipelineTemplate = {
  name?: string;
  steps?: Array<{ id?: string; role?: string; op?: string; params?: Record<string, unknown> }>;
};

function readJson(relativePath: string): unknown {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string
  ) as unknown;
}

function readTemplate(relativePath: string): PipelineTemplate {
  return readJson(relativePath) as PipelineTemplate;
}

describe('CO-05 business process library', () => {
  it('adds the finance and board templates with preflight gates', () => {
    const financialClose = readTemplate(
      'knowledge/product/pipeline-templates/financial-close-monthly.json'
    );
    const boardPrep = readTemplate('knowledge/product/pipeline-templates/board-meeting-prep.json');
    const budgetReview = readTemplate('knowledge/product/pipeline-templates/budget-review.json');
    const hiringWorkflow = readTemplate(
      'knowledge/product/pipeline-templates/hiring-workflow.json'
    );
    const procurementVendor = readTemplate(
      'knowledge/product/pipeline-templates/procurement-vendor.json'
    );
    const performanceReview = readTemplate(
      'knowledge/product/pipeline-templates/performance-review.json'
    );
    const fundraisingPrep = readTemplate(
      'knowledge/product/pipeline-templates/fundraising-prep.json'
    );

    expect(financialClose.name).toBe('Financial Close Monthly');
    expect(boardPrep.name).toBe('Board Meeting Prep');
    expect(budgetReview.name).toBe('Budget Review');
    expect(hiringWorkflow.name).toBe('Hiring Workflow');
    expect(procurementVendor.name).toBe('Procurement Vendor');
    expect(performanceReview.name).toBe('Performance Review');
    expect(fundraisingPrep.name).toBe('Fundraising Prep');

    for (const template of [
      financialClose,
      boardPrep,
      budgetReview,
      hiringWorkflow,
      procurementVendor,
      performanceReview,
      fundraisingPrep,
    ]) {
      expect(template.steps?.[0]?.id).toBe('preflight');
      expect(template.steps?.[0]?.op).toBe('core:include');
      const fragment = String(template.steps?.[0]?.params?.fragment || '');
      expect([
        'fragments/runtime-preflight.json',
        'fragments/browser-runtime-preflight.json',
      ]).toContain(fragment);
    }
  });

  it('registers the new templates in the mission workflow catalog', () => {
    const catalog = readJson('knowledge/product/governance/mission-workflow-catalog.json') as {
      templates?: Array<{ id: string; match?: Record<string, unknown> }>;
    };

    expect(catalog.templates?.some((template) => template.id === 'financial-close-monthly')).toBe(
      true
    );
    expect(catalog.templates?.some((template) => template.id === 'board-meeting-prep')).toBe(true);
    expect(catalog.templates?.some((template) => template.id === 'budget-review')).toBe(true);
    expect(catalog.templates?.some((template) => template.id === 'hiring-workflow')).toBe(true);
    expect(catalog.templates?.some((template) => template.id === 'procurement-vendor')).toBe(true);
    expect(catalog.templates?.some((template) => template.id === 'performance-review')).toBe(true);
    expect(catalog.templates?.some((template) => template.id === 'fundraising-prep')).toBe(true);
  });

  it('resolves the new business workflows by intent id', () => {
    const financialClose = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'approval_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'financial-close-monthly',
      taskType: 'finance_close',
    });
    const boardPrep = resolveMissionWorkflowDesign({
      missionClass: 'decision_support',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'execution',
      executionShape: 'mission',
      intentId: 'board-meeting-prep',
      taskType: 'board_prep',
    });
    const budgetReview = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'approval_required',
      stage: 'verification',
      executionShape: 'mission',
      intentId: 'budget-review',
      taskType: 'budget_review',
    });
    const hiringWorkflow = resolveMissionWorkflowDesign({
      missionClass: 'decision_support',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'hiring-workflow',
      taskType: 'hiring_workflow',
    });
    const procurementVendor = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'approval_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'procurement-vendor',
      taskType: 'procurement_vendor',
    });
    const performanceReview = resolveMissionWorkflowDesign({
      missionClass: 'decision_support',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'performance-review',
      taskType: 'performance_review',
    });
    const fundraisingPrep = resolveMissionWorkflowDesign({
      missionClass: 'decision_support',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'fundraising-prep',
      taskType: 'fundraising_prep',
    });

    expect(financialClose.workflow_id).toBe('financial-close-monthly');
    expect(boardPrep.workflow_id).toBe('board-meeting-prep');
    expect(budgetReview.workflow_id).toBe('budget-review');
    expect(hiringWorkflow.workflow_id).toBe('hiring-workflow');
    expect(procurementVendor.workflow_id).toBe('procurement-vendor');
    expect(performanceReview.workflow_id).toBe('performance-review');
    expect(fundraisingPrep.workflow_id).toBe('fundraising-prep');
    expect(financialClose.phases).toContain('preflight');
    expect(boardPrep.phases).toContain('contract_authoring');
    expect(budgetReview.phases).toContain('preflight');
    expect(hiringWorkflow.phases).toContain('preflight');
    expect(procurementVendor.phases).toContain('preflight');
    expect(performanceReview.phases).toContain('preflight');
    expect(fundraisingPrep.phases).toContain('contract_authoring');
  });
});
