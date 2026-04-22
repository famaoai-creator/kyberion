/**
 * ADF Repair Agent — Uses an autonomous sub-agent to fix schema or logical errors in ADF files.
 */

import { getReasoningBackend } from './reasoning-backend.js';
import { safeReadFile } from './secure-io.js';
import { logger } from './core.js';
import { validate } from './validate.js';

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
    logger.error(`[adf-repair] Failed to parse JSON at ${adfPath}: ${err.message}`);
    return attemptSubagentRepair(adfPath, schemaName, `JSON parse error: ${err.message}`);
  }

  // Basic schema validation
  const validation = validate(parsed, schemaName);
  if (validation.valid) {
    return { repaired: false };
  }

  logger.warn(`[adf-repair] ADF validation failed for ${adfPath} against schema ${schemaName}. Attempting sub-agent repair...`);
  const errorMsg = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
  return attemptSubagentRepair(adfPath, schemaName, errorMsg);
}

async function attemptSubagentRepair(
  adfPath: string,
  schemaName: string,
  errorDetail: string
): Promise<AdfRepairResult> {
  const backend = getReasoningBackend();
  const instruction = `
The ADF file at '${adfPath}' is invalid.
Error details: ${errorDetail}
Expected Schema: ${schemaName}.schema.json

Please investigate the file, compare it with the schema requirements, and FIX the file so it is valid.
Ensure all required fields are present and types are correct.
Do not change the intent of the file, only its structural/format errors.
`;

  try {
    const report = await backend.delegateTask(instruction, `ADF Repair Mission for ${adfPath}`);
    logger.success(`[adf-repair] Sub-agent repair completed for ${adfPath}.`);
    
    // Re-verify after repair
    const updatedContent = safeReadFile(adfPath, { encoding: 'utf8' }) as string;
    const updatedParsed = JSON.parse(updatedContent);
    const finalValidation = validate(updatedParsed, schemaName);

    if (finalValidation.valid) {
      return { repaired: true, report };
    } else {
      const finalErrors = finalValidation.errors.map(e => `${e.field}: ${e.message}`);
      return { 
        repaired: false, 
        errors: finalErrors,
        report: `Sub-agent attempted repair but file is still invalid: ${finalErrors.join('; ')}`
      };
    }
  } catch (err: any) {
    return { 
      repaired: false, 
      errors: [err.message], 
      report: `Sub-agent repair failed: ${err.message}` 
    };
  }
}
