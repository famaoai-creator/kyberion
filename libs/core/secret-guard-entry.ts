// Public subpath bootstrap: direct consumers get the governed approval
// handler while the low-level secret-guard module stays dependency-light.
import './risky-op-registry.js';

export * from './secret-guard.js';
