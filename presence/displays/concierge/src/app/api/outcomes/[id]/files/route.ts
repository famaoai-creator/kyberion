import { NextRequest, NextResponse } from 'next/server';
import { listOutcomeFiles, OutcomeFileError } from '../../../../../lib/outcome-files';
import { resolveConciergeViewer, ConciergeViewerError } from '../../../../../lib/viewer-context';
export const dynamic = 'force-dynamic';
export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    try {
      const query = req.nextUrl.searchParams;
      if ([...query.keys()].some((key) => key !== 'cursor') || query.getAll('cursor').length > 1)
        return NextResponse.json(
          { ok: false, error: 'Invalid file request.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      const files = listOutcomeFiles(
        () => {
          const resolved = resolveConciergeViewer(req);
          if (resolved.response) throw resolved.response;
          return resolved.context;
        },
        id,
        query.get('cursor') ?? undefined
      );
      return NextResponse.json(
        { ok: true, files },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    } catch (error) {
      if (error instanceof NextResponse) {
        error.headers.set('Cache-Control', 'no-store');
        return error;
      }
      const status =
        error instanceof OutcomeFileError || error instanceof ConciergeViewerError
          ? error.status
          : 404;
      return NextResponse.json(
        { ok: false, error: 'Outcome files are unavailable.' },
        { status, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  });
}
