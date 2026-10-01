'use client';

import * as React from 'react';
import { SettingRow, SettingsGroup, StatusPill } from '@agent/shared-ui';
import {
  parseOrgReadiness,
  type OrgReadiness,
  type OrgReadinessStepId,
} from '../../../lib/org-readiness-view';
import type { SettingsTranslate } from './form-scope';

const STEP_KEYS = {
  organization: 'setup.org_ready_organization',
  members: 'setup.org_ready_members',
  connections: 'setup.org_ready_connections',
  charter: 'setup.org_ready_charter',
} as const satisfies Record<OrgReadinessStepId, string>;

/**
 * Settings › Organization and members › Setting up an organization. One list per
 * organization the viewer owns or approves for: what is done and where to do
 * the rest. Read-only: every step links to the pane that already does it.
 */
export function OrgReadinessPane({ t }: { t: SettingsTranslate }) {
  const [organizations, setOrganizations] = React.useState<OrgReadiness[]>([]);

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch('/api/org-readiness', { cache: 'no-store' });
        const parsed = parseOrgReadiness(await response.json().catch(() => null));
        if (current && response.ok && parsed) setOrganizations(parsed);
      } catch {
        // The list is advisory; the panes below still work without it.
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  // Nothing to show once every organization is fully set up.
  const pending = organizations.filter((org) => !org.all_done);
  if (pending.length === 0) return null;

  return (
    <SettingsGroup
      id="settings-org-readiness"
      title={t('setup.org_ready_title')}
      description={t('setup.org_ready_description')}
    >
      {pending.map((org) => (
        <div className="settings-row-group" key={org.tenant_slug}>
          <div className="settings-row-block">
            <h4>
              {t('setup.org_ready_progress', {
                tenant: org.tenant_slug,
                done: org.done,
                total: org.total,
              })}
            </h4>
          </div>
          {org.steps.map((step) => {
            const labelKey = STEP_KEYS[step.id as OrgReadinessStepId];
            return (
              <SettingRow key={step.id} label={labelKey ? t(labelKey) : step.id}>
                <div className="settings-inline-actions">
                  <StatusPill
                    status={step.done ? 'completed' : 'needs_setup'}
                    label={step.done ? t('setup.completed') : t('setup.incomplete')}
                  />
                  {!step.done ? <a href={step.href}>{t('setup.org_ready_go')}</a> : null}
                </div>
              </SettingRow>
            );
          })}
        </div>
      ))}
    </SettingsGroup>
  );
}
