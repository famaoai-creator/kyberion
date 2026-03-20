import { NextRequest, NextResponse } from "next/server";

/**
 * API Guard: Authentication + Rate Limiting for Chronos Mirror API routes.
 *
 * Authentication: Bearer token or session-based.
 * Rate Limiting: Per-IP sliding window.
 */

const API_TOKEN = process.env.KYBERION_API_TOKEN;
const LOCALADMIN_TOKEN = process.env.KYBERION_LOCALADMIN_TOKEN;
const ALLOW_UNAUTH_REMOTE = process.env.KYBERION_ALLOW_UNAUTH_REMOTE === "true";
const ALLOW_LOCALHOST_AUTOADMIN = process.env.KYBERION_LOCALHOST_AUTOADMIN === "true";

export type ChronosAccessRole = "readonly" | "localadmin";

// In-memory rate limit store
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 30;        // requests
const RATE_LIMIT_WINDOW = 60000;  // 1 minute

function getClientIP(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateLimitStore.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

/**
 * Validate an incoming API request.
 * Returns null if OK, or a NextResponse error if rejected.
 */
function resolveToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return bearer || req.cookies.get("kyberion_token")?.value || null;
}

export function resolveChronosAccessRole(req: NextRequest): ChronosAccessRole | null {
  const ip = getClientIP(req);
  const isLocal = isLoopback(ip);
  const token = resolveToken(req);

  if (LOCALADMIN_TOKEN && token === LOCALADMIN_TOKEN) {
    return "localadmin";
  }
  if (API_TOKEN && token === API_TOKEN) {
    return "readonly";
  }
  if (isLocal && ALLOW_LOCALHOST_AUTOADMIN) {
    return "localadmin";
  }
  if (isLocal) {
    return "readonly";
  }
  if (!API_TOKEN && !LOCALADMIN_TOKEN && ALLOW_UNAUTH_REMOTE) {
    return "readonly";
  }
  return null;
}

export function guardRequest(req: NextRequest): NextResponse | null {
  // Rate limiting (always applied)
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429 }
    );
  }

  if (!resolveChronosAccessRole(req)) {
    return NextResponse.json(
      { error: "Unauthorized. Use a local session, KYBERION_API_TOKEN, or KYBERION_LOCALADMIN_TOKEN." },
      { status: 401 }
    );
  }

  return null; // OK
}

export function requireChronosAccess(req: NextRequest, requiredRole: ChronosAccessRole): NextResponse | null {
  const resolved = resolveChronosAccessRole(req);
  if (!resolved) {
    return NextResponse.json(
      { error: "Unauthorized. Use a local session, KYBERION_API_TOKEN, or KYBERION_LOCALADMIN_TOKEN." },
      { status: 401 }
    );
  }
  if (requiredRole === "localadmin" && resolved !== "localadmin") {
    return NextResponse.json(
      { error: "Forbidden. This action requires Chronos localadmin access." },
      { status: 403 }
    );
  }
  return null;
}

export function roleToMissionRole(accessRole: ChronosAccessRole): string {
  if (accessRole === "localadmin") {
    return "chronos_localadmin";
  }
  return "chronos_operator";
}

export function getChronosAccessRoleOrThrow(req: NextRequest): ChronosAccessRole {
  const resolved = resolveChronosAccessRole(req);
  if (!resolved) {
    throw new Error("Chronos access role was requested before authentication succeeded.");
  }
  return resolved;
}
