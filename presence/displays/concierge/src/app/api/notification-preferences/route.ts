import { NextRequest, NextResponse } from 'next/server';
import { isSurfaceAsyncChannel } from '@agent/core/channel-surface-types';
import { listChannelDirectoryEntries } from '@agent/core/channel-directory';
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
  type NotificationChannelTarget,
  type NotificationPreferences,
} from '@agent/core/operator-notifications';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

// Mirrors the closed surface union of NotificationChannelTarget in
// @agent/core/operator-notifications — the only surfaces the operator
// notification path can deliver to.
const NOTIFIABLE_SURFACES: ReadonlyArray<NotificationChannelTarget['surface']> = [
  'slack',
  'imessage',
  'telegram',
  'discord',
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
  return NOTIFIABLE_SURFACES.map((surface) => ({
    surface,
    display_name: directory.get(surface)?.displayName || surface,
    status: directory.get(surface)?.status || 'unknown',
  }));
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const preferences = withPreferences((prefs) => prefs);
    return NextResponse.json({
      ok: true,
      preferences: { default_channel: preferences.default_channel || null },
      channels: listNotifiableChannels(),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
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
    ]);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const surface = typeof body?.surface === 'string' ? body.surface.trim() : '';

    if (surface === 'none') {
      const saved = withPreferences((prefs) => {
        delete prefs.default_channel;
        saveNotificationPreferences(prefs);
        return prefs;
      });
      return NextResponse.json({
        ok: true,
        preferences: { default_channel: saved.default_channel || null },
      });
    }

    const knownChannels = new Set(listChannelDirectoryEntries().map((entry) => entry.channel));
    const channel = isSurfaceAsyncChannel(surface) ? surface : undefined;
    const notifiable =
      channel !== undefined && (NOTIFIABLE_SURFACES as readonly string[]).includes(channel);
    if (!channel || !notifiable || !knownChannels.has(channel)) {
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
    return NextResponse.json({
      ok: true,
      preferences: { default_channel: saved.default_channel || null },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
