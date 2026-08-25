import { NextRequest, NextResponse } from 'next/server';
import {
  conciergeManifestForViewer,
  conciergeAvailableOperations,
} from '../../../../lib/headless-projections';
import { conciergeHeadlessScope } from '../../../../lib/viewer-context';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  return NextResponse.json({
    ok: true,
    manifest: conciergeManifestForViewer(resolved.context),
    viewer: {
      scope: conciergeHeadlessScope(resolved.context),
      available_operations: conciergeAvailableOperations(resolved.context),
    },
  });
}
