import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { previewPipeline } from './src/pipeline-preview.js';
import { buildProductivityTaskPlan } from './productivity-task-plan.js';

const Ajv = AjvModule;

describe('productivity-task-plan', () => {
  it('builds a multi-domain dry-run plan without external effects', () => {
    const plan = buildProductivityTaskPlan(
      '連携システムから情報収集して会議資料をPPTXで作り、メールの下書きを用意して'
    );

    expect(plan.domains).toEqual(
      expect.arrayContaining(['meeting', 'email', 'document', 'presentation', 'connected_systems'])
    );
    expect(plan.execution).toEqual({ mode: 'dry_run', external_effects_executed: false });
    expect(plan.steps.every((step) => step.execution_mode === 'preview_only')).toBe(true);
    expect(plan.steps.find((step) => step.domain === 'email')?.effect).toBe('draft');
  });

  it('blocks browser payment behind approval and requires payment inputs', () => {
    const plan = buildProductivityTaskPlan('ブラウザで商品を購入して決済を確定して');
    const browserStep = plan.steps.find((step) => step.domain === 'browser');

    expect(browserStep?.effect).toBe('financial_commit');
    expect(browserStep?.approval_required).toBe(true);
    expect(plan.approval.required).toBe(true);
    expect(plan.missing_inputs).toEqual(
      expect.arrayContaining(['approval_confirmation', 'merchant', 'total_amount', 'payment_limit'])
    );
  });

  it('keeps read-only calendar checks approval-free', () => {
    const plan = buildProductivityTaskPlan('明日のカレンダーの空き時間を確認して');

    expect(plan.steps.find((step) => step.domain === 'calendar')?.effect).toBe('read');
    expect(plan.approval.required).toBe(false);
  });

  it('conforms to the productivity task plan schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/productivity-task-plan.schema.json')
    );
    const plan = buildProductivityTaskPlan('会議の日程を変更して参加者にメールを送って');
    const example = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/schemas/productivity-task-plan.example.json'), {
        encoding: 'utf8',
      }) as string
    );

    expect(validate(plan), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate(example), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('provides a valid dry-run pipeline with no external actuator steps', () => {
    const pipeline = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('product/pipeline-templates/productivity-task-orchestration.json'),
        { encoding: 'utf8' }
      ) as string
    );
    const preview = previewPipeline(pipeline);
    const ops = pipeline.steps.map((step: { op: string }) => step.op);

    expect(preview.valid).toBe(true);
    expect(preview.totalSteps).toBe(5);
    expect(ops).not.toEqual(
      expect.arrayContaining([
        'calendar:create_event',
        'meeting:join',
        'email:send',
        'browser:pipeline',
        'service:preset',
        'network:fetch',
      ])
    );
  });
});
