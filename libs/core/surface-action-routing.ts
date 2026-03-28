export type SurfaceRoutingIntent =
  | 'conversation'
  | 'browser_open_site'
  | 'browser_step'
  | 'task_session'
  | 'surface_query'
  | 'async_delegate';

export interface SurfaceActionRoutingDecision {
  kind: 'surface_action_routing';
  intent: SurfaceRoutingIntent;
  confidence: number;
  target_operator?:
    | 'presence-surface-agent'
    | 'browser-operator'
    | 'task-session'
    | 'surface-query'
    | 'chronos-mirror'
    | 'nerve-agent';
  browser?: {
    url?: string;
    site_query?: string;
  };
  task?: {
    task_type?: string;
  };
  query?: {
    query_type?: 'location' | 'weather' | 'knowledge_search' | 'web_search';
    text?: string;
  };
  delegate?: {
    receiver?: 'chronos-mirror' | 'nerve-agent';
    reason?: string;
  };
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonObject(text: string): string | null {
  const stripped = stripMarkdownFence(text);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return stripped.slice(start, end + 1);
}

export function validateSurfaceActionRoutingDecision(value: unknown): value is SurfaceActionRoutingDecision {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'surface_action_routing') return false;
  if (typeof record.intent !== 'string') return false;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return false;

  if (record.intent === 'browser_open_site') {
    const browser = record.browser;
    if (!browser || typeof browser !== 'object') return false;
    const browserRecord = browser as Record<string, unknown>;
    if (typeof browserRecord.url !== 'string' && typeof browserRecord.site_query !== 'string') return false;
  }

  if (record.intent === 'surface_query') {
    const query = record.query;
    if (!query || typeof query !== 'object') return false;
    const queryRecord = query as Record<string, unknown>;
    if (!['location', 'weather', 'knowledge_search', 'web_search'].includes(String(queryRecord.query_type || ''))) {
      return false;
    }
  }

  if (record.intent === 'async_delegate') {
    const delegate = record.delegate;
    if (!delegate || typeof delegate !== 'object') return false;
    const delegateRecord = delegate as Record<string, unknown>;
    if (!['chronos-mirror', 'nerve-agent'].includes(String(delegateRecord.receiver || ''))) return false;
  }

  return true;
}

export function parseSurfaceActionRoutingDecision(text: string): SurfaceActionRoutingDecision | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return validateSurfaceActionRoutingDecision(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
