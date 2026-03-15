import { NextRequest, NextResponse } from "next/server";

/**
 * API Guard: Authentication + Rate Limiting for Chronos Mirror API routes.
 *
 * Authentication: Bearer token or session-based.
 * Rate Limiting: Per-IP sliding window.
 */

const API_TOKEN = process.env.KYBERION_API_TOKEN;
const ALLOW_UNAUTH_REMOTE = process.env.KYBERION_ALLOW_UNAUTH_REMOTE === "true";

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
export function guardRequest(req: NextRequest): NextResponse | null {
  // Rate limiting (always applied)
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429 }
    );
  }

  const isLocal = isLoopback(ip);
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cookieToken = req.cookies.get("kyberion_token")?.value;

  // Authentication: if KYBERION_API_TOKEN is set, require it
  if (API_TOKEN) {
    if (token !== API_TOKEN && cookieToken !== API_TOKEN) {
      if (!isLocal) {
        return NextResponse.json(
          { error: "Unauthorized. Set Authorization: Bearer <token>" },
          { status: 401 }
        );
      }
    }
  } else {
    // No token set: allow local only unless explicitly enabled
    if (!isLocal && !ALLOW_UNAUTH_REMOTE) {
      return NextResponse.json(
        { error: "Unauthorized. Set KYBERION_API_TOKEN or enable KYBERION_ALLOW_UNAUTH_REMOTE=true" },
        { status: 401 }
      );
    }
  }

  return null; // OK
}
