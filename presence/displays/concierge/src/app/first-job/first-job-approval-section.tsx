/**
 * 初めての仕事 approval view (`FirstJobApprovalPanel`), rendered for the page
 * and on its own by the approval tests (test/first-job-approval-client.test.ts),
 * moved from presence-studio `static/first-job-approval.js`. Every string is
 * vocabulary; a decision is an explicit click bound to the displayed digest.
 * Cards are keyed by their digest, so a control displayed for an older digest
 * is never reused for a newer one.
 */
import * as React from 'react';
import { Button, Callout } from '@agent/shared-ui';
import type {
  ApprovalItem,
  FirstJobApprovalPanel,
  RecoveryRequest,
} from './first-job-approval-panel';

const LOGIN_HREF = '/login?next=%2Ffirst-job';

type Text = (key: string) => string;

export function FirstJobApprovalReadiness({
  panel,
  text,
}: {
  panel: FirstJobApprovalPanel;
  text: Text;
}) {
  return <li data-fj="approval-readiness">{text(panel.authKey())}</li>;
}

export function FirstJobApprovalSection({
  panel,
  text,
  locale,
  act,
}: {
  panel: FirstJobApprovalPanel;
  text: Text;
  locale: string;
  /** Runs an action and keeps focus where it can stay (the page's live region otherwise). */
  act: (run: () => Promise<void> | void) => void;
}) {
  const recoveryRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const date = (value: number | string) => new Date(value).toLocaleString(locale);
  // Studio `render(focusRecovery)`: focus stays on the replacement recovery control.
  React.useEffect(() => {
    const key = panel.focusRecovery;
    if (!key) return;
    panel.focusRecovery = null;
    recoveryRefs.current[key]?.focus();
  });
  const control = (id: string, node: React.ReactNode) => (
    <span className="first-job-control" data-fj={id}>
      {node}
    </span>
  );
  const field = (label: string, value: string | number) => (
    <p className="first-job-field">
      <strong>{text(label)}: </strong>
      <span>{value}</span>
    </p>
  );

  const approvalCard = (item: ApprovalItem) => {
    const generation = panel.generation;
    const disabled = !panel.eligible || panel.loading || panel.sending;
    return (
      <article
        key={'approval-' + item.approval_request_id + ':' + item.display_digest}
        className="first-job-card"
      >
        <h3 className="first-job-card__title">{text('approval_title')}</h3>
        <p>{text('approval_effect')}</p>
        <p>{text('approval_validity')}</p>
        {field('approval_id', item.approval_request_id)}
        {field('request', item.request_id)}
        {field('revision', item.revision)}
        {field('scope', item.tenant)}
        {field(
          'format',
          text(item.receipt_format === 'compact' ? 'format_compact' : 'format_readable')
        )}
        {field('approval_destination', text('approval_destination_local'))}
        {field('approval_execution_deadline', date(item.execution_deadline_at))}
        {field('approval_effect_digest', item.display_digest)}
        {field('approval_payload_digest', item.payload_hash)}
        {field('approval_binding_digest', item.effect_binding)}
        <div className="first-job-toolbar">
          {(['approved', 'rejected'] as const).map((decision) => (
            <Button
              key={decision}
              label={text(decision === 'approved' ? 'approval_accept' : 'approval_reject')}
              variant={decision === 'approved' ? 'primary' : 'secondary'}
              disabled={disabled}
              onClick={() => act(() => panel.clickDecision(item, decision, generation))}
            />
          ))}
        </div>
      </article>
    );
  };

  const recoveryCard = (item: RecoveryRequest) => {
    const terminal = item.status === 'terminated_unstarted';
    const key = item.request_id + ':' + item.display_digest;
    const confirming = panel.confirmRecovery === key;
    const generation = panel.generation;
    return (
      <article key={'recovery-' + key} className="first-job-card">
        <h3 className="first-job-card__title">
          {text(terminal ? 'recovery_terminated' : 'recovery_eligible')}
        </h3>
        {field('request', item.request_id)}
        {field('approval_id', item.approval_request_id)}
        {field('revision', item.revision)}
        {field('scope', item.tenant)}
        {field('approval_effect_digest', item.display_digest)}
        <p>{text(terminal ? 'recovery_terminated_detail' : 'recovery_effect')}</p>
        {terminal ? null : (
          <>
            {confirming ? <p>{text('recovery_confirm_detail')}</p> : null}
            <div className="first-job-toolbar">
              {/* A native button: focus returns here when the confirmation opens or closes. */}
              <button
                // Review and confirm are different elements: a control shown
                // before a cancel or a refresh can never act as the other one.
                key={confirming ? 'confirm' : 'review'}
                type="button"
                className="kb-btn kb-btn--secondary"
                ref={(node) => {
                  recoveryRefs.current[key] = node;
                }}
                disabled={!panel.eligible || panel.loading || panel.sending}
                onClick={() => act(() => panel.clickRecovery(item, confirming, generation))}
              >
                {text(confirming ? 'recovery_confirm' : 'recovery_review')}
              </button>
              {confirming ? (
                <Button
                  label={text('recovery_cancel')}
                  variant="secondary"
                  disabled={panel.sending || panel.loading}
                  onClick={() => panel.clickRecoveryCancel(item, generation)}
                />
              ) : null}
            </div>
          </>
        )}
      </article>
    );
  };

  return (
    <section
      className="kb-section first-job-block"
      id="first-job-approval-panel"
      aria-labelledby="first-job-approval-title"
    >
      <h2 className="kb-section__title" id="first-job-approval-title">
        {text('approval_title')}
      </h2>
      <p data-fj="approval-status">{text(panel.statusKey())}</p>
      {panel.error ? (
        <div data-fj="approval-error">
          <Callout tone="warning" title={text(panel.error)} />
        </div>
      ) : null}
      {panel.authStatus === 'authentication_required' ? (
        <div data-fj="approval-signin">
          <Button label={text('approval_signin')} variant="secondary" href={LOGIN_HREF} />
          <p>{text('approval_signin_hint')}</p>
        </div>
      ) : null}
      <div className="first-job-toolbar">
        {control(
          'approval-refresh',
          <Button
            label={text('approval_refresh')}
            variant="secondary"
            disabled={panel.sending || panel.loading || !panel.context}
            onClick={() => act(() => panel.refresh())}
          />
        )}
      </div>
      <div data-fj="approval-items">
        {panel.items.filter((item) => panel.validItem(item)).map(approvalCard)}
        {panel.held.map((item) => (
          <article key={'held-' + item.request_id} className="first-job-card">
            <h3 className="first-job-card__title">{text('approval_held')}</h3>
            {field('request', item.request_id)}
            <p>{text('approval_held_detail')}</p>
          </article>
        ))}
        {panel.recovery.filter((item) => panel.validRecovery(item)).map(recoveryCard)}
      </div>
    </section>
  );
}
