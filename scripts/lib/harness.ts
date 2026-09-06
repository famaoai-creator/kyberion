/**
 * Keep the historical scripts-local import stable while making the harness
 * available to non-script entrypoints such as long-lived satellites.
 */
export * from '@agent/core/script-harness';
