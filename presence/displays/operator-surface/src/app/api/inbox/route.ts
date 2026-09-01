import { NextRequest, NextResponse } from 'next/server';
import { acceptInboxEntryWithHumanReceipt, markInboxEntry } from '@agent/core/deliverable-inbox';
import { requireOperatorSurfaceMutationAccess } from '../../../lib/api-guard';
import {
  parseInboxMutationForm,
  parseInboxMutationInput,
  type InboxMutationParseResult,
} from './inbox-input';

export async function POST(req: NextRequest) {
  const denied = requireOperatorSurfaceMutationAccess(req);
  if (denied) return denied;

  const contentType = req.headers.get('content-type') || '';
  let parsed: InboxMutationParseResult;

  if (contentType.includes('application/json')) {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Inbox request body must be valid JSON' }, { status: 400 });
    }
    parsed = parseInboxMutationInput(rawBody);
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: 'Inbox form body must be valid' }, { status: 400 });
    }
    parsed = parseInboxMutationForm(form);
  }

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { entryId, status } = parsed.value;

  const updated =
    status === 'accepted'
      ? acceptInboxEntryWithHumanReceipt({
          entryId,
          actorId: 'human:operator-surface',
          authenticated: true,
          authMethod: 'surface_session',
          responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
        })
      : markInboxEntry(entryId, status as 'read' | 'unread');
  if (!updated) {
    return NextResponse.json({ error: 'Inbox entry not found' }, { status: 404 });
  }

  return NextResponse.redirect(new URL('/inbox', req.url), 303);
}
