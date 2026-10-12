import type { NextRequest } from 'next/server';
import { handleSelectionRequest } from '../../../../../lib/selection-route';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) {
  const { id } = await context.params;
  return handleSelectionRequest(req, { kind: 'mission', missionId: id });
}
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  return handleSelectionRequest(req, { kind: 'mission', missionId: id });
}
