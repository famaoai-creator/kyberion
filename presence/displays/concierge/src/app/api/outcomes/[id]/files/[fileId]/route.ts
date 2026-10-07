import { NextRequest, NextResponse } from 'next/server';
import {
  readOutcomeFile,
  OutcomeFileError,
  outcomeDownloadHeaders,
} from '../../../../../../lib/outcome-files';
import { resolveConciergeViewer, ConciergeViewerError } from '../../../../../../lib/viewer-context';
export const dynamic = 'force-dynamic';
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; fileId: string }> }
) {
  try {
    if ([...req.nextUrl.searchParams.keys()].length)
      return NextResponse.json(
        { ok: false, error: 'Invalid file request.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    const { id, fileId } = await context.params;
    const file = readOutcomeFile(
      () => {
        const resolved = resolveConciergeViewer(req);
        if (resolved.response) throw resolved.response;
        return resolved.context;
      },
      id,
      fileId
    );
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: outcomeDownloadHeaders(file.name, file.contentType, file.bytes.length),
    });
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
      { ok: false, error: 'Outcome file is unavailable. Refresh the file list and try again.' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
