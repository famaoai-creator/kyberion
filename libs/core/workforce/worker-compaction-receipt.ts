import { z } from 'zod';
import {
  assertScopeContext,
  normalizeScopeContext,
  type ScopeContext,
} from '../scope-context-validation.js';
export const MAX_COMPACTION_RETENTION_MS = 30 * 86_400_000;
export const DEFAULT_COMPACTION_RETENTION_MS = 7 * 86_400_000;
export const compactionSnapshotReceiptSchema = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().optional(),
    generation: z.number().int().positive(),
    scopeKey: z.string().min(1),
    artifactPath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().positive(),
  })
  .strict()
  .refine(
    (r) => r.expiresAt > r.createdAt && r.expiresAt - r.createdAt <= MAX_COMPACTION_RETENTION_MS
  );
export type CompactionSnapshotReceipt = z.infer<typeof compactionSnapshotReceiptSchema>;

export function compactionScopeKey(input: ScopeContext): string {
  const scope = normalizeScopeContext(input);
  assertScopeContext(scope);
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}
