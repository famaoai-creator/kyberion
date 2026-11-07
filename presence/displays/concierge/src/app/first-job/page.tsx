'use client';

import * as React from 'react';
import { Badge, Button, Callout, Disclosure, PageHeader } from '@agent/shared-ui';
import { frontDeskText, type FrontDeskMessageKey } from '../../lib/i18n';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { FirstJobGuide, type FirstJobTask, type ReceiptSlot } from './first-job-controller';
import { FirstJobApprovalReadiness, FirstJobApprovalSection } from './first-job-approval-section';
import './first-job.css';

const SETUP_FIELDS: Record<string, readonly string[]> = {
  profile: ['present', 'missing', 'unavailable'],
  oidc: ['configured', 'configuration_required', 'unavailable'],
  browser_user: ['verified', 'sign_in_required', 'binding_required', 'unavailable'],
  approval_scope: [
    'ready',
    'mapping_required',
    'authentication_required',
    'owner_unavailable',
    'owner_mismatch',
    'tenant_membership_required',
    'unavailable',
  ],
  baseline: ['unchecked'],
  reasoning: ['not_required'],
  advancement: ['not_started', 'review_or_tick', 'running', 'receipt_verified', 'unavailable'],
};
const SETUP_ACTIONS = [
  'inspect_profile',
  'complete_profile',
  'inspect_mapping',
  'configure_login',
  'sign_in',
  'inspect_member_binding',
  'inspect_approval_scope',
  'inspect_baseline',
  'review_or_tick',
  'wait',
  'inspect_execution',
  'refresh',
];
const HISTORY_STATUSES = [
  'awaiting_approval',
  'queued',
  'running',
  'blocked',
  'cancel_requested',
  'uncertain',
  'terminated_unstarted',
];
const LOGIN_HREF = '/login?next=%2Ffirst-job';
const SLOT_LABEL: Record<ReceiptSlot, string> = {
  body: 'body_select',
  left: 'compare_left',
  right: 'compare_right',
};

/**
 * 初めての仕事 (`/first-job`), moved from presence-studio (Kyberion server
 * phase 2): a bounded local diagnostic guide. It sends one fixed first
 * request, shows its held approvals, lets the owner of this machine decide
 * them, offers recovery, and shows the delivered receipt. The state machine
 * is `first-job-controller.ts`; this page only renders it. Every string is
 * vocabulary; a server code is never shown as text.
 */
