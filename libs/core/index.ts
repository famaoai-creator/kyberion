/**
 * @agent/core - Unified Entry Point
 * Public exports are split into bounded barrel parts to keep this entrypoint navigable.
 */

export * from './index-part-01.js';
export * from './index-part-02.js';
export * from './index-part-03.js';
export * from './index-part-04.js';
export * from './index-part-05.js';
export * from './index-part-06.js';
export * from './index-part-07.js';
export * from './index-part-08.js';
export * from './index-part-09.js';
export * from './index-part-10.js';
export * from './index-part-11.js';

// Preserve the original explicit export precedence for names also surfaced by
// broad compatibility barrels.
export type { NextActionType } from './next-action.js';
