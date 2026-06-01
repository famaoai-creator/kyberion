import type { Request, RequestHandler } from 'express';
import { isIP } from 'node:net';
import { z } from 'zod';
import { logger } from '@agent/core';

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);
const RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;
const RATE_LIMIT_DEFAULT_GET = 180;
const RATE_LIMIT_DEFAULT_MUTATION = 60;
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();
const booleanLike = z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional();

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isPrivateIpv4(hostname: string): boolean {
  return (
    /^10\./.test(hostname)
    || /^127\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  return (
    hostname === '::1'
    || hostname.startsWith('fe80:')
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('::ffff:127.')
    || hostname.startsWith('::ffff:7f00:')
  );
}

export function getPresenceStudioAuthToken(): string {
  return String(process.env.PRESENCE_STUDIO_TOKEN || process.env.KYBERION_API_TOKEN || '');
}

export function getPresenceStudioClientAddress(req: Pick<Request, 'socket'>): string {
  return req.socket?.remoteAddress || 'unknown';
}

function getPresenceStudioRateLimitKey(req: Pick<Request, 'method' | 'socket'>): string {
  return `${getPresenceStudioClientAddress(req)}:${String(req.method || 'UNKNOWN').toUpperCase()}`;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  return LOCALHOST_NAMES.has(normalized);
}

export function isLoopbackOrPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (LOCALHOST_NAMES.has(normalized)) return true;
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return isPrivateIpv6(normalized);
  return false;
}

export function extractPresenceStudioToken(req: Pick<Request, 'headers'>): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export function checkPresenceStudioRateLimit(
  req: Pick<Request, 'method' | 'socket'>,
  options?: { limit?: number; windowMs?: number },
): { ok: boolean; status: number; reason: string; retryAfterSeconds?: number } {
  const clientAddress = getPresenceStudioClientAddress(req);
  if (isLoopbackAddress(clientAddress)) {
    return { ok: true, status: 200, reason: 'allowed' };
  }

  const windowMs = options?.windowMs ?? Number(process.env.PRESENCE_STUDIO_RATE_LIMIT_WINDOW_MS || RATE_LIMIT_DEFAULT_WINDOW_MS);
  const method = String(req.method || 'UNKNOWN').toUpperCase();
  const limit = options?.limit ?? (
    method === 'GET' || method === 'HEAD'
      ? Number(process.env.PRESENCE_STUDIO_RATE_LIMIT_GET || RATE_LIMIT_DEFAULT_GET)
      : Number(process.env.PRESENCE_STUDIO_RATE_LIMIT_MUTATION || RATE_LIMIT_DEFAULT_MUTATION)
  );
  const key = getPresenceStudioRateLimitKey(req);
  const now = Date.now();
  const current = rateLimitStore.get(key);
  const expired = !current || (now - current.windowStart) > windowMs;
  const windowStart = expired ? now : current.windowStart;
  const count = expired ? 1 : current.count + 1;
  rateLimitStore.set(key, { count, windowStart });

  if (count <= limit) {
    return { ok: true, status: 200, reason: 'allowed' };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - windowStart)) / 1000));
  return {
    ok: false,
    status: 429,
    reason: `Rate limit exceeded. Retry in about ${retryAfterSeconds}s.`,
    retryAfterSeconds,
  };
}

export function authorizePresenceStudioRequest(req: Pick<Request, 'headers' | 'socket'>): {
  ok: boolean;
  status: number;
  reason: string;
} {
  const clientAddress = getPresenceStudioClientAddress(req);
  if (isLoopbackAddress(clientAddress)) {
    return { ok: true, status: 200, reason: 'local' };
  }

  if (process.env.PRESENCE_STUDIO_ALLOW_REMOTE === 'true') {
    const token = getPresenceStudioAuthToken();
    if (!token) {
      return { ok: true, status: 200, reason: 'remote_allowed' };
    }
    const presented = extractPresenceStudioToken(req);
    if (presented === token) {
      return { ok: true, status: 200, reason: 'token' };
    }
    return {
      ok: false,
      status: 401,
      reason: 'Unauthorized. Provide Authorization: Bearer <token> or connect locally.',
    };
  }

  const token = getPresenceStudioAuthToken();
  if (token) {
    const presented = extractPresenceStudioToken(req);
    if (presented === token) {
      return { ok: true, status: 200, reason: 'token' };
    }
    return {
      ok: false,
      status: 401,
      reason: 'Unauthorized. Provide Authorization: Bearer <token> or connect locally.',
    };
  }

  return {
    ok: false,
    status: 403,
    reason: 'Remote access disabled. Set PRESENCE_STUDIO_ALLOW_REMOTE=true or provide PRESENCE_STUDIO_TOKEN.',
  };
}

export function requirePresenceStudioAccess(): RequestHandler {
  return (req, res, next) => {
    const auth = authorizePresenceStudioRequest(req);
    if (!auth.ok) {
      logger.warn(
        `[presence-studio][auth] denied method=${String(req.method || 'UNKNOWN').toUpperCase()} path=${String(req.path || req.url || '')} client=${getPresenceStudioClientAddress(req)} status=${auth.status} reason=${auth.reason}`,
      );
      return res.status(auth.status).json({ ok: false, error: auth.reason });
    }
    return next();
  };
}

export function requirePresenceStudioRateLimit(): RequestHandler {
  return (req, res, next) => {
    const decision = checkPresenceStudioRateLimit(req);
    if (!decision.ok) {
      if (decision.retryAfterSeconds) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      }
      logger.warn(
        `[presence-studio][rate-limit] denied method=${String(req.method || 'UNKNOWN').toUpperCase()} path=${String(req.path || req.url || '')} client=${getPresenceStudioClientAddress(req)} status=${decision.status} reason=${decision.reason}`,
      );
      return res.status(decision.status).json({ ok: false, error: decision.reason });
    }
    return next();
  };
}

