import * as React from 'react';
import { Button, SettingsGroup, SettingRow } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import type { Scope, ManagementData, Operation } from './management-client';
export function ManagementOverview({
  scope,
  data,
  busy,
  writeBlocked,
  expired,
  denied,
  tenants,
  missions,
  changeScope,
  start,
}: {
  scope: Scope;
  data: ManagementData | null;
  busy: boolean;
  writeBlocked: boolean;
  expired: boolean;
  denied: boolean;
  tenants: { slug: string; name: string }[];
  missions: string | null;
  changeScope: (scope: Scope) => void;
  start: (operation: Operation) => void;
}) {
  const { t } = useConciergeI18n();
  return (
    <>
      {' '}
      <SettingRow label={t('management.tenant')}>
        <select
          aria-label={t('management.tenant')}
          value={scope.tenant}
          disabled={busy || expired}
          onChange={(event) =>
            changeScope({ tenant: event.target.value, organizationId: '', projectId: '' })
          }
        >
          <option value="">{t('management.choose_tenant')}</option>
          {tenants.map((row) => (
            <option key={row.slug} value={row.slug}>
              {row.name}
            </option>
          ))}
        </select>
      </SettingRow>
      {data ? (
        <>
          <SettingsGroup
            id="management-scope"
            title={t('management.scope')}
            description={t('management.scope_hint')}
          >
            <SettingRow label={t('management.organization')}>
              <select
                aria-label={t('management.organization')}
                value={scope.organizationId}
                disabled={busy || !scope.tenant}
                onChange={(event) =>
                  changeScope({ ...scope, organizationId: event.target.value, projectId: '' })
                }
              >
                <option value="">{t('management.choose_organization')}</option>
                {data.organizations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label={t('management.project')}>
              <select
                aria-label={t('management.project')}
                value={scope.projectId}
                disabled={busy || !scope.organizationId}
                onChange={(event) => changeScope({ ...scope, projectId: event.target.value })}
              >
                <option value="">{t('management.choose_project')}</option>
                {data.projects
                  .filter((row) => row.organization_id === scope.organizationId)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
              </select>
            </SettingRow>
          </SettingsGroup>
          <SettingsGroup id="management-organization" title={t('management.organization')}>
            <div className="settings-row-block">
              <p>
                {data.organization?.purpose ||
                  t(
                    data.organizations.length
                      ? 'management.select_organization'
                      : 'management.no_organizations'
                  )}
              </p>
              <div className="settings-inline-actions">
                <Button
                  label={t('management.create_organization')}
                  disabled={busy || denied || writeBlocked || !data.capabilities.createOrganization}
                  onClick={() => start('organization.create')}
                />
                <Button
                  label={t('management.edit_organization')}
                  disabled={busy || denied || writeBlocked || !data.capabilities.editOrganization}
                  onClick={() => start('organization.update')}
                />
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup id="management-project" title={t('management.project')}>
            <div className="settings-row-block">
              <p>
                {data.project?.summary ||
                  t(data.projects.length ? 'management.select_project' : 'management.no_projects')}
              </p>
              <div className="settings-inline-actions">
                <Button
                  label={t('management.create_project')}
                  disabled={busy || denied || writeBlocked || !data.capabilities.createProject}
                  onClick={() => start('project.create')}
                />
                <Button
                  label={t('management.edit_project')}
                  disabled={busy || denied || writeBlocked || !data.capabilities.editProject}
                  onClick={() => start('project.update')}
                />
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup
            id="management-missions"
            title={t('management.mission')}
            description={t('management.mission_hint')}
          >
            <div className="settings-row-block">
              {missions ? (
                <Button label={t('management.missions')} href={missions} />
              ) : (
                <p>{t('management.links_unavailable')}</p>
              )}
            </div>
          </SettingsGroup>
        </>
      ) : null}
    </>
  );
}
