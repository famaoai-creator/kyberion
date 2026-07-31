export const theme = {
  accent: 'cyan',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  dim: 'gray',
} as const;

const STATUS_COLORS: Record<string, string> = {
  active: theme.ok,
  running: theme.ok,
  online: theme.ok,
  healthy: theme.ok,
  ready: theme.ok,
  done: theme.ok,
  completed: theme.ok,
  in_progress: theme.accent,
  planned: theme.accent,
  review: theme.warn,
  validating: theme.warn,
  distilling: theme.warn,
  paused: theme.warn,
  blocked: theme.warn,
  attention: theme.warn,
  stale: theme.warn,
  failed: theme.err,
  error: theme.err,
  exited: theme.err,
  offline: theme.err,
  dead: theme.err,
  urgent: theme.err,
};

export function statusColor(status: string | undefined): string {
  if (!status) return theme.dim;
  return STATUS_COLORS[status.toLowerCase()] ?? theme.dim;
}
