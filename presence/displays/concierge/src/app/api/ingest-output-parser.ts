export interface IngestCliVerdict {
  dry_run?: boolean;
  would_commit?: boolean;
  target_path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseIngestCliVerdict(stdout: string, marker: string): IngestCliVerdict | null {
  const at = stdout.indexOf(marker);
  if (at < 0) return null;
  const brace = stdout.indexOf('{', at);
  if (brace < 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(brace));
    if (!isRecord(parsed)) return null;
    if (parsed.dry_run !== undefined && typeof parsed.dry_run !== 'boolean') return null;
    if (parsed.would_commit !== undefined && typeof parsed.would_commit !== 'boolean') return null;
    if (parsed.target_path !== undefined && typeof parsed.target_path !== 'string') return null;
    return {
      ...(typeof parsed.dry_run === 'boolean' ? { dry_run: parsed.dry_run } : {}),
      ...(typeof parsed.would_commit === 'boolean' ? { would_commit: parsed.would_commit } : {}),
      ...(typeof parsed.target_path === 'string' ? { target_path: parsed.target_path } : {}),
    };
  } catch {
    return null;
  }
}