export function validateLocalServiceUrl(rawUrl: string, label: string): string {
  if (!rawUrl) {
    throw new Error(`Missing ${label}`);
  }

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (LOCALHOST_NAMES.has(hostname)) {
    return parsed.toString().replace(/\/$/, '');
  }

  if (isIP(hostname) === 4 && isPrivateIpv4(hostname)) {
    return parsed.toString().replace(/\/$/, '');
  }
  if (isIP(hostname) === 6 && isPrivateIpv6(hostname)) {
    return parsed.toString().replace(/\/$/, '');
  }

  throw new Error(`${label} must resolve to localhost or a private IP address`);
}

export const presenceStudioVoiceStimulusSchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(4000, 'text is too long'),
  request_id: z.string().trim().min(1).max(128).optional(),
  intent: z.string().trim().min(1).max(128).optional(),
  source_id: z.string().trim().min(1).max(128).optional(),
});

export const presenceStudioVoiceIngestSchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(4000, 'text is too long'),
  request_id: z.string().trim().min(1).max(128).optional(),
  intent: z.string().trim().min(1).max(128).optional(),
  source_id: z.string().trim().min(1).max(128).optional(),
  speaker: z.string().trim().min(1).max(128).optional(),
  reflect_to_surface: booleanLike,
  auto_reply: booleanLike,
});

export const presenceStudioVoiceNativeListenSchema = z.object({
  request_id: z.string().trim().min(1).max(128).optional(),
  locale: z.string().trim().min(2).max(32).optional(),
  device_id: z.string().trim().min(1).max(128).optional(),
  backend: z.string().trim().min(1).max(128).optional(),
  timeout_seconds: z.number().finite().int().min(1).max(30).optional(),
  intent: z.string().trim().min(1).max(128).optional(),
  speaker: z.string().trim().min(1).max(128).optional(),
  reflect_to_surface: booleanLike,
  auto_reply: booleanLike,
});

export const presenceStudioEmailDraftSchema = z.object({
  request_id: z.string().trim().min(1).max(128).optional(),
  to: z.string().trim().max(254).optional(),
  subject: z.string().trim().max(200).optional(),
  tone: z.string().trim().min(1).max(120).optional(),
  triage_text: z.string().trim().min(1).max(20_000).optional(),
});

export const presenceStudioEmailDeliverSchema = z.object({
  approved: booleanLike,
  body_markdown: z.string().trim().min(1, 'body_markdown is required').max(20_000, 'body_markdown is too long'),
  reply_mode: z.enum(['new', 'reply', 'reply-all']).optional(),
  draft_mode: booleanLike,
  subject: z.string().trim().max(200).optional(),
  to: z.string().trim().max(254).optional(),
  message_id: z.string().trim().max(512).optional(),
});

export const presenceStudioVoiceMinutesSchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(20_000, 'text is too long'),
  request_id: z.string().trim().min(1).max(128).optional(),
  mission_id: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  language: z.string().trim().min(1).max(16).optional(),
  attendees: z.array(z.union([
    z.string(),
    z.object({ name: z.string().trim().min(1).max(120) }).transform((value) => value.name),
  ])).max(20).optional(),
});

export const presenceStudioLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100_000).optional(),
  timestamp: z.string().trim().min(1).max(128).optional(),
});

export const presenceStudioBrowserBootstrapSchema = z.object({
  browser_session_id: z.string().trim().min(1).max(128),
  goal_summary: z.string().trim().min(1).max(300).optional(),
  success_condition: z.string().trim().min(1).max(300).optional(),
});

export function summarizePresenceStudioIdentity(payload: {
  sovereign?: { name?: unknown } | null;
  agent?: { agent_id?: unknown; trust_tier?: unknown } | null;
  vision?: unknown;
}): {
  ok: true;
  onboarded: boolean;
  sovereign: { name: string } | null;
  agent: { agent_id: string; trust_tier: string | null } | null;
  vision: string | null;
} {
  const sovereignName = typeof payload.sovereign?.name === 'string' && payload.sovereign.name.trim()
    ? payload.sovereign.name.trim()
    : null;
  const agentId = typeof payload.agent?.agent_id === 'string' && payload.agent.agent_id.trim()
    ? payload.agent.agent_id.trim()
    : null;
  const trustTier = typeof payload.agent?.trust_tier === 'string' && payload.agent.trust_tier.trim()
    ? payload.agent.trust_tier.trim()
    : null;
  const vision = typeof payload.vision === 'string' && payload.vision.trim()
    ? payload.vision.trim().slice(0, 600)
    : null;

  return {
    ok: true,
    onboarded: Boolean(sovereignName && agentId),
    sovereign: sovereignName ? { name: sovereignName } : null,
    agent: agentId ? { agent_id: agentId, trust_tier: trustTier } : null,
    vision,
  };
}

export function summarizePresenceStudioState(state: {
  surfaces?: Record<string, unknown>;
  recentStimuli?: unknown[];
  lastUpdatedAt?: string | null;
}): {
  ok: true;
  surfaces_count: number;
  recentStimuli: unknown[];
  lastUpdatedAt: string | null;
} {
  return {
    ok: true,
    surfaces_count: state.surfaces ? Object.keys(state.surfaces).length : 0,
    recentStimuli: Array.isArray(state.recentStimuli) ? state.recentStimuli.slice(-10) : [],
    lastUpdatedAt: state.lastUpdatedAt ?? null,
  };
}
