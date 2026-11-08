import { withExecutionContext } from '../authority.js';
import {
  hearingNamespace,
  loadHearingRecord,
  loadHearingCanvasVersion,
  updateHearingRecord,
  decideHearingRecord,
  reserveHearingHandoff,
  finishHearingHandoff,
  saveHearingCanvasVersion,
  assertHearingEditable,
  assertHearingSnapshot,
  HearingConflictError,
} from './hearing-runtime.js';
import { hearingRevision, hearingRequirementsKey, type HearingRecord } from './hearing.js';
import type { HearingOwnerInput } from './hearing-scope.js';
import {
  SurfaceViewerScopeError,
  type SurfaceViewerScope,
} from './surface-viewer-scope-contract.js';

/** The viewer facts hearing storage decides on. Surfaces pass their server-resolved viewer. */
export type HearingStorageViewer = Pick<SurfaceViewerScope, 'tenantSlugs'>;

export interface HearingStorageOptions extends HearingOwnerInput {
  /** Builds the surface's own 403 refusal (default: `SurfaceViewerScopeError`). */
  denied?: (message: string) => Error;
}

/** Internal facade: callers MUST pass the server-resolved viewer, never request body scope.
 * Capture immutable scope facts; elevation encloses only synchronous storage/lock calls,
 * never HTTP handling, async canvas generation, model work or downstream effects.
 * Generic runtime helpers deliberately remain non-elevating.
 * Used by: Studio (hearing routes), Concierge (hearing routes).
 * Owner: `options.owner` is the surface's own decision that this request comes
 * from the owner of this machine (see {@link HearingOwnerInput}). Only the owner
 * reads the personal (no single tenant) store, and every write requires it.
 * The viewer's credential `source` is never consulted here.
 */
export function hearingStorageForScope(
  viewer: HearingStorageViewer,
  options: HearingStorageOptions
) {
  const denied = options.denied ?? ((message: string) => new SurfaceViewerScopeError(403, message));
  const namespace = hearingNamespace(viewer.tenantSlugs);
  const owner = options.owner === true;
  const shared = namespace === 'all' || namespace === 'unscoped';
  if (!owner && shared) throw denied('Personal hearing storage requires a local owner session.');
  const tenant = shared ? undefined : namespace;
  const read = <T>(fn: () => T): T =>
    withExecutionContext('ecosystem_architect', fn, undefined, tenant);
  const write = <T>(fn: () => T): T => {
    if (!owner) throw denied('Hearing writes require a local owner session.');
    return read(fn);
  };
  const text = (value: string): string => {
    if (typeof value !== 'string') throw new Error('[HEARING_INPUT_INVALID] string required');
    return value;
  };
  return Object.freeze({
    namespace,
    load: (sessionId: string) => {
      const id = text(sessionId);
      return read(() => loadHearingRecord(namespace, id));
    },
    canvas: (sessionId: string, version: string) => {
      const id = text(sessionId);
      const revision = text(version);
      return read(() => loadHearingCanvasVersion(namespace, id, revision));
    },
    commitTurn: (
      sessionId: string,
      expected: HearingRecord | null,
      next: HearingRecord,
      html: string,
      generation: 'template' | 'pending' | 'projected'
    ) => {
      const input = structuredClone({ sessionId, expected, next, html, generation });
      if (
        typeof input.sessionId !== 'string' ||
        typeof input.html !== 'string' ||
        !['template', 'pending', 'projected'].includes(input.generation) ||
        input.next.session_id !== input.sessionId ||
        (input.expected && input.expected.session_id !== input.sessionId)
      )
        throw new Error('[HEARING_UPDATE_INVALID] invalid turn');
      return write(() =>
        updateHearingRecord(
          namespace,
          input.sessionId,
          (current) => {
            assertHearingEditable(current);
            assertHearingSnapshot(current, input.expected);
            const version = saveHearingCanvasVersion(namespace, input.next, input.html);
            return {
              ...input.next,
              canvas_versions: [...input.next.canvas_versions, version],
              canvas_generation: input.generation,
              canvas_version_sources: {
                ...input.next.canvas_version_sources,
                [version]: input.generation === 'projected' ? 'projected' : 'template',
              },
            };
          },
          { allowLegacyMigration: true }
        )
      );
    },
    commitGeneratedCanvas: (
      expected: HearingRecord,
      html: string,
      source: 'generated' | 'template'
    ) => {
      const input = structuredClone({ expected, html, source });
      if (typeof input.html !== 'string' || !['generated', 'template'].includes(input.source))
        throw new Error('[HEARING_UPDATE_INVALID] invalid canvas');
      return write(() =>
        updateHearingRecord(namespace, input.expected.session_id, (current) => {
          if (
            !current ||
            hearingRevision(current.requirements_revision) !==
              hearingRevision(input.expected.requirements_revision) ||
            hearingRequirementsKey(current) !== hearingRequirementsKey(input.expected)
          )
            throw new HearingConflictError('stale_snapshot');
          assertHearingEditable(current);
          if (input.source === 'template') return { ...current, canvas_generation: 'template' };
          const version = saveHearingCanvasVersion(namespace, current, input.html);
          return {
            ...current,
            canvas_versions: [...current.canvas_versions, version],
            canvas_generation: 'generated',
            canvas_version_sources: { ...current.canvas_version_sources, [version]: 'generated' },
          };
        })
      );
    },
    decide: (
      sessionId: string,
      ...args: Parameters<typeof decideHearingRecord> extends [string, string, ...infer Rest]
        ? Rest
        : never
    ) => {
      const input = structuredClone([sessionId, ...args] as const);
      return write(() => decideHearingRecord(namespace, ...input));
    },
    reserve: (
      ...args: Parameters<typeof reserveHearingHandoff> extends [string, ...infer Rest]
        ? Rest
        : never
    ) => {
      const input = structuredClone(args);
      return write(() => reserveHearingHandoff(namespace, ...input));
    },
    finish: (
      ...args: Parameters<typeof finishHearingHandoff> extends [string, ...infer Rest]
        ? Rest
        : never
    ) => {
      const input = structuredClone(args);
      return write(() => finishHearingHandoff(namespace, ...input));
    },
  });
}
export type HearingStorage = ReturnType<typeof hearingStorageForScope>;

/** Exact receipt scope is server-derived, including narrower organization/project selection.
 * The key includes the surface's own `tierAccess`, so a receipt written on one
 * surface (Studio's loopback viewer carries `personal`, Concierge masks it) does
 * not replay on another: it fails closed as a conflict, never as a false proof.
 * Used by: Studio, Concierge. */
export function hearingDecisionScopeKey(
  scope: Pick<SurfaceViewerScope, 'tenantSlugs' | 'organizationIds' | 'projectIds' | 'tierAccess'>
): string {
  const canonical = (value: string[] | 'all') =>
    value === 'all' ? value : [...new Set(value)].sort();
  return JSON.stringify([
    hearingNamespace(scope.tenantSlugs),
    canonical(scope.organizationIds),
    canonical(scope.projectIds),
    canonical(scope.tierAccess),
  ]);
}
