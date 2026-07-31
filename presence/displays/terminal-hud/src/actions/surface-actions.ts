import { hudExec, distScript } from './exec.js';
import { auditAction, type ActionResult } from './dispatch.js';

export type SurfaceActionKind = 'start' | 'stop' | 'repair';

/**
 * Surfaces are driven through scripts/surface_runtime.ts with the same env
 * contract as the pnpm surfaces:* scripts (stopSurfaceById is not exported).
 */
export function runSurfaceAction(kind: SurfaceActionKind, surfaceId: string): ActionResult {
  const result = hudExec(
    'node',
    [distScript('surface_runtime.js'), '--action', kind, '--surface', surfaceId],
    {
      env: { KYBERION_PERSONA: 'worker', SYSTEM_ROLE: 'surface_runtime' },
      timeoutMs: 120000,
    }
  );
  const lastLine =
    result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? '';
  return auditAction(`surface.${kind}`, { ok: result.ok, message: lastLine }, { surfaceId });
}
