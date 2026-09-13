/**
 * scripts/lib/decided-by-args.ts
 *
 * FD-10 wave 1b (front-desk redesign plan §2.5 principle 4: decisions are
 * human-only, `decided_by`): CLI grammar for the `--decided-by` /
 * `--decided-by-name` / `--decided-by-role` flags accepted by
 * mission_controller's human decision verbs (`start`, `cancel`, `pause`,
 * `memory-approve`, `memory-reject`).
 *
 * `--decided-by` only ever names a human member (`user:<member-id>`) — never
 * an agent or service id. `libs/core/actor.ts` (FD-10a, a concurrently
 * developed sibling module) will eventually supply a shared actor type; this
 * module defines its own minimal, structurally-identical shape
 * (`HumanDecidedBy` from `@agent/core/mission-types`) so it does not depend
 * on that in-flight work.
 */
import { getOptionValue } from '../refactor/mission-cli-args.js';
import type { HumanDecidedBy, HumanDecidedByRole } from '@agent/core/mission-types';

export const DECIDED_BY_ID_PATTERN = /^user:[a-z][a-z0-9-]{1,30}$/;
export const DECIDED_BY_ROLES: readonly HumanDecidedByRole[] = ['owner', 'approver', 'viewer'];

export const DECIDED_BY_USAGE =
  '[--decided-by user:<member-id>] [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]';

/**
 * Resolves `--decided-by` (+ optional `--decided-by-name` / `--decided-by-role`)
 * from argv. Returns `undefined` when `--decided-by` is absent — the flags
 * are additive, and every caller must keep working without them (legacy /
 * non-human-decision invocations, e.g. automated dispatch, never pass one).
 *
 * Throws a plain `Error` (matching this router's existing grammar-validation
 * convention, e.g. `parseAllowedValue`) when `--decided-by` is present but
 * malformed.
 */
export function resolveDecidedByFromArgv(argv: string[]): HumanDecidedBy | undefined {
  const rawId = getOptionValue('--decided-by', argv);
  if (rawId === undefined) return undefined;
  if (!DECIDED_BY_ID_PATTERN.test(rawId)) {
    throw new Error(
      `--decided-by must match ${DECIDED_BY_ID_PATTERN.source} — decisions are recorded for human members only.`
    );
  }
  const rawRole = getOptionValue('--decided-by-role', argv);
  if (rawRole !== undefined && !DECIDED_BY_ROLES.includes(rawRole as HumanDecidedByRole)) {
    throw new Error(`--decided-by-role must be one of: ${DECIDED_BY_ROLES.join(', ')}`);
  }
  const rawName = getOptionValue('--decided-by-name', argv);
  return {
    kind: 'human',
    id: rawId,
    ...(rawName !== undefined ? { display_name: rawName } : {}),
    ...(rawRole !== undefined ? { role: rawRole as HumanDecidedByRole } : {}),
  };
}
