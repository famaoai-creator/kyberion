import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  assertServiceCaptureOperation,
  createServiceExecutionReceipt,
  describeServiceHarness,
  planServiceOperation,
  persistServiceExecutionReceipt,
  verifyServiceOperationResult,
} from './service-harness.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('service harness contract', () => {
  it('validates existing service presets against the typed operation schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/service-presets.schema.json')
    );
    const slack = getServicePresetRecord('slack');
    const github = getServicePresetRecord('github');

    expect(slack).toBeDefined();
    expect(validate(slack)).toBe(true);
    expect(github).toBeDefined();
    expect(validate(github)).toBe(true);
  });

  it('describes service operations from the canonical preset', () => {
    const descriptor = describeServiceHarness('github');
    const createIssue = descriptor.operations.find(
      (operation) => operation.action === 'create_issue'
    );

    expect(descriptor.kind).toBe('service-harness-descriptor.v1');
    expect(descriptor.operation_count).toBeGreaterThan(0);
    expect(createIssue).toMatchObject({
      action: 'create_issue',
      kind: 'apply',
      risk: 'write',
      approval_required: true,
    });
    expect(createIssue?.parameters.title).toMatchObject({ required: true, type: 'string' });
  });

  it('exposes GitHub review submit operations as write-gated apply', () => {
    const descriptor = describeServiceHarness('github');
    for (const action of ['create_review', 'create_review_comment'] as const) {
      const operation = descriptor.operations.find((item) => item.action === action);
      expect(operation).toMatchObject({
        action,
        kind: 'apply',
        risk: 'write',
        approval_required: true,
      });
    }
    expect(descriptor.operation_count).toBe(19);
  });

  it('classifies github-mcp create_issue as write-gated, not capture', () => {
    const descriptor = describeServiceHarness('github-mcp');
    const createIssue = descriptor.operations.find((item) => item.action === 'create_issue');
    expect(createIssue).toMatchObject({
      action: 'create_issue',
      kind: 'apply',
      risk: 'write',
      approval_required: true,
    });
    expect(() => assertServiceCaptureOperation('github-mcp', 'create_issue')).toThrow(
      /Capture-only surface rejected/
    );
  });

  it('exposes GitHub issue/PR/review capture operations as read-only', () => {
    const descriptor = describeServiceHarness('github');
    const captureActions = [
      'list_issues',
      'get_issue',
      'list_pulls',
      'get_pull',
      'list_reviews',
      'list_review_comments',
      'list_pr_files',
    ];
    for (const action of captureActions) {
      const operation = descriptor.operations.find((item) => item.action === action);
      expect(operation).toMatchObject({
        action,
        kind: 'capture',
        risk: 'read',
        approval_required: false,
      });
    }
  });

  it('admits GitHub capture ops and rejects writes on the capture guard', () => {
    expect(assertServiceCaptureOperation('github', 'list_issues').action).toBe('list_issues');
    expect(assertServiceCaptureOperation('github', 'list_pulls').risk).toBe('read');
    expect(() => assertServiceCaptureOperation('github', 'create_issue')).toThrow(
      /Capture-only surface rejected/
    );
    expect(() => assertServiceCaptureOperation('github', 'create_review')).toThrow(
      /Capture-only surface rejected/
    );
    expect(() => assertServiceCaptureOperation('github', 'create_review_comment')).toThrow(
      /Capture-only surface rejected/
    );
    expect(() => assertServiceCaptureOperation('github', 'not_an_action')).toThrow(
      /Unknown service action/
    );
  });

  it('builds a valid read plan and a write plan with required inputs', () => {
    const readPlan = planServiceOperation('github', 'list_repos');
    expect(readPlan.valid).toBe(true);
    expect(readPlan.risk).toBe('read');
    expect(readPlan.approval_required).toBe(false);

    const writePlan = planServiceOperation('github', 'create_issue', {
      owner: 'famaoai',
      repo: 'kyberion',
    });
    expect(writePlan.valid).toBe(false);
    expect(writePlan.validation_errors).toContain('title is required');
    expect(writePlan.approval_required).toBe(true);

    const reviewPlan = planServiceOperation('github', 'create_review', {
      owner: 'famaoai',
      repo: 'kyberion',
      pull_number: 713,
    });
    expect(reviewPlan.valid).toBe(false);
    expect(reviewPlan.validation_errors).toContain('event is required');
    expect(reviewPlan.approval_required).toBe(true);
    expect(reviewPlan.risk).toBe('write');
  });

  it('redacts sensitive inputs in plans and receipts', () => {
    const plan = planServiceOperation('github', 'create_issue', {
      owner: 'famaoai',
      repo: 'kyberion',
      title: 'safe title',
      access_token: 'do-not-persist',
    });
    const receipt = createServiceExecutionReceipt(plan, {
      id: 42,
      html_url: 'https://example.test/issues/42',
    });

    expect(plan.inputs).toMatchObject({
      title: 'safe title',
      access_token: '[REDACTED]',
    });
    expect(receipt.kind).toBe('service-execution-receipt.v1');
    expect(receipt.result_summary).toEqual({ type: 'object', keys: ['id', 'html_url'] });
    expect(JSON.stringify(receipt)).not.toContain('do-not-persist');
  });

  it('verifies a configured postcondition without exposing the result', () => {
    const descriptor = describeServiceHarness('github');
    const operation = descriptor.operations.find(
      (candidate) => candidate.action === 'create_issue'
    );
    expect(operation).toBeDefined();

    expect(verifyServiceOperationResult(operation!, { id: 42 })).toMatchObject({
      status: 'passed',
      kind: 'result_present',
    });
    expect(verifyServiceOperationResult(operation!, null).status).toBe('failed');
  });

  it('persists service receipts only through the governed runtime directory', () => {
    const plan = planServiceOperation('github', 'list_repos');
    const receipt = createServiceExecutionReceipt(plan, { ok: true });
    const persisted = persistServiceExecutionReceipt(receipt);
    expect(persisted.receipt_path).toContain('active/shared/runtime/service-receipts');
  });
});
