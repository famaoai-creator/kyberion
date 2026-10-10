import * as React from 'react';
import { Button, Callout } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { managementDescription } from './management-client';
import type { ManagementData, Mutation, Scope, Operation } from './management-client';
export type ManagementDraft = { operation: Operation; name: string; description: string };
export function ManagementEditor({
  draft,
  verifying,
  data,
  pending,
  busy,
  notice,
  scope,
  setDraft,
  review,
  commit,
  cancel,
}: {
  draft: ManagementDraft;
  verifying: boolean;
  data: ManagementData;
  pending: Mutation | null;
  busy: boolean;
  notice: string | null;
  scope: Scope;
  setDraft: (draft: ManagementDraft) => void;
  review: (event: React.FormEvent) => void;
  commit: () => Promise<void>;
  cancel: () => void;
}) {
  const { t } = useConciergeI18n();
  const organization = draft.operation.startsWith('organization');
  const description = managementDescription(draft.operation, draft.description, data);
  return (
    <section aria-labelledby="management-form-title" className="management-editor">
      <h2 id="management-form-title">
        {t(('management.' + draft.operation.replace('.', '_')) as Parameters<typeof t>[0])}
      </h2>
      {!pending ? (
        <form onSubmit={review} className="settings-section">
          <label>
            {t('management.name')}
            <input
              required
              disabled={verifying}
              maxLength={160}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            {t(organization ? 'management.purpose' : 'management.summary')}
            <textarea
              disabled={verifying}
              required={description.required}
              maxLength={10000}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="settings-inline-actions">
            <Button
              type="submit"
              label={t('management.review')}
              disabled={busy || verifying || !draft.name.trim() || !description.valid}
            />
            <Button label={t('management.cancel')} disabled={verifying} onClick={cancel} />
          </div>
        </form>
      ) : (
        <div className="settings-section">
          <Callout tone="info" title={t('management.confirm')} />
          {pending.operation === 'organization.update' &&
          pending.purpose !== undefined &&
          pending.purpose !== data.organization?.purpose ? (
            <Callout tone="warning" title={t('management.purpose_reapproval')} />
          ) : null}
          <dl>
            <dt>{t('management.scope')}</dt>
            <dd>
              {scope.tenant} /{' '}
              {draft.operation === 'organization.create'
                ? t('management.new_organization')
                : data.organization?.name || scope.organizationId}{' '}
              {draft.operation === 'project.update'
                ? '/ ' + (data.project?.name || scope.projectId)
                : ''}
            </dd>
            <dt>{t('management.name')}</dt>
            <dd>{pending.name}</dd>
            <dt>{t(organization ? 'management.purpose' : 'management.summary')}</dt>
            <dd className="management-description">
              {pending.purpose ??
                pending.summary ??
                t(
                  draft.operation.endsWith('update')
                    ? 'management.description_unchanged'
                    : 'management.description_omitted'
                )}
            </dd>
          </dl>
          <div className="settings-inline-actions">
            <Button
              label={t(
                busy
                  ? 'management.saving'
                  : notice === 'uncertain' || notice === 'failed'
                    ? 'management.retry'
                    : 'management.confirm_save'
              )}
              variant="primary"
              disabled={busy || verifying}
              onClick={() => void commit()}
            />
            <Button
              label={t('management.cancel')}
              disabled={busy || verifying}
              onClick={() => {
                cancel();
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