export default function FirstJobPage() {
  const { locale } = useConciergeI18n();
  const [, setVersion] = React.useState(0);
  const notify = React.useCallback(() => setVersion((value) => value + 1), []);
  const [guide] = React.useState(() => new FirstJobGuide(notify));
  const liveRef = React.useRef<HTMLDivElement | null>(null);
  const text = React.useCallback(
    (key: string, params?: Record<string, string | number>) =>
      frontDeskText(('first_job_' + key) as FrontDeskMessageKey, locale, params),
    [locale]
  );
  const date = (value: number | string) => new Date(value).toLocaleString(locale);

  React.useEffect(() => {
    guide.setLocale(locale);
    notify();
  }, [guide, locale, notify]);
  // Storage, visibility and the first read all depend on the browser: after mount only.
  React.useEffect(() => guide.mount(), [guide]);

  /** Keep focus after an action: if the control is gone or disabled, move it to the status. */
  const act = (run: () => Promise<void> | void) => {
    void Promise.resolve(run()).finally(() =>
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLButtonElement | null;
        if (!active || active === document.body || active.disabled || !active.isConnected)
          liveRef.current?.focus();
      })
    );
  };

  const approval = guide.approval;
  const setup = guide.visibleSetup();
  const tasks = guide.tasks();
  const statusTenant = guide.mounted ? guide.statusHandoffTenant() : null;
  const tenant = guide.diagnosticTenant();
  const canAct = guide.mounted && guide.canAct();
  const terminalHistory = guide.terminalHistory();
  const verifiedArtifacts = guide.verifiedArtifacts();
  const announcement = approval.error
    ? text(approval.error)
    : approval.message
      ? text(approval.message)
      : approval.sending
        ? text('approval_sending')
        : '';

  const setupLine = (field: string) => {
    let value = setup?.[field] ?? null;
    if (value && field === 'advancement' && guide.setupRecoveryBlocked())
      value = { status: 'unavailable', owner: 'operator', next_action: 'inspect_execution' };
    if (field === 'advancement' && (guide.sending || guide.approvalBusy)) value = null;
    const known = Boolean(value && SETUP_FIELDS[field].includes(value.status));
    let content = text('setup_' + field + '_' + (known ? value!.status : 'unknown'));
    if (
      known &&
      ['user', 'operator'].includes(value!.owner) &&
      SETUP_ACTIONS.includes(value!.next_action)
    )
      content +=
        ' ' +
        text('setup_owner_' + value!.owner) +
        ': ' +
        text('setup_action_' + value!.next_action);
    return content;
  };

  /** A control the guide addresses by its Studio id (`data-fj`). */
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

  const historyCard = (task: FirstJobTask) => {
    const artifact = guide.historyArtifact(task)!;
    const verified =
      artifact.verification === 'verified' && /^[a-f0-9]{64}$/.test(artifact.sha256 ?? '');
    const current = guide.safelyTerminated(task)
      ? 'recovery_terminated'
      : verified
        ? guide.observedCurrentness(artifact) === 'latest_verified'
          ? 'latest'
          : 'older'
        : 'requested';
    let status = HISTORY_STATUSES.includes(task.executionStatus ?? '')
      ? task.executionStatus!
      : 'unknown';
    if (verified && task.executionStatus === 'work_completed') status = 'work_completed';
    const target = statusTenant ? guide.statusHandoffTarget(task) : null;
    const revision = guide.revisionTarget(artifact);
    const nextFormat = revision?.format === 'readable' ? 'compact' : 'readable';
    return (
      <article key={task.id} className="first-job-card">
        <h3 className="first-job-card__title">{text('revision') + ' ' + artifact.revision}</h3>
        <Badge label={text(current)} tone={current === 'latest' ? 'success' : 'neutral'} />
        {field(
          'status',
          guide.isHeld(task)
            ? text('approval_held')
            : guide.isParked(task)
              ? text('recovery_eligible')
              : text('status_' + status)
        )}
        {field('request', artifact.requestId)}
        {target ? (
          <p>
            <code className="first-job-code">
              {'pnpm onboarding first-job --tenant ' +
                statusTenant +
                ' --status --request-id ' +
                target.requestId}
            </code>
          </p>
        ) : null}
        {artifact.format === 'compact' || artifact.format === 'readable'
          ? field('format', text('format_' + artifact.format))
          : null}
        {verified ? field('digest', artifact.sha256!) : null}
        {verified &&
        typeof artifact.verifiedAt === 'number' &&
        Number.isFinite(artifact.verifiedAt) &&
        !Number.isNaN(new Date(artifact.verifiedAt).getTime())
          ? field('checked_at', date(artifact.verifiedAt))
          : null}
        {revision ? (
          <div className="first-job-toolbar">
            <Button
              label={text('revise_' + nextFormat)}
              variant="secondary"
              disabled={!canAct}
              onClick={() => act(() => guide.revise(artifact))}
            />
          </div>
        ) : null}
      </article>
    );
  };

  const receiptPane = (slot: ReceiptSlot) => {
    const chosen = guide.selection[slot];
    const artifact = guide.selectedArtifact(chosen);
    const entry = artifact ? guide.receipts[chosen] : undefined;
    const status = guide.receiptStatus(slot);
    const verifiedAt = entry && entry.status === 'ready' ? entry.verifiedAt : artifact?.verifiedAt;
    const id = 'first-job-' + slot + '-select';
    return (
      <div className="first-job-receipt-pane">
        <label htmlFor={id}>{text(SLOT_LABEL[slot])}</label>
        <select
          id={id}
          data-fj={slot + '-select'}
          className="kb-input"
          value={chosen}
          disabled={verifiedArtifacts.length === 0}
          onChange={(event) => guide.selectReceipt(slot, event.target.value)}
        >
          {!chosen || !artifact ? (
            <option value={chosen}>{text(chosen ? 'body_unavailable' : 'body_empty')}</option>
          ) : null}
          {verifiedArtifacts.map((item) => (
            <option key={guide.receiptKey(item)} value={guide.receiptKey(item)}>
              {text('revision') +
                ' ' +
                item.revision +
                ' · ' +
                text('format_' + item.format) +
                ' · ' +
                item.requestId +
                ' · ' +
                item.sha256}
            </option>
          ))}
        </select>
        <div className="first-job-receipt-metadata" data-fj={slot + '-metadata'}>
          {artifact ? (
            <>
              {field('revision', artifact.revision)}
              {field('request', artifact.requestId)}
              {field('format', text('format_' + artifact.format))}
              {field('digest', artifact.sha256!)}
              <p>
                {text(
                  guide.observedCurrentness(artifact) === 'latest_verified' ? 'latest' : 'older'
                )}
              </p>
              {typeof verifiedAt === 'number' &&
              Number.isFinite(verifiedAt) &&
              !Number.isNaN(new Date(verifiedAt).getTime())
                ? field('checked_at', date(verifiedAt))
                : null}
            </>
          ) : null}
        </div>
        <p className="first-job-meta" data-fj={slot + '-status'}>
          {text('body_' + status)}
        </p>
        {status === 'ready' && entry ? (
          // The exact verified bytes as text: never parsed, prettified or injected as HTML.
          <pre
            className="first-job-receipt-body"
            data-fj={slot + '-content'}
            tabIndex={0}
            aria-label={text(SLOT_LABEL[slot])}
          >
            {entry.body}
          </pre>
        ) : null}
      </div>
    );
  };

  const historyRows = tasks.filter((task) => {
    const artifact = guide.historyArtifact(task);
    return (
      artifact &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(artifact.requestId) &&
      Number.isSafeInteger(artifact.revision)
    );
  });

  return (
    <div className="kb-page first-job-page" data-width="wide">
      <PageHeader title={text('title')} subtitle={text('summary')} />

      <section className="kb-section first-job-block" aria-labelledby="first-job-readiness-title">
        <h2 className="kb-section__title" id="first-job-readiness-title">
          {text('readiness')}
        </h2>
        <p>{text('prerequisites')}</p>
        <p>{text('identity_explanation')}</p>
        <h3 className="first-job-subheading">{text('next_title')}</h3>
        <p data-fj="next">{text(guide.mounted ? guide.nextKey() : 'next_loading')}</p>
        <Disclosure summary={text('setup_details')}>
          <ul className="first-job-list">
            {Object.keys(SETUP_FIELDS).map((name) => (
              <li key={name} data-fj={'setup-' + name}>
                {setupLine(name)}
              </li>
            ))}
            <FirstJobApprovalReadiness panel={approval} text={text} />
          </ul>
        </Disclosure>
        {guide.signInVisible() ? (
          <p data-fj="setup-signin">
            <a href={LOGIN_HREF}>{text('approval_signin')}</a>
          </p>
        ) : null}
        <p data-fj="readiness">{text(guide.readinessKey())}</p>
        {tenant ? <p data-fj="scope">{text('scope') + ': ' + tenant}</p> : null}
        {guide.loaded && !guide.ready() ? (
          <div className="first-job-setup" data-fj="setup">
            <h3 className="first-job-subheading">{text('setup_title')}</h3>
            <p>{text('setup_preview')}</p>
            <p>
              <code className="first-job-code">
                pnpm onboarding first-job --tenant &lt;test-tenant&gt;
              </code>
            </p>
            <p>{text('setup_apply')}</p>
            <p>
              <code className="first-job-code">
                pnpm onboarding first-job --tenant &lt;test-tenant&gt; --apply --accept-plan
                &lt;digest&gt;
              </code>
            </p>
          </div>
        ) : null}
      </section>

      <section className="kb-section first-job-block" aria-labelledby="first-job-steps-title">
        <h2 className="kb-section__title" id="first-job-steps-title">
          {text('steps')}
        </h2>
        <p>{text('step_start')}</p>
        <p>{text('step_review')}</p>
        <p>{text('step_receipt')}</p>
        <p>{text('step_revise')}</p>
        <div className="first-job-toolbar">
          {control(
            'start',
            <Button
              label={text('start')}
              variant="primary"
              disabled={!canAct || tasks.length > 0 || guide.messages().length > 0}
              onClick={() => act(() => guide.start())}
            />
          )}
          {terminalHistory
            ? control(
                'restart',
                <Button
                  label={text('restart')}
                  variant="primary"
                  disabled={!(guide.mounted && guide.canRestart())}
                  onClick={() => act(() => guide.restart())}
                />
              )
            : null}
          {control(
            'refresh',
            <Button
              label={text('refresh')}
              variant="secondary"
              disabled={!guide.mounted || guide.sending || guide.approvalBusy || guide.refreshing}
              onClick={() => act(() => guide.load())}
            />
          )}
          {tasks.some((task) => task.executionStatus === 'awaiting_approval')
            ? control(
                'approval',
                <Button
                  label={text('approval')}
                  variant="secondary"
                  href="#first-job-approval-panel"
                />
              )
            : null}
          {guide.pending && guide.pending.retrySafe
            ? control(
                'retry',
                <Button
                  label={text('retry')}
                  variant="secondary"
                  disabled={guide.retryDisabled()}
                  onClick={() => act(() => guide.retry())}
                />
              )
            : null}
        </div>
        {terminalHistory ? <p data-fj="restart-note">{text('restart_detail')}</p> : null}
        {statusTenant && tasks.some((task) => guide.statusHandoffTarget(task)) ? (
          <p data-fj="advance">{text('advance')}</p>
        ) : null}
        {/* The page's one live region: real outcomes only, never the polling cycle. */}
        <div
          ref={liveRef}
          className="first-job-live"
          role="status"
          aria-live="polite"
          tabIndex={-1}
        >
          <p data-fj="status">{text(guide.mounted ? guide.statusKey() : 'loading')}</p>
          {guide.errorKey ? (
            <div data-fj="error">
              <Callout tone="warning" title={text(guide.errorKey)} />
            </div>
          ) : null}
          {guide.refusal ? (
            <Callout tone="danger" title={frontDeskText(guide.refusal, locale)} />
          ) : null}
          {announcement ? <span className="kb-visually-hidden">{announcement}</span> : null}
        </div>
        <p className="first-job-meta" data-fj="last-checked">
          {text('last_checked') +
            ': ' +
            (guide.lastChecked === null ? text('not_checked') : date(guide.lastChecked))}
        </p>
        <p className="first-job-meta" data-fj="refresh-mode">
          {text(guide.mounted ? guide.refreshModeKey() : 'refresh_paused')}
        </p>
        {guide.networkError ? (
          <div data-fj="refresh-error">
            <Callout tone="warning" title={text('refresh_failed')} />
          </div>
        ) : null}
      </section>

      <FirstJobApprovalSection panel={approval} text={text} locale={locale} act={act} />

      <section className="kb-section first-job-block" aria-labelledby="first-job-body-title">
        <h2 className="kb-section__title" id="first-job-body-title">
          {text('body_title')}
        </h2>
        <p>{text('body_notice')}</p>
        {receiptPane('body')}
        <div className="first-job-toolbar">
          {control(
            'body-retry',
            <Button
              label={text('body_retry')}
              variant="secondary"
              disabled={guide.receiptRetryDisabled()}
              onClick={() => guide.retryReceipts()}
            />
          )}
        </div>
      </section>

      <section className="kb-section first-job-block" aria-labelledby="first-job-compare-title">
        <h2 className="kb-section__title" id="first-job-compare-title">
          {text('compare_title')}
        </h2>
        <p>{text('compare_notice')}</p>
        <p data-fj="compare-status">{text(guide.comparisonKey())}</p>
        <div className="first-job-comparison">
          {receiptPane('left')}
          {receiptPane('right')}
        </div>
      </section>

      <section className="kb-section first-job-block" aria-labelledby="first-job-history-title">
        <h2 className="kb-section__title" id="first-job-history-title">
          {text('history')}
        </h2>
        <p>{text('revision_notice')}</p>
        <div aria-busy={guide.refreshing} data-fj="history">
          {historyRows.length ? historyRows.map(historyCard) : <p>{text('empty')}</p>}
        </div>
      </section>
    </div>
  );
}
