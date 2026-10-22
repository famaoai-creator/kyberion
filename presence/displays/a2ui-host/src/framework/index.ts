/**
 * A2UI host framework — public surface.
 *
 * Layers (each importable on its own):
 *   protocol  → validate messages and components
 *   store     → apply messages, keep surfaces + history, resolve trees
 *   registry  → component type → renderer
 *   catalog   → the standard component set
 *   renderer  → surface → node tree through a DOM adapter
 *   actions   → action descriptors and their execution policy
 *   envelope  → find A2UI inside producer responses
 */
export * from './protocol.js';
export * from './store.js';
export * from './dom.js';
export * from './registry.js';
export * from './catalog.js';
export * from './renderer.js';
export * from './actions.js';
export * from './envelope.js';
