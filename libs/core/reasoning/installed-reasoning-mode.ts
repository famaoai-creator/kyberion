/**
 * The reasoning mode installed in this process, readable without loading the
 * reasoning bootstrap (which pulls in every provider bundle at import time).
 * `reasoning-bootstrap.ts` registers its reader when it loads; a process that
 * never loaded it has installed nothing, so the reader answers null.
 */
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

let reader: () => ReasoningBackendMode | null = () => null;

export function registerInstalledReasoningModeReader(
  next: () => ReasoningBackendMode | null
): void {
  reader = next;
}

export function readInstalledReasoningMode(): ReasoningBackendMode | null {
  return reader();
}
