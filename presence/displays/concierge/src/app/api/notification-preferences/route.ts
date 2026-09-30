import { NextRequest, NextResponse } from 'next/server';
import { isSurfaceAsyncChannel } from '@agent/core/surface/channel-surface-types';
import { listChannelDirectoryEntries } from '@agent/core/surface/channel-directory';
import {
  DEFAULT_URGENT_EVENTS,
  loadNotificationPreferences,
  saveNotificationPreferences,
  type NotificationChannelTarget,
  type NotificationPreferences,
} from '@agent/core/surface/operator-notifications';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

// Mirrors the closed surface union of NotificationChannelTarget in
// @agent/core/operator-notifications — the only surfaces the operator
// notification path can deliver to. `inbox` is a local fallback and is not a
// surface-provider channel, so it is handled explicitly below.
const NOTIFIABLE_SURFACES: ReadonlyArray<NotificationChannelTarget['surface']> = [
  'slack',
  'imessage',
  'telegram',
  'discord',
  'inbox',
];

// Preferences live in knowledge/personal/ — reads and writes both go through
// the sovereign_concierge execution context with sensitive-path mediation,
// exactly like the personal-profile writes in /api/setup.
function withPreferences<T>(fn: (prefs: NotificationPreferences) => T): T {
  return withExecutionContext('sovereign_concierge', () =>
    secureIo.withSensitivePathMediation(() => fn(loadNotificationPreferences()))
  );
}

function listNotifiableChannels() {
  const directory = new Map(listChannelDirectoryEntries().map((entry) => [entry.channel, entry]));
  return NOTIFIABLE_SURFACES.map((surface) => {
    if (surface === 'inbox') {
      return { surface, display_name: 'Local inbox', status: 'ready' };
    }
    return {
      surface,
      display_name: directory.get(surface)?.displayName || surface,
      status: directory.get(surface)?.status || 'unknown',
    };
  });
}

function publicPreferences(prefs: NotificationPreferences) {
  return {
    default_channel: prefs.default_channel || null,
    quiet_hours: prefs.quiet_hours || null,
    urgent_events: prefs.urgent_events ?? [...DEFAULT_URGENT_EVENTS],
  };
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const preferences = withPreferences((prefs) => prefs);
    return NextResponse.json({
      ok: true,
      preferences: publicPreferences(preferences),
      channels: listNotifiableChannels(),
    });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const parsedBody = await readRequestObject(req, 'request body', [
      'surface',
      'channel',
      'target',
      'quiet_hours',
      'urgent_events',
    ]);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;

    // Quiet-hours update: independent of the delivery channel, so it can be
    // saved on its own. `quiet_hours: null` turns the window off. The core
    // validator (HH:MM, IANA timezone, known events) is the single authority;
    // any rejection there is a 400, never a partial write.
    if (body && ('quiet_hours' in body || 'urgent_events' in body) && !('surface' in body)) {
      try {
        const saved = withPreferences((prefs) => {
          if ('quiet_hours' in body) {
            if (body.quiet_hours === null) delete prefs.quiet_hours;
            else prefs.quiet_hours = body.quiet_hours as NotificationPreferences['quiet_hours'];
          }
          if ('urgent_events' in body) {
            prefs.urgent_events = body.urgent_events as NotificationPreferences['urgent_events'];
          }
          saveNotificationPreferences(prefs);
          return prefs;
        });
        return NextResponse.json({ ok: true, preferences: publicPreferences(saved) });
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid notification preferences') {
          return NextResponse.json(
            { ok: false, error: t('api.notification_quiet_hours') },
            { status: 400 }
          );
        }
        throw error;
      }
    }
    const surface = typeof body?.surface === 'string' ? body.surface.trim() : '';

    if (surface === 'none') {
      const saved = withPreferences((prefs) => {
        delete prefs.default_channel;
        saveNotificationPreferences(prefs);
        return prefs;
      });
      return NextResponse.json({ ok: true, preferences: publicPreferences(saved) });
    }

    const knownChannels = new Set(listChannelDirectoryEntries().map((entry) => entry.channel));
    const channel: NotificationChannelTarget['surface'] | undefined =
      surface === 'inbox'
        ? 'inbox'
        : isSurfaceAsyncChannel(surface) &&
            (NOTIFIABLE_SURFACES as readonly string[]).includes(surface)
          ? (surface as NotificationChannelTarget['surface'])
          : undefined;
    const known = channel === 'inbox' || (channel !== undefined && knownChannels.has(channel));
    if (!channel || !known) {
      return NextResponse.json(
        { ok: false, error: t('api.notification_surface') },
        { status: 400 }
      );
    }
    const rawTarget = body?.channel ?? body?.target;
    const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
    if (!target || target.length > 120 || /\s/.test(target)) {
      return NextResponse.json({ ok: false, error: t('api.notification_target') }, { status: 400 });
    }

    const saved = withPreferences((prefs) => {
      prefs.default_channel = {
        surface: channel as NotificationChannelTarget['surface'],
        target,
      };
      saveNotificationPreferences(prefs);
      return prefs;
    });
    return NextResponse.json({ ok: true, preferences: publicPreferences(saved) });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
