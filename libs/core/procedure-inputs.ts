import { compileBrowserRecording } from './browser-recording-compiler.js';
import type { BrowserExtensionRecording } from './browser-extension-bridge.js';
import type { ProcedureEntry } from './procedure-types.js';

/** A user-supplied input a procedure needs at execution time (Pattern B). */
export interface ProcedureInputField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'table' | 'date';
  optional: boolean;
}

/**
 * Determine which user inputs a procedure needs at run time: the distinct
 * `user_input` fill variables across its compiled steps, enriched with any
 * declared `required_inputs` metadata (label/type/optional). `secret_ref`
 * variables are intentionally excluded — secrets are never collected from the
 * operator here.
 */
export function collectProcedureUserInputs(
  entry: ProcedureEntry,
  recording: BrowserExtensionRecording,
): ProcedureInputField[] {
  const compiled = compileBrowserRecording(recording, {
    procedureId: entry.procedure_id,
    intentPhrases: entry.intent_phrases,
  });
  const names = [
    ...new Set(
      compiled.compiledSteps
        .filter((s) => s.variable?.classification === 'user_input')
        .map((s) => s.variable!.name),
    ),
  ];
  const declared = new Map((entry.required_inputs ?? []).map((i) => [i.name, i]));
  return names.map((name) => {
    const d = declared.get(name);
    return {
      name,
      label: d?.label ?? name,
      type: d?.type ?? 'string',
      optional: d?.optional ?? false,
    };
  });
}
