import { safeReadFile, safeExistsSync } from '../secure-io.js';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviewStep {
  index: number;
  id?: string;
  type: string;
  op: string;
  description: string;        // human-readable description of what this step does
  resolvedParams: Record<string, any>;  // params with variables resolved where possible
  warnings: string[];         // e.g. "ref path does not exist", "unresolved variable {{x}}"
  children?: PreviewStep[];   // for ref sub-pipelines
}

export interface PipelinePreview {
  valid: boolean;
  totalSteps: number;         // including sub-pipeline steps
  warnings: string[];
  errors: string[];
  steps: PreviewStep[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preview a pipeline without executing it.
 * Validates structure, resolves refs, checks variable availability.
 */
export function previewPipeline(
  pipelineJson: any,
  availableContext?: Record<string, any>
): PipelinePreview {
  const preview: PipelinePreview = {
    valid: true,
    totalSteps: 0,
    warnings: [],
    errors: [],
    steps: [],
  };

  if (!pipelineJson?.steps || !Array.isArray(pipelineJson.steps)) {
    preview.valid = false;
    preview.errors.push('Pipeline has no steps array');
    return preview;
  }

  const ctx: Record<string, any> = { ...pipelineJson.context, ...availableContext };

  for (const [i, step] of pipelineJson.steps.entries()) {
    const ps = previewStep(step, i, ctx);
    preview.steps.push(ps);
    preview.totalSteps += 1 + countChildren(ps);
    preview.warnings.push(...ps.warnings);
  }

  return preview;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function countChildren(ps: PreviewStep): number {
  if (!ps.children) return 0;
  let total = ps.children.length;
  for (const child of ps.children) {
    total += countChildren(child);
  }
  return total;
}

function previewStep(step: any, index: number, ctx: Record<string, any>): PreviewStep {
  const ps: PreviewStep = {
    index,
    id: step.id,
    type: step.type || 'unknown',
    op: step.op || 'unknown',
    description: describeStep(step),
    resolvedParams: {},
    warnings: [],
  };

  // Check for unresolved template variables
  const paramStr = JSON.stringify(step.params || {});
  const unresolvedVars = paramStr.match(/\{\{([^}]+)\}\}/g) || [];
  for (const v of unresolvedVars) {
    const varName = v.replace(/[{}]/g, '').trim().split('.')[0];
    if (!(varName in ctx)) {
      ps.warnings.push(`Unresolved variable: ${v}`);
    }
  }

  // Resolve what we can
  try {
    ps.resolvedParams = JSON.parse(
      paramStr.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
        const parts = key.trim().split('.');
        let val: any = ctx;
        for (const p of parts) val = val?.[p];
        return val !== undefined ? String(val) : `{{${key}}}`;
      })
    );
  } catch {
    ps.resolvedParams = step.params || {};
  }

  // Check ref paths
  if (step.op === 'ref' && step.params?.path) {
    const refPathRaw = String(step.params.path).replace(/\{\{[^}]+\}\}/g, '_');
    const refPath = path.resolve(process.cwd(), refPathRaw);
    try {
      const content = safeReadFile(refPath, { encoding: 'utf8' }) as string;
      const subPipeline = JSON.parse(content);
      if (subPipeline.steps) {
        ps.children = subPipeline.steps.map((s: any, j: number) =>
          previewStep(s, j, { ...ctx, ...step.params?.bind })
        );
        ps.description += ` (${ps.children.length} sub-steps)`;
      }
    } catch {
      ps.warnings.push(`ref path not readable: ${step.params.path}`);
    }
  }

  // Check on_error
  if (step.on_error) {
    if (step.on_error.ref) {
      const errRefPath = path.resolve(process.cwd(), step.on_error.ref);
      if (!safeExistsSync(errRefPath)) {
        ps.warnings.push(`on_error ref path not found: ${step.on_error.ref}`);
      }
    }
  }

  // Control flow children: while
  if (step.op === 'while' && step.params?.pipeline) {
    ps.children = step.params.pipeline.map((s: any, j: number) =>
      previewStep(s, j, ctx)
    );
    ps.description += ` (loop body: ${ps.children.length} steps, max ${step.params.max_iterations || '\u221e'} iterations)`;
  }

  // Control flow children: if
  if (step.op === 'if' && step.params?.then) {
    const thenChildren = step.params.then.map((s: any, j: number) =>
      previewStep(s, j, ctx)
    );
    const elseChildren = Array.isArray(step.params?.else)
      ? step.params.else.map((s: any, j: number) => previewStep(s, j, ctx))
      : [];
    ps.children = [...thenChildren, ...elseChildren];
    ps.description += ` (then: ${thenChildren.length} steps${elseChildren.length ? `, else: ${elseChildren.length} steps` : ''})`;
  }

  return ps;
}

function describeStep(step: any): string {
  const op = step.op || '?';
  const type = step.type || '?';
  switch (op) {
    case 'goto':
      return `Navigate to ${step.params?.url || '?'}`;
    case 'click':
      return `Click ${step.params?.selector || '?'}`;
    case 'fill':
      return `Fill ${step.params?.selector || '?'}`;
    case 'evaluate':
      return `Execute JavaScript`;
    case 'screenshot':
      return `Take screenshot \u2192 ${step.params?.path || '?'}`;
    case 'wait':
      return step.params?.duration
        ? `Wait ${step.params.duration}ms`
        : `Wait for ${step.params?.selector || '?'}`;
    case 'log':
      return `Log: ${step.params?.message || '?'}`;
    case 'ref':
      return `Execute sub-pipeline: ${step.params?.path || '?'}`;
    case 'if':
      return `Condition: ${step.params?.condition?.from || '?'} ${step.params?.condition?.operator || '?'} ${step.params?.condition?.value || '?'}`;
    case 'while':
      return `Loop while ${step.params?.condition?.from || '?'} ${step.params?.condition?.operator || '?'} ${step.params?.condition?.value || '?'}`;
    case 'pptx_extract':
      return `Extract PPTX design from ${step.params?.path || '?'}`;
    case 'xlsx_extract':
      return `Extract XLSX design from ${step.params?.path || '?'}`;
    case 'pptx_render':
      return `Render PPTX to ${step.params?.path || '?'}`;
    case 'xlsx_render':
      return `Render XLSX to ${step.params?.path || '?'}`;
    case 'pptx_patch':
      return `Patch PPTX text in ${step.params?.source || '?'} \u2192 ${step.params?.path || '?'}`;
    default:
      return `${type}:${op}`;
  }
}
