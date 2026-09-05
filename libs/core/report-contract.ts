/**
 * TK-07 report phase contracts.
 *
 * A report is produced after perform and validated before it is exposed to a
 * downstream step. Schema references are either a registered structured
 * contract (for example `task_result`) or a relative JSON schema under
 * `knowledge/product/schemas/`.
 */

import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { parseStructuredJson } from './structured-reasoning.js';
import {
  renderStructuredOutputSchemaPrompt,
  resolveStructuredOutputSchema,
  type StructuredOutputSchemaRef,
} from './structured-output-contracts.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { compileSchema } from './foundation/ajv.js';
import type { ReasoningBackend } from './reasoning-backend.js';

export interface PipelineReportContract {
  schema_ref: string;
  use_judge?: boolean;
  order?: number;
  export_as?: string;
}

interface CompiledReportSchema {
  validate: (value: unknown) => boolean;
  errors: () => string[];
  prompt: string;
}

const BUILTIN_SCHEMA_NAMES = new Set([
  'planning_packet',
  'task_result',
  'planning_review_verdict',
  'a2a_task_contract',
  'procedure_ranking',
]);

function schemaPathFromRef(schemaRef: string): string {
  const normalized = schemaRef.replace(/^schemas\//, '').trim();
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('..')) {
    throw new Error(
      `[REPORT_SCHEMA_INVALID] schema_ref must be a product schema or registered contract: ${schemaRef}`
    );
  }
  const root = pathResolver.knowledge('product/schemas');
  const candidate = path.resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `[REPORT_SCHEMA_INVALID] schema_ref escapes the product schema root: ${schemaRef}`
    );
  }
  if (!candidate.endsWith('.json')) {
    throw new Error(`[REPORT_SCHEMA_NOT_FOUND] report schema not found: ${schemaRef}`);
  }
  const safeCandidate = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
  if (!safeExistsSync(safeCandidate)) {
    throw new Error(`[REPORT_SCHEMA_NOT_FOUND] report schema not found: ${schemaRef}`);
  }
  if (!safeLstat(safeCandidate).isFile()) {
    throw new Error(`[REPORT_SCHEMA_INVALID] report schema must be a regular file: ${schemaRef}`);
  }
  return safeCandidate;
}

function compileReportSchema(schemaRef: string): CompiledReportSchema {
  if (BUILTIN_SCHEMA_NAMES.has(schemaRef)) {
    const schema = resolveStructuredOutputSchema(schemaRef as StructuredOutputSchemaRef);
    const json = renderStructuredOutputSchemaPrompt(schemaRef as StructuredOutputSchemaRef);
    return {
      validate: (value) => schema.safeParse(value).success,
      errors: () => ['structured output did not satisfy the registered contract'],
      prompt: json,
    };
  }

  const schemaPath = schemaPathFromRef(schemaRef);
  const validate: ValidateFunction = compileSchema(schemaPath);
  return {
    validate: (value) => Boolean(validate(value)),
    errors: () =>
      (validate.errors || []).map(
        (error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`
      ),
    prompt: String(safeReadFile(schemaPath, { encoding: 'utf8' })),
  };
}

export async function executeReportContract(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  contract: PipelineReportContract,
  instruction: string
): Promise<unknown> {
  const compiled = compileReportSchema(contract.schema_ref);
  let lastError = 'unknown report validation failure';
  const maxAttempts = contract.use_judge ? 3 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await backend.delegateTask(
      [
        'Produce only JSON. Do not use markdown fences or explanatory prose.',
        `Report schema (${contract.schema_ref}):`,
        compiled.prompt,
        attempt > 0 ? `Previous report validation failure: ${lastError}` : '',
        'Report task:',
        instruction,
      ]
        .filter(Boolean)
        .join('\n'),
      undefined
    );
    try {
      const parsed = parseStructuredJson(raw, 'pipeline-report');
      if (compiled.validate(parsed)) return parsed;
      lastError = compiled.errors().join('; ') || lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`[REPORT_SCHEMA_INVALID] ${contract.schema_ref}: ${lastError}`);
}
