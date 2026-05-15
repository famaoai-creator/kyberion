/**
 * ADF Repair Agent — Uses an autonomous sub-agent to fix schema or logical errors in ADF files.
 *
 * Repair cascade (cheapest first):
 *   1. Lightweight structural JSON repair (json-repair.ts) — no LLM, instant
 *   2. Targeted schema-aware repair hint — LLM sub-agent with full schema + classified error hints
 */

import { getReasoningBackend } from './reasoning-backend.js';
import { safeReadFile, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';
import { validate, loadSchema } from './validate.js';
import { tryRepairJson, repairJsonString } from './json-repair.js';
import {
  completeDelegatedTaskTrace,
  startDelegatedTaskTrace,
} from './delegated-task-observability.js';

export interface AdfRepairResult {
  repaired: boolean;
  errors?: string[];
  report?: string;
}

/**
 * Validates an ADF file against its schema and attempts autonomous repair if it fails.
 * @param adfPath Path to the ADF file.
 * @param schemaName Name of the schema (without extension).
 */
export async function validateAndRepairAdf(
  adfPath: string,
  schemaName: string
): Promise<AdfRepairResult> {
  const content = safeReadFile(adfPath, { encoding: 'utf8' }) as string;
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    // 1. Try lightweight structural repair before escalating to the LLM subagent
    const lightweight = tryRepairJson(content);
    if (lightweight !== null) {
      const repairedStr = repairJsonString(content)!;
      logger.info(`[adf-repair] Lightweight JSON repair succeeded for ${adfPath} — skipping subagent delegation`);
      safeWriteFile(adfPath, repairedStr, { encoding: 'utf8' });
      parsed = lightweight;
    } else {
      logger.error(`[adf-repair] Failed to parse JSON at ${adfPath}: ${err.message}`);
      return attemptSubagentRepair(adfPath, schemaName, `JSON parse error: ${err.message}`, []);
    }
  }

  // 2. Schema validation
  const validation = validate(parsed, schemaName);
  if (validation.valid) {
    return { repaired: false };
  }

  logger.warn(`[adf-repair] Schema validation failed for ${adfPath}. Errors: ${validation.errors.length}. Delegating to sub-agent...`);
  return attemptSubagentRepair(adfPath, schemaName, '', validation.errors.map(e => `${e.field}: ${e.message}`));
}

