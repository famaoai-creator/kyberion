import {
  isMarkTarget,
  resolveMarkTarget,
  type MarkTargetResolution,
  type ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';

/**
 * `click_ref` with a Set-of-Marks target (`mark:<n>` from vision
 * mark_elements). A DOM-backed mark becomes its `@eN` ref, so the normal ref
 * path (and its recorded-target safety checks) clicks it; any other mark is a
 * viewport coordinate in CSS pixels.
 */

export { isMarkTarget };

export type BrowserMarkTarget =
  | { kind: 'ref'; ref: string; mark: MarkTargetResolution }
  | { kind: 'point'; x: number; y: number; mark: MarkTargetResolution };

export type MarkResolver = (
  target: string,
  options: ResolveMarkTargetOptions
) => Promise<MarkTargetResolution>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function resolveBrowserMarkTarget(
  target: string,
  input: { params: Record<string, unknown>; sessionId: string },
  resolver: MarkResolver = resolveMarkTarget
): Promise<BrowserMarkTarget> {
  const { params } = input;
  const scale = typeof params.mark_scale === 'number' ? params.mark_scale : undefined;
  const marksId = optionalString(params.marks_id);
  const mark = await resolver(target, {
    session_id: optionalString(params.mark_session_id) ?? input.sessionId,
    ...(scale !== undefined ? { scale } : {}),
    ...(marksId ? { marks_id: marksId } : {}),
  });
  return mark.ref
    ? { kind: 'ref', ref: mark.ref, mark }
    : { kind: 'point', x: mark.x, y: mark.y, mark };
}
