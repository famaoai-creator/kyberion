import { NextRequest, NextResponse } from 'next/server';
import {
  listCalendarAgenda,
  normalizeCalendarProviderId,
} from '@agent/core/meeting/calendar-workflow';
import { isCalendarDate } from '@agent/core/foundation/time';
import { createLogger } from '@agent/core/logger';
import { resolveConciergeInstallationAccess } from '../../../../lib/installation-access';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  forgetProviderLoginState,
  isProviderTokenRefusal,
  providerLoginState,
} from '../../../../lib/external-calendar-status';

export const dynamic = 'force-dynamic';

const logger = createLogger('concierge-external-calendar');

/** Same ceiling as `workspace.calendar` (a month grid is 42 days). */
const MAX_DAYS = 92;
const MAX_EVENTS = 250;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export interface ExternalCalendarEvent {
  id: string;
  title: string;
  /** ISO instant, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  end?: string;
  allDay: boolean;
  link?: string;
}

function dayCount(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

/**
 * The installation owner's own calendar (Google Workspace / Microsoft 365) for
 * the work calendar's visible days. The connection is the machine's provider
 * login, so its events are that person's personal data: only the installation
 * owner (attested loopback peer or bound owner principal) receives them, and
 * nobody else learns whether a calendar is connected. Nothing is called on the
 * network unless the provider reports an authenticated login; a stored login
 * the provider refused answers `login_expired` so the owner can sign in again.
 * A provider
 * failure answers `degraded` with a fixed message (never the raw error).
 */
export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  if (!resolveConciergeInstallationAccess(resolved.context, 'read', req).allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: 'installation_owner_required',
        error_code: 'installation_owner_required',
      },
      { status: 403, headers: NO_STORE }
    );
  }
  const from = req.nextUrl.searchParams.get('from')?.trim();
  const to = req.nextUrl.searchParams.get('to')?.trim();
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to || dayCount(from, to) > MAX_DAYS) {
    return NextResponse.json(
      {
        ok: false,
        error: `from and to must be calendar days, at most ${MAX_DAYS} days apart`,
        error_code: 'invalid_input',
      },
      { status: 400, headers: NO_STORE }
    );
  }
  let provider: string;
  try {
    provider = normalizeCalendarProviderId();
  } catch {
    return NextResponse.json(
      { ok: true, provider: null, connected: false, events: [] },
      { headers: NO_STORE }
    );
  }
  const login = await providerLoginState(provider);
  if (login !== 'signed_in') {
    // `login_expired`: credentials are stored but the provider refused them;
    // the owner has to sign in again (the page shows the command).
    return NextResponse.json(
      {
        ok: true,
        provider,
        connected: false,
        ...(login === 'expired' ? { login_expired: true } : {}),
        events: [],
      },
      { headers: NO_STORE }
    );
  }
  try {
    // Pad a day either side: the viewer's local day of an instant can differ from UTC.
    const timeMin = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString();
    const timeMax = new Date(Date.parse(`${to}T23:59:59Z`) + 86_400_000).toISOString();
    const agenda = await listCalendarAgenda({
      provider,
      time_min: timeMin,
      time_max: timeMax,
      max_results: MAX_EVENTS,
    });
    const events: ExternalCalendarEvent[] = agenda.events
      .filter((event) => event.status !== 'cancelled' && event.start)
      .map((event) => ({
        id: event.id,
        title: event.summary || '(no title)',
        start: event.start,
        ...(event.end ? { end: event.end } : {}),
        allDay: isCalendarDate(event.start),
        ...(event.html_link ? { link: event.html_link } : {}),
      }));
    return NextResponse.json(
      {
        ok: true,
        provider,
        connected: true,
        events,
        ...(agenda.total_items >= MAX_EVENTS ? { truncated: true } : {}),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    // The login may have expired since it was checked: check it again next time.
    forgetProviderLoginState(provider);
    // A provider whose status cannot see an expired login (m365) shows it
    // here: the read was refused. The owner gets the re-login hint, not the text.
    if (isProviderTokenRefusal(error)) {
      logger.warn(
        `external calendar login refused — the provider rejected the stored sign-in | ` +
          `next: the owner signs in again (the page shows the command) | evidence: provider=${provider}`
      );
      return NextResponse.json(
        { ok: true, provider, connected: false, login_expired: true, events: [] },
        { headers: NO_STORE }
      );
    }
    // The reply stays fixed (wire boundary); the operator log carries the cause.
    logger.warn(
      `external calendar read failed — ${error instanceof Error ? error.message : String(error)} | ` +
        `next: check the provider login (gws auth status / m365) and the service connection | ` +
        `evidence: provider=${provider}`
    );
    return NextResponse.json(
      {
        ok: true,
        provider,
        connected: true,
        degraded: true,
        error: 'the calendar provider could not be read',
        events: [],
      },
      { headers: NO_STORE }
    );
  }
}
