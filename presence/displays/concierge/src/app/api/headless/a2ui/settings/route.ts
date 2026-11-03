import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeConciergeOperation,
  conciergeEnvelope,
} from '../../../../../lib/headless-projections';
import {
  buildConciergeSettingsA2UI,
  type SettingsProjectionInput,
} from '../../../../../lib/settings-a2ui';
import { buildConciergeSetupState } from '../../../../../lib/setup-state';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../../lib/i18n';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    authorizeConciergeOperation(resolved.context, 'concierge.settings.a2ui');
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const setup = buildConciergeSetupState(resolved.context, t);
    return NextResponse.json(
      conciergeEnvelope(
        'settings',
        {
          source_resource: 'setup',
          a2ui: buildConciergeSettingsA2UI(setup as SettingsProjectionInput, locale, t),
        },
        resolved.context
      )
    );
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
