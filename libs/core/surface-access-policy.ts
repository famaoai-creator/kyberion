export interface SurfaceAccessDecision {
  allowed: boolean;
  configured: boolean;
  actorId: string;
  source: 'common' | 'legacy' | 'default' | 'invalid';
  reason: 'allowlisted' | 'not_allowlisted' | 'allowlist_unconfigured' | 'invalid_allowlist';
}

interface ParsedAllowlist {
  ids: string[];
  source: 'common' | 'legacy' | 'invalid';
}

const DEFAULT_DENY_UNCONFIGURED = new Set(['telegram']);

function normalizeIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean)));
}

function parseCommonAllowlist(raw: string, surface: string): ParsedAllowlist | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { ids: normalizeIds(parsed) || [], source: 'common' };
    }
    if (!parsed || typeof parsed !== 'object') return { ids: [], source: 'invalid' };
    const record = parsed as Record<string, unknown>;
    const entry = Object.prototype.hasOwnProperty.call(record, surface)
      ? record[surface]
      : record['*'];
    if (entry === undefined) return null;
    const ids = Array.isArray(entry)
      ? normalizeIds(entry)
      : entry && typeof entry === 'object'
        ? normalizeIds(
            (entry as Record<string, unknown>).actors ?? (entry as Record<string, unknown>).ids
          )
        : null;
    return ids ? { ids, source: 'common' } : { ids: [], source: 'invalid' };
  } catch {
    return { ids: [], source: 'invalid' };
  }
}

function legacyEnvironmentKeys(surface: string): string[] {
  const prefix = surface.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  return [
    `${prefix}_ALLOWED_USER_IDS`,
    `${prefix}_ALLOWED_ACTORS`,
    ...(surface === 'imessage' ? ['IMESSAGE_ALLOWED_SENDERS'] : []),
  ];
}

function resolveAllowlist(surface: string): ParsedAllowlist | null {
  const common = process.env.KYBERION_SURFACE_ALLOWLISTS?.trim();
  if (common) return parseCommonAllowlist(common, surface);

  for (const key of legacyEnvironmentKeys(surface)) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    return {
      ids: raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      source: 'legacy',
    };
  }
  return null;
}

/**
 * Evaluate an actor against the common surface allowlist.
 * Unconfigured defaults intentionally preserve current bridge behavior:
 * Telegram remains deny-by-default; existing Slack/Discord/iMessage remain open.
 */
export function evaluateSurfaceActorAccess(
  surface: string,
  actorId: string,
  options: { defaultAllow?: boolean } = {}
): SurfaceAccessDecision {
  const normalizedSurface = String(surface || '')
    .trim()
    .toLowerCase();
  const normalizedActor = String(actorId || '').trim();
  const configured = resolveAllowlist(normalizedSurface);

  if (configured?.source === 'invalid') {
    return {
      allowed: false,
      configured: true,
      actorId: normalizedActor,
      source: 'invalid',
      reason: 'invalid_allowlist',
    };
  }
  if (configured) {
    const allowed =
      Boolean(normalizedActor) &&
      (configured.ids.includes('*') || configured.ids.includes(normalizedActor));
    return {
      allowed,
      configured: true,
      actorId: normalizedActor,
      source: configured.source,
      reason: allowed ? 'allowlisted' : 'not_allowlisted',
    };
  }

  const defaultAllow = options.defaultAllow ?? !DEFAULT_DENY_UNCONFIGURED.has(normalizedSurface);
  return {
    allowed: defaultAllow,
    configured: false,
    actorId: normalizedActor,
    source: 'default',
    reason: defaultAllow ? 'allowlist_unconfigured' : 'allowlist_unconfigured',
  };
}

export function describeSurfaceAllowlistConfiguration(surface: string): {
  configured: boolean;
  source: SurfaceAccessDecision['source'];
} {
  const decision = evaluateSurfaceActorAccess(surface, '', { defaultAllow: true });
  return { configured: decision.configured, source: decision.source };
}
