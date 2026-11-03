import { clamp } from '@agent/core/foundation';

export function normalizeCollaborationLimit(value: string | null): number {
  const raw = Number(value || 100);
  return Number.isFinite(raw) ? clamp(Math.floor(raw), 1, 500) : 100;
}