async function attemptSubagentRepair(
  adfPath: string,
  schemaName: string,
  parseError: string,
  validationErrors: string[]
): Promise<AdfRepairResult> {
  const backend = getReasoningBackend();
  const errorSummary = parseError || validationErrors.join('; ');

  const trace = startDelegatedTaskTrace({
    owner: 'adf-repair-agent',
    instruction: `Repair invalid ADF at ${adfPath} against ${schemaName}.schema.json`,
    context: errorSummary,
    contextRef: adfPath,
    backendName: backend.name,
  });

  // Load the actual schema so the LLM has ground truth, not just error messages
  let schemaContent = '(schema not available)';
  try {
    schemaContent = JSON.stringify(loadSchema(schemaName), null, 2);
  } catch { /* non-fatal — proceed without it */ }

  // Classify errors to generate targeted repair hints
  const hints = buildRepairHints(validationErrors, parseError);

  const instruction = `
The ADF file at '${adfPath}' is invalid and must be repaired.

## Errors
${parseError ? `JSON Parse Error: ${parseError}\n` : ''}${validationErrors.length > 0 ? validationErrors.map(e => `- ${e}`).join('\n') : ''}

## Repair Hints
${hints}

## Expected Schema (${schemaName}.schema.json)
\`\`\`json
${schemaContent}
\`\`\`

## Instructions
1. Read the current file at '${adfPath}'.
2. Fix ONLY the errors listed above. Do not change the intent of the file.
3. Ensure the result is valid JSON that satisfies the schema above.
4. Write the repaired content back to '${adfPath}'.

Output constraints: pure JSON, no markdown fences, no comments, no trailing commas.
`.trim();

  try {
    const report = await backend.delegateTask(instruction, `ADF Repair: ${adfPath}`);
    logger.success(`[adf-repair] Sub-agent repair completed for ${adfPath}.`);

    // Re-verify after repair
    const updatedContent = safeReadFile(adfPath, { encoding: 'utf8' }) as string;
    let updatedParsed: any;
    try {
      updatedParsed = JSON.parse(updatedContent);
    } catch {
      // Last-chance repair on what the sub-agent wrote
      const recovered = tryRepairJson(updatedContent);
      if (recovered !== null) {
        safeWriteFile(adfPath, repairJsonString(updatedContent)!, { encoding: 'utf8' });
        updatedParsed = recovered;
      } else {
        completeDelegatedTaskTrace(trace, { error: 'sub-agent output is still unparseable JSON' });
        return { repaired: false, errors: ['sub-agent output is still unparseable JSON'], report };
      }
    }

    const finalValidation = validate(updatedParsed, schemaName);
    if (finalValidation.valid) {
      completeDelegatedTaskTrace(trace, { resultSummary: report });
      return { repaired: true, report };
    }

    const finalErrors = finalValidation.errors.map(e => `${e.field}: ${e.message}`);
    completeDelegatedTaskTrace(trace, {
      resultSummary: `repair completed but validation still failed: ${finalErrors.join('; ')}`,
    });
    return {
      repaired: false,
      errors: finalErrors,
      report: `Sub-agent attempted repair but file is still invalid: ${finalErrors.join('; ')}`,
    };
  } catch (err: any) {
    completeDelegatedTaskTrace(trace, { error: err.message });
    return { repaired: false, errors: [err.message], report: `Sub-agent repair failed: ${err.message}` };
  }
}

/** Classify validation errors and generate targeted repair hints. */
function buildRepairHints(validationErrors: string[], parseError: string): string {
  if (parseError) {
    return [
      '- The file is not valid JSON. Common causes: trailing commas, single quotes, markdown code fences,',
      '  unquoted object keys, or a truncated/incomplete file.',
      '- Strip any surrounding prose or ``` fences. The file must contain only a JSON object or array.',
    ].join('\n');
  }

  const hints: string[] = [];
  const missing = validationErrors.filter(e => e.includes('Required field') && e.includes('missing'));
  const typeMismatch = validationErrors.filter(e => e.includes('Expected type'));
  const enumViolation = validationErrors.filter(e => e.includes('not in allowed values'));
  const anyOfFail = validationErrors.filter(e => e.includes('anyOf'));
  const other = validationErrors.filter(
    e => !missing.includes(e) && !typeMismatch.includes(e) && !enumViolation.includes(e) && !anyOfFail.includes(e)
  );

  if (missing.length > 0) {
    const fields = missing.map(e => e.replace('Required field "', '').replace('" is missing', '')).join(', ');
    hints.push(`- MISSING REQUIRED FIELDS: Add ${fields}. Check the schema for their expected types and structure.`);
  }
  if (typeMismatch.length > 0) {
    hints.push(`- TYPE MISMATCH: ${typeMismatch.map(e => e.split(': ')[1]).join('; ')}. Ensure values match the declared JSON type (string/number/boolean/array/object).`);
  }
  if (enumViolation.length > 0) {
    hints.push(`- ENUM VIOLATION: ${enumViolation.map(e => e.split(': ')[1]).join('; ')}. Replace with one of the allowed values listed in the error.`);
  }
  if (anyOfFail.length > 0) {
    hints.push(`- ALTERNATIVE REQUIRED FIELDS: The schema requires at least one of several field sets. Check the schema's anyOf block and supply one complete set.`);
  }
  if (other.length > 0) {
    hints.push(`- OTHER: ${other.join('; ')}`);
  }

  return hints.length > 0 ? hints.join('\n') : '- Review the schema carefully and fix all structural/type mismatches.';
}
