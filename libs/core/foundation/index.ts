export * from './ajv.js';
export * from './env.js';
export * from './governed-catalog.js';
// The bridge *registration* seam is public: a consumer that stands in for
// secure-io (a test fixture root) must be able to install the governed
// implementation through the barrel instead of reaching into
// `foundation/io.js`. The `getFoundationIo()` accessor stays package-internal
// so no caller outside the foundation can read I/O around secure-io.
export { registerFoundationIo, type FoundationIo } from './io.js';
export * from './json.js';
export * from './process-env.js';
export * from './text.js';
export * from './time.js';
