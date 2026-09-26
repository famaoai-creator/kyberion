import {
  resolveMarkTarget,
  type MarkTargetResolution,
  type ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';

/**
 * Screen coordinates for system clicks addressed by a Set-of-Marks target.
 * An explicit coordinate always wins; `target_mark` (`mark:<n>` from vision
 * mark_elements) is resolved only when no coordinate is given, into logical
 * points (the marks' display scale is applied by the resolver).
 */

export interface SystemMarkTargetInput {
  coordinate?: { x: number; y: number };
  x?: unknown;
  y?: unknown;
  target_mark?: unknown;
  mark_session_id?: unknown;
  marks_id?: unknown;
}

export type MarkResolver = (
  target: string,
  options: ResolveMarkTargetOptions
) => Promise<MarkTargetResolution>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function explicitCoordinate(input: SystemMarkTargetInput): { x: number; y: number } | undefined {
  if (input.coordinate) return input.coordinate;
  const given = (value: unknown) => value !== undefined && value !== null;
  if (!given(input.x) && !given(input.y)) return undefined;
  return { x: Number(input.x || 0), y: Number(input.y || 0) };
}

export async function resolveSystemClickCoordinate(
  input: SystemMarkTargetInput,
  fallbackSessionId: string | undefined,
  resolver: MarkResolver = resolveMarkTarget
): Promise<{ x: number; y: number } | undefined> {
  const explicit = explicitCoordinate(input);
  if (explicit) return explicit;
  const targetMark = optionalString(input.target_mark);
  if (!targetMark) return undefined;
  const marksId = optionalString(input.marks_id);
  const resolved = await resolver(targetMark, {
    session_id: optionalString(input.mark_session_id) ?? fallbackSessionId ?? '',
    ...(marksId ? { marks_id: marksId } : {}),
  });
  return { x: resolved.x, y: resolved.y };
}
