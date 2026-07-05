import { NextRequest, NextResponse } from 'next/server';
import { markInboxEntry } from '@agent/core';
import { requireOperatorSurfaceMutationAccess } from '../../../lib/api-guard';

export async function POST(req: NextRequest) {
  const denied = requireOperatorSurfaceMutationAccess(req);
  if (denied) return denied;

  const contentType = req.headers.get('content-type') || '';
  let entryId = '';
  let status = '';

  if (contentType.includes('application/json')) {
    const body = await req.json();
    entryId = typeof body?.entry_id === 'string' ? body.entry_id : '';
    status = typeof body?.status === 'string' ? body.status : '';
  } else {
    const form = await req.formData();
    entryId = String(form.get('entry_id') || '');
    status = String(form.get('status') || '');
  }

  if (!entryId || (status !== 'read' && status !== 'accepted' && status !== 'unread')) {
    return NextResponse.json({ error: 'Missing inbox mutation payload' }, { status: 400 });
  }

  const updated = markInboxEntry(entryId, status);
  if (!updated) {
    return NextResponse.json({ error: 'Inbox entry not found' }, { status: 404 });
  }

  return NextResponse.redirect(new URL('/inbox', req.url), 303);
}
