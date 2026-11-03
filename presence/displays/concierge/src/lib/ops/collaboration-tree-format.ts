/**
 * AC-06: pure formatting helpers for the Chronos collaboration tree section.
 *
 * `formatElapsedDuration` is copied from the terminal-hud reference consumer
 * (`presence/displays/terminal-hud/src/store/agent-graph.ts`) rather than
 * imported — the two surfaces have no shared runtime package boundary and
 * the function is a handful of pure lines with no locale dependency, so a
 * small duplicate is cheaper than a cross-surface dependency.
 */

/** `12s` / `3m05s` / `1h02m` — pure, no locale dependency. */
export function formatElapsedDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

/** Strip the projection's `agent:` / `human:` / `mission:` / `task:` id prefix for a short label. */
export function shortNodeLabel(id: string): string {
  return id.replace(/^(mission|task|agent|human):/, '');
}
