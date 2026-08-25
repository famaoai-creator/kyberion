import { resolveVars } from '@agent/core';
import type { PipelineAdfStep } from '@agent/core/pipeline-contract';

function sourceValue(params: Record<string, unknown>, ctx: Record<string, unknown>): unknown {
  const source = typeof params.source === 'string' ? params.source : '';
  return source ? ctx[source] : resolveVars(params.input ?? ctx, ctx);
}

function exportValue(
  params: Record<string, unknown>,
  step: PipelineAdfStep,
  value: unknown,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const key =
    typeof params.export_as === 'string' && params.export_as
      ? params.export_as
      : typeof step.produces === 'string'
        ? step.produces
        : step.produces?.channel || 'last_transform';
  return { ...ctx, [key]: value };
}

function parseJsonPayload(raw: unknown, label: string): Record<string, unknown> {
  if (!raw) throw new Error(`${label} is missing from context`);
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const externalTag = ['untrusted', 'external'].join('-');
  const wrapped = text.match(
    new RegExp(`<${externalTag}[^>]*>\\s*([\\s\\S]*?)\\s*</${externalTag}>`, 'i')
  );
  const unwrapped = wrapped ? wrapped[1] : text;
  const fenced = unwrapped.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const parsed = JSON.parse((fenced ? fenced[1] : unwrapped).trim()) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must decode to an object`);
  }
  return parsed as Record<string, unknown>;
}

export function runInlineProposalBriefParse(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const parsed = parseJsonPayload(sourceValue(params, ctx), 'deck_brief_raw');
  return exportValue(
    params,
    step,
    {
      ...parsed,
      kind: 'proposal-brief',
      tenant_id: ctx.tenant_slug || parsed.tenant_slug,
    },
    ctx
  );
}

export function runInlineProductivityDryRunValidation(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const plan = parseJsonPayload(sourceValue(params, ctx), 'task_plan_raw');
  if (plan.kind !== 'productivity-task-plan') {
    throw new Error('invalid productivity task plan kind');
  }
  if (
    (plan.execution as Record<string, unknown> | undefined)?.mode !== 'dry_run' ||
    (plan.execution as Record<string, unknown> | undefined)?.external_effects_executed !== false
  ) {
    throw new Error('productivity task plan must be dry-run only');
  }
  if (
    !Array.isArray(plan.steps) ||
    plan.steps.some((item) => (item as Record<string, unknown>)?.execution_mode !== 'preview_only')
  ) {
    throw new Error('all productivity steps must remain preview_only');
  }
  const approval = plan.approval as Record<string, unknown> | undefined;
  return exportValue(
    params,
    step,
    {
      kind: 'productivity-review-package',
      mission_id: ctx.mission_id,
      status: approval?.required ? 'approval_required' : 'ready_for_local_draft',
      request: plan.request,
      domains: plan.domains,
      steps: plan.steps,
      approval: plan.approval,
      missing_inputs: plan.missing_inputs,
      evidence_plan: plan.evidence_plan,
      external_effects_executed: false,
    },
    ctx
  );
}
