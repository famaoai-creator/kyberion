import {
  getAllFiles,
  pathResolver,
  resolvePipelineInputPlaceholders,
  safeReadFile,
} from '@agent/core';
import * as addFormatsModule from 'ajv-formats';
import { createAjv } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

type JsonSchema = Record<string, unknown>;

export interface PipelineSchemaDiscovery {
  actuators?: Array<{
    n?: string;
    ops?: Array<{ op?: string; input_schema?: JsonSchema }>;
  }>;
}

export interface PipelineDocument {
  path: string;
  value: unknown;
}

export interface PipelineSchemaViolation {
  path: string;
  op: string;
  errors: string[];
}

export interface PipelineSchemaScanReport {
  steps: number;
  checked: number;
  violations: PipelineSchemaViolation[];
}

function collectSteps(value: unknown, visit: (step: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSteps(entry, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.op === 'string' &&
    record.params &&
    typeof record.params === 'object' &&
    !Array.isArray(record.params)
  ) {
    visit(record);
  }
  Object.values(record).forEach((entry) => collectSteps(entry, visit));
}

export function scanPipelineOpSchemas(
  discovery: PipelineSchemaDiscovery,
  pipelines: PipelineDocument[]
): PipelineSchemaScanReport {
  const ajv = createAjv();
  addFormats(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const actuator of discovery.actuators || []) {
    const domain = String(actuator.n || '').replace(/-actuator$/, '');
    for (const entry of actuator.ops || []) {
      const schema = entry.input_schema;
      if (
        !schema ||
        schema['x-kyberion-contract'] === 'inferred-legacy' ||
        schema['x-kyberion-contract'] === 'legacy-open'
      ) {
        continue;
      }
      validators.set(`${domain}:${String(entry.op || '')}`, ajv.compile(schema));
    }
  }

  const violations: PipelineSchemaViolation[] = [];
  let steps = 0;
  let checked = 0;
  for (const pipeline of pipelines) {
    collectSteps(pipeline.value, (step) => {
      steps += 1;
      const op = String(step.op);
      const normalizedOp = op.includes(':') ? op : `system:${op}`;
      const validate = validators.get(normalizedOp);
      if (!validate) return;
      checked += 1;
      const params = resolvePipelineInputPlaceholders(step.params, validate.schema as JsonSchema);
      if (!validate(params)) {
        violations.push({
          path: pipeline.path,
          op: normalizedOp,
          errors: (validate.errors || []).map(
            (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
          ),
        });
      }
    });
  }
  return { steps, checked, violations };
}

function readDiscovery(): PipelineSchemaDiscovery {
  return JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/orchestration/actuator-op-discovery.json'), {
        encoding: 'utf8',
      }) || '{}'
    )
  ) as PipelineSchemaDiscovery;
}

function readPipelines(): PipelineDocument[] {
  const roots = ['pipelines', 'knowledge/product/pipeline-templates'];
  const files = roots.flatMap((root) => {
    const absolute = pathResolver.rootResolve(root);
    return getAllFiles(absolute).filter((file) => file.endsWith('.json'));
  });
  return [...new Set(files)].sort().map((file) => ({
    path: file.replace(`${pathResolver.rootDir()}/`, ''),
    value: JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }) || '{}')),
  }));
}

export function findPipelineOpSchemaViolations(): PipelineSchemaScanReport {
  return scanPipelineOpSchemas(readDiscovery(), readPipelines());
}

export const runCheckPipelineOpSchemaCoverage = defineScript({
  name: 'check:pipeline-op-schemas',
  flags: [],
  run(context) {
    const report = findPipelineOpSchemaViolations();
    if (report.violations.length > 0) {
      console.error(
        `[check:pipeline-op-schemas] FAILED (${report.violations.length} violation(s), ${report.checked} schema-bound steps checked)`
      );
      for (const violation of report.violations) {
        console.error(`- ${violation.path} ${violation.op}: ${violation.errors.join('; ')}`);
      }
      throw new Error(`${report.violations.length} pipeline op schema violation(s)`);
    }
    context.print(
      `[check:pipeline-op-schemas] OK (${report.checked} schema-bound steps checked across ${report.steps} steps)`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'check_pipeline_op_schema_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_pipeline_op_schema_coverage.js')
)
  void runCheckPipelineOpSchemaCoverage();
