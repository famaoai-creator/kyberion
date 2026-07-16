/**
 * Hermetic-test gate for shared (cross-mission) observability streams.
 *
 * Vitest workers used to append fixture events to the operator's real
 * `active/shared/observability/**` jsonl files — the same pattern the
 * provider-health registry and operator-notifications already guard against.
 * Shared streams resolve through this gate:
 *
 * - production: write to the real shared directory
 * - under vitest: skip the write entirely (hermetic default)
 * - under vitest with `KYBERION_TEST_OBSERVABILITY_DIR` set: redirect into
 *   that directory so suites that assert on stream contents stay hermetic
 *
 * Mission-local streams (files under the mission directory) are not gated —
 * suites create their own mission fixtures deliberately.
 */
export function resolveSharedObservabilityDir(realDir: string): string | null {
  const override = process.env.KYBERION_TEST_OBSERVABILITY_DIR;
  if (override && override.trim()) return override.trim();
  if (process.env.VITEST) return null;
  return realDir;
}
