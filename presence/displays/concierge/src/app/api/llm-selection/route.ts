import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  getLlmSelectionSnapshot,
  saveLlmSelectionPreferences,
} from '@agent/core/llm-selection-preferences';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

const headers = { 'cache-control': 'no-store' };
const response = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const failure = (error: unknown) =>
  response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const snapshot = await withExecutionContextAsync('sovereign_concierge', () =>
      getLlmSelectionSnapshot()
    );
    return response({ ok: true, ...snapshot });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers }
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsed = await readRequestObject(req, 'request body', ['provider', 'model_id']);
    if (!parsed.ok) return response({ ok: false, error: parsed.error }, 400);
    const snapshot = await withExecutionContextAsync('sovereign_concierge', () =>
      saveLlmSelectionPreferences(parsed.body)
    );
    return response({ ok: true, ...snapshot });
  } catch (error) {
    return failure(error);
  }
}
