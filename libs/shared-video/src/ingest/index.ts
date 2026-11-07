// Public subpath bootstrap: direct consumers (vision-actuator) get the governed
// approval handler, so the remote-fetch approval gate is never "not registered".
import '@agent/core/risky-op-registry';

export * from './video-ingest-types.js';
export * from './vtt-parser.js';
export * from './video-fetch.js';
export * from './video-media.js';
export * from './video-brief.js';
