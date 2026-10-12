import type { NextRequest } from 'next/server';
import { handleSelectionRequest } from '../../../../lib/selection-route';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  return handleSelectionRequest(req, { kind: 'reasoning' });
}
export async function POST(req: NextRequest) {
  return handleSelectionRequest(req, { kind: 'reasoning' });
}
