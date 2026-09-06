import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';

export function parseSurfaceActuatorResult(output: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(output, `${label} actuator result`);
  } catch {
    throw new Error(`[SURFACE_ACTUATOR_RESULT_INVALID] ${label} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`[SURFACE_ACTUATOR_RESULT_INVALID] ${label} returned a non-object result`);
  }
  return parsed;
}
