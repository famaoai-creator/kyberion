import { NextResponse } from 'next/server';
import { buildCeoSurfaceSummary } from '@agent/core';

export const dynamic = 'force-dynamic';

export function GET() {
  try {
    const summary = buildCeoSurfaceSummary();
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
