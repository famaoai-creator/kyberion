import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import { presenceStudioUrl } from '../../../../lib/presence-studio-url';

export const dynamic = 'force-dynamic';
const TIMEOUT_MS = 3000;

async function proxy(req: NextRequest, method: 'GET' | 'POST') {
  const target = `${presenceStudioUrl()}/api/voice/selection`;
  const headers: HeadersInit = { accept: 'application/json' };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === 'POST') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { ok: false, error: 'selection body must be an object' },
        { status: 400 }
      );
    }
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(target, init);
    const payload = await response.json().catch(() => ({ ok: false, error: 'invalid response' }));
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ ok: false, error: 'presence_studio_unavailable' }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  return proxy(req, 'GET');
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  return proxy(req, 'POST');
}
