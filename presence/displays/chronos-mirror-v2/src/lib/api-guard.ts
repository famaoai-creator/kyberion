import { NextRequest, NextResponse } from "next/server";

/**
 * API Guard: Authentication + Rate Limiting for Chronos Mirror API routes.
 *
 * Authentication: Bearer token or session-based.
 * Rate Limiting: Per-IP sliding window.
 */

const API_TOKEN = process.env.KYBERION_API_TOKEN;

// In-memory rate limit store
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 30;        // requests
const RATE_LIMIT_WINDOW = 60000;  // 1 minute

function getClientIP(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
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

  // Authentication: if KYBERION_API_TOKEN is set, require it
  if (API_TOKEN) {
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // Also accept token from cookie for browser sessions
    const cookieToken = req.cookies.get("kyberion_token")?.value;

    if (token !== API_TOKEN && cookieToken !== API_TOKEN) {
      // Allow localhost without token in development
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "unknown") {
        return NextResponse.json(
          { error: "Unauthorized. Set Authorization: Bearer <token>" },
          { status: 401 }
        );
      }
    }
  }

  return null; // OK
}
