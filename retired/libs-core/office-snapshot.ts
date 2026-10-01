/**
 * CE-03 canonical office projection entrypoint.
 *
 * Keep this small module stable so the static `pnpm office` renderer and the
 * Chronos surface import the same state-to-room mapping rather than growing
 * parallel office models.
 */
export {
  composeOfficeSnapshot,
  type OfficeAgentState,
  type OfficeSnapshot,
} from './ce-adoption.js';
