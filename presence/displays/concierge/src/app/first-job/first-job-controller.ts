/**
 * 初めての仕事 (`/first-job`) guide state, moved from presence-studio
 * `static/first-job.js` and `static/first-job-approval.js` (Kyberion server
 * phase 2). The state machine is ported unchanged; only the DOM writes became
 * a `notify()` the React page renders from.
 *
 * Bounded local diagnostic guide. GET/reload never sends or approves work.
 * Server scope is authoritative; neither tenant nor free text is submitted.
 * Receipt identities are display data, never approval authority. Every
 * decision is an explicit click bound to the latest server display digest;
 * cookie verification and effect authorization stay server-side.
 *
 * Browser-only: construct freely (no browser access), call `mount()` after
 * the page has mounted.
 */
import {
  FirstJobApprovalPanel,
  HASH,
  SESSION,
  UUID,
  WAIT_MS,
  readJson,
  submitMutation,
  type FirstJobArtifact,
  type FirstJobMessage,
  type FirstJobSetup,
  type FirstJobSnapshot,
  type FirstJobTask,
  type HeldRequest,
  type JsonResult,
  type RecoveryRequest,
} from './first-job-approval-panel';
import type { FrontDeskMessageKey } from '../../lib/i18n';

export const FIRST_JOB_STORAGE_KEY = 'kyberion.first-job.v1';

/**
 * The gate refusals a person can meet on Concierge, shown in the page's own
 * words. Every other code already maps to one of the guide's states.
 */
const REFUSAL_KEYS: Readonly<Record<string, FrontDeskMessageKey>> = {
  first_job_access_denied: 'first_job_access_denied',
  first_job_origin_denied: 'first_job_origin_denied',
  first_job_rate_limited: 'first_job_rate_limited',
};
function refusalKey(body: unknown): FrontDeskMessageKey | null {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && Object.hasOwn(REFUSAL_KEYS, code) ? REFUSAL_KEYS[code] : null;
}

export type {
  ApprovalItem,
  FirstJobArtifact,
  FirstJobTask,
  RecoveryRequest,
} from './first-job-approval-panel';

interface Pending {
  body: {
    action: 'start' | 'revise';
    request_id: string;
    session_id: string;
    locale?: string;
    artifactRevision?: { requestId: string; revision: number; sha256: string; format: string };
  };
  retrySafe: boolean;
  checked: boolean;
}
interface ReceiptEntry {
  status: 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'failed';
  body: string | null;
  controller: AbortController | null;
  currentness?: string;
  verifiedAt?: number;
}
export type ReceiptSlot = 'body' | 'left' | 'right';
/** The guide itself (Studio `first-job.js`). */
export class FirstJobGuide {
  readonly approval: FirstJobApprovalPanel;
  snapshot: FirstJobSnapshot | null = null;
  setup: FirstJobSetup | null = null;
  sessionId: string | null = null;
  pending: Pending | null = null;
  storageReady = false;
  loaded = false;
  sending = false;
  approvalReady = false;
  approvalBusy = false;
  heldRequests: HeldRequest[] = [];
  recoveryRequests: RecoveryRequest[] = [];
  refreshing = false;
  mounted = false;
  errorKey: string | null = null;
  /** A coded gate refusal from the last answer, as a vocabulary key. */
  refusal: FrontDeskMessageKey | null = null;
  refreshSequence = 0;
  approvalSequence = 0;
  refreshController: AbortController | null = null;
  pollTimer: number | null = null;
  pollFailures = 0;
  readBlocked = false;
  pageActive = true;
  lastChecked: number | null = null;
  networkError = false;
  receiptScope: string | null = null;
  receiptEpoch = 0;
  receiptAccessError: string | null = null;
  resumeRead = false;
  receipts: Record<string, ReceiptEntry> = Object.create(null);
  selection: Record<ReceiptSlot, string> = { body: '', left: '', right: '' };
  locale = '';
  private detach: Array<() => void> = [];

  constructor(private readonly notify: () => void) {
    this.approval = new FirstJobApprovalPanel(notify);
  }

  // --- storage ---------------------------------------------------------------
  private validArtifact(value: FirstJobArtifact | undefined | null): value is FirstJobArtifact {
    return Boolean(
      value &&
      UUID.test(value.requestId) &&
      HASH.test(value.sha256 ?? '') &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      value.revision <= 64 &&
      (value.format === 'compact' || value.format === 'readable')
    );
  }

  private parsePending(value: unknown): Pending | null {
    if (value == null) return null;
    const row = value as { body?: Pending['body'] & Record<string, any>; retrySafe?: unknown };
    if (!row || !row.body) throw new Error('invalid_pending');
    const body = row.body;
    if (
      !UUID.test(body.request_id) ||
      !SESSION.test(body.session_id) ||
      (body.action !== 'start' && body.action !== 'revise') ||
      (body.action === 'revise' && !this.validArtifact(body.artifactRevision as FirstJobArtifact))
    )
      throw new Error('invalid_pending');
    const clean: Pending['body'] = {
      action: body.action,
      request_id: body.request_id,
      session_id: body.session_id,
    };
    if (typeof body.locale === 'string') clean.locale = body.locale;
    if (body.action === 'revise' && body.artifactRevision)
      clean.artifactRevision = {
        requestId: body.artifactRevision.requestId,
        revision: body.artifactRevision.revision,
        sha256: body.artifactRevision.sha256,
        format: body.artifactRevision.format,
      };
    return { body: clean, retrySafe: row.retrySafe === true, checked: false };
  }

  private save(): boolean {
    if (!this.storageReady) {
      this.errorKey = 'storage_required';
      return false;
    }
    try {
      window.sessionStorage.setItem(
        FIRST_JOB_STORAGE_KEY,
        JSON.stringify({ sessionId: this.sessionId, pending: this.pending })
      );
      return true;
    } catch {
      this.storageReady = false;
      this.errorKey = 'storage_required';
      return false;
    }
  }

  private restore(): void {
    try {
      const raw = window.sessionStorage.getItem(FIRST_JOB_STORAGE_KEY);
      const stored = raw ? JSON.parse(raw) : {};
      if (!stored || typeof stored !== 'object' || Array.isArray(stored))
        throw new Error('invalid_storage');
      this.sessionId = SESSION.test(stored.sessionId) ? stored.sessionId : null;
      this.pending = this.parsePending(stored.pending);
      this.storageReady = typeof window.crypto?.randomUUID === 'function';
      if (!this.save()) return;
      if (this.pending) this.errorKey = this.pending.retrySafe ? 'retry_safe' : 'uncertain';
      if (!this.storageReady) this.errorKey = 'storage_required';
    } catch {
      // Never discard an unreadable pending request and create a replacement.
      this.storageReady = false;
      this.errorKey = 'storage_required';
    }
  }

  // --- derived state ---------------------------------------------------------
  tasks(): FirstJobTask[] {
    return this.snapshot && Array.isArray(this.snapshot.tasks) ? this.snapshot.tasks : [];
  }
  messages(): FirstJobMessage[] {
    return this.snapshot && Array.isArray(this.snapshot.messages) ? this.snapshot.messages : [];
  }
  ready(): boolean {
    const readiness = this.snapshot?.readiness;
    return Boolean(
      this.loaded &&
      readiness &&
      readiness.ready === true &&
      readiness.status === 'diagnostic_mapping_ready'
    );
  }
  uncertainWork(): boolean {
    return this.tasks().some(
      (task) =>
        task.turnState === 'uncertain' ||
        task.executionStatus === 'uncertain' ||
        task.artifact?.currentness === 'requested_unknown'
    );
  }
  busy(): boolean {
    return Boolean(
      this.sending ||
      this.approvalBusy ||
      this.refreshing ||
      this.uncertainWork() ||
      this.pending ||
      (this.snapshot && this.snapshot.pending > 0) ||
      this.tasks().some(
        (task) =>
          ['awaiting_approval', 'queued', 'running'].includes(task.executionStatus ?? '') ||
          task.turnState === 'pending' ||
          task.artifact?.currentness === 'requested_pending'
      )
    );
  }
  isHeld(task: FirstJobTask): boolean {
    return Boolean(
      task.artifact &&
      this.heldRequests.some((held) => held.request_id === task.artifact!.requestId)
    );
  }
  recoveryFor(task: FirstJobTask): RecoveryRequest | undefined {
    return this.recoveryRequests.find(
      (item) =>
        item.request_id === task.id &&
        (!task.artifact ||
          (item.request_id === task.artifact.requestId && item.revision === task.artifact.revision))
    );
  }
  isParked(task: FirstJobTask): boolean {
    const recovery = this.recoveryFor(task);
    return this.isHeld(task) || Boolean(recovery && recovery.status === 'eligible');
  }
  safelyTerminated(task: FirstJobTask): boolean {
    const recovery = this.recoveryFor(task);
    return Boolean(
      recovery &&
      recovery.status === 'terminated_unstarted' &&
      task.executionStatus === 'terminated_unstarted' &&
      task.turnState === 'settled' &&
      (!task.artifact ||
        (task.artifact.verification !== 'verified' &&
          !['requested_pending', 'requested_unknown'].includes(task.artifact.currentness ?? '')))
    );
  }
  canRestart(): boolean {
    const ids = this.tasks().map((task) => task.id);
    return (
      this.canAct() &&
      this.tasks().length > 0 &&
      this.tasks().every((task) => this.safelyTerminated(task)) &&
      this.recoveryRequests.length === this.tasks().length &&
      this.messages().every(
        (message) =>
          message &&
          typeof message.id === 'string' &&
          ['user', 'secretary'].includes(message.role) &&
          ids.includes(message.id.replace(/-(user|secretary)$/, '')) &&
          (!message.artifact ||
            (ids.includes(message.artifact.requestId) && message.artifact.canRevise !== true))
      )
    );
  }
  otherUnfinishedWork(): boolean {
    return this.tasks().some(
      (task) =>
        !this.isParked(task) &&
        !this.safelyTerminated(task) &&
        (task.turnState === 'pending' ||
          task.turnState === 'uncertain' ||
          ['awaiting_approval', 'queued', 'running', 'uncertain'].includes(
            task.executionStatus ?? ''
          ) ||
          !task.artifact ||
          task.artifact.verification !== 'verified')
    );
  }
  canAct(): boolean {
    return (
      this.visible() &&
      this.ready() &&
      this.approvalReady &&
      !this.heldRequests.length &&
      !this.recoveryRequests.some((item) => item.status === 'eligible') &&
      this.storageReady &&
      Boolean(this.sessionId) &&
      !this.busy()
    );
  }
  revisionTarget(artifact: FirstJobArtifact | null | undefined): FirstJobArtifact | null {
    if (
      !this.validArtifact(artifact) ||
      artifact.verification !== 'verified' ||
      this.observedCurrentness(artifact) !== 'latest_verified'
    )
      return null;
    const match = this.messages().find((message) => {
      const receipt = message.artifact;
      return (
        message.role === 'secretary' &&
        this.validArtifact(receipt) &&
        receipt.canRevise === true &&
        receipt.requestId === artifact.requestId &&
        receipt.revision === artifact.revision &&
        receipt.sha256 === artifact.sha256 &&
        receipt.format === artifact.format
      );
    });
    return match ? match.artifact! : null;
  }
  observedCurrentness(artifact: FirstJobArtifact): string | undefined {
    const entry = this.receipts[this.receiptKey(artifact)];
    return artifact.currentness === 'older_verified' ||
      (entry && entry.status === 'ready' && entry.currentness === 'older_verified')
      ? 'older_verified'
      : artifact.currentness;
  }
  receiptKey(artifact: FirstJobArtifact): string {
    return artifact.requestId + ':' + artifact.revision + ':' + artifact.sha256;
  }
  verifiedArtifacts(): FirstJobArtifact[] {
    const found = new Set<string>();
    return this.tasks()
      .map((task) => task.artifact)
      .filter((artifact): artifact is FirstJobArtifact => {
        if (
          !this.validArtifact(artifact) ||
          artifact.verification !== 'verified' ||
          !['latest_verified', 'older_verified'].includes(artifact.currentness ?? '')
        )
          return false;
        const key = this.receiptKey(artifact);
        if (found.has(key)) return false;
        found.add(key);
        return true;
      })
      .sort((a, b) => a.revision - b.revision);
  }
  selectedArtifact(key: string): FirstJobArtifact | undefined {
    return this.verifiedArtifacts().find((artifact) => this.receiptKey(artifact) === key);
  }
  visible(): boolean {
    // Never during server rendering or before mount (no hydration mismatch).
    if (!this.mounted) return false;
    return this.pageActive && document.visibilityState !== 'hidden' && document.hidden !== true;
  }
  progressing(): boolean {
    const readiness = this.snapshot?.readiness;
    return Boolean(
      readiness &&
      readiness.ready === true &&
      readiness.status === 'diagnostic_mapping_ready' &&
      !this.readBlocked &&
      !this.pending &&
      !this.uncertainWork() &&
      this.tasks().some(
        (task) => !this.isParked(task) && ['queued', 'running'].includes(task.executionStatus ?? '')
      )
    );
  }
  historyArtifact(task: FirstJobTask): FirstJobArtifact | null {
    if (task.artifact) return task.artifact;
    const recovery = this.recoveryFor(task);
    return this.safelyTerminated(task) && recovery
      ? { requestId: task.id, revision: recovery.revision }
      : null;
  }
  diagnosticTenant(): string | null {
    const scope = this.snapshot?.scope;
    const tenant = scope?.tenant;
    // Mirror the canonical tenant primitive; display data is never authority.
    return scope &&
      scope.tier === 'public' &&
      typeof tenant === 'string' &&
      tenant.trim() === tenant &&
      /^[a-z][a-z0-9-]{1,30}$/.test(tenant) &&
      !['public', 'confidential', 'personal', 'shared'].includes(tenant)
      ? tenant
      : null;
  }
  statusHandoffTenant(): string | null {
    return this.visible() &&
      this.ready() &&
      this.approvalReady &&
      (!this.setup ||
        (this.setup.mapping &&
          this.setup.mapping.status === 'diagnostic_mapping_ready' &&
          this.setup.advancement)) &&
      !this.sending &&
      !this.approvalBusy &&
      !this.refreshing &&
      !this.resumeRead &&
      !this.networkError &&
      !this.readBlocked &&
      !this.pending &&
      typeof this.sessionId === 'string' &&
      this.sessionId.length === 74 &&
      SESSION.test(this.sessionId) &&
      this.snapshot?.sessionId === this.sessionId
      ? this.diagnosticTenant()
      : null;
  }
  statusHandoffTarget(task: FirstJobTask): { requestId: string; revision: number } | null {
    const artifact = this.historyArtifact(task);
    if (
      !task ||
      typeof task.id !== 'string' ||
      task.id.length !== 36 ||
      !UUID.test(task.id) ||
      !artifact ||
      typeof artifact.requestId !== 'string' ||
      artifact.requestId !== task.id ||
      !UUID.test(artifact.requestId) ||
      !Number.isSafeInteger(artifact.revision) ||
      artifact.revision < 1 ||
      artifact.revision > 64 ||
      this.tasks().filter(
        (item) => item && (item.id === task.id || item.artifact?.requestId === task.id)
      ).length !== 1
    )
      return null;
    return { requestId: task.id, revision: artifact.revision };
  }
  setupRecoveryBlocked(): boolean {
    return (
      this.heldRequests.length > 0 ||
      this.recoveryRequests.some((item) => item.status === 'eligible')
    );
  }

  // --- receipts --------------------------------------------------------------
  private clearReceipts(resetSelection: boolean): void {
    this.receiptEpoch++;
    for (const key of Object.keys(this.receipts)) this.receipts[key].controller?.abort();
    this.receipts = Object.create(null);
    if (resetSelection) this.selection = { body: '', left: '', right: '' };
  }
  private invalidateReadAccess(reason: string): void {
    this.readBlocked = true;
    this.loaded = false;
    this.snapshot = null;
    this.setup = null;
    this.receiptAccessError = reason;
    this.clearReceipts(false);
    this.refreshSequence++;
    this.refreshController?.abort();
    this.refreshController = null;
    this.refreshing = false;
    this.resumeRead = false;
    this.networkError = true;
    this.errorKey = this.pending ? 'uncertain' : 'load_failed';
    this.invalidateApproval();
    this.stopPolling();
    this.render();
  }
  private syncReceipts(): void {
    const scope = JSON.stringify([this.sessionId, this.snapshot?.scope || null]);
    if (scope !== this.receiptScope) {
      this.clearReceipts(true);
      this.receiptScope = scope;
    }
    const artifacts = this.verifiedArtifacts();
    // Defaults apply only to empty selections. A refresh never moves a chosen revision.
    if (!this.selection.body && artifacts.length)
      this.selection.body = this.receiptKey(
        artifacts.find((artifact) => artifact.currentness === 'latest_verified') ||
          artifacts[artifacts.length - 1]
      );
    if (artifacts.length > 1) {
      if (!this.selection.left) this.selection.left = this.receiptKey(artifacts[0]);
      if (!this.selection.right)
        this.selection.right = this.receiptKey(artifacts[artifacts.length - 1]);
    }
    for (const key of Object.keys(this.receipts)) {
      if (!this.selectedArtifact(key)) {
        this.receipts[key].controller?.abort();
        delete this.receipts[key];
      }
    }
    this.loadSelectedReceipts(false);
  }
  private readReceipt(key: string): void {
    const artifact = this.selectedArtifact(key);
    if (!artifact || !SESSION.test(this.sessionId ?? '') || this.receipts[key]) return;
    const sessionId = this.sessionId!;
    const epoch = this.receiptEpoch;
    const entry: ReceiptEntry = {
      status: 'loading',
      body: null,
      controller: typeof AbortController === 'function' ? new AbortController() : null,
    };
    this.receipts[key] = entry;
    const query = new URLSearchParams();
    query.set('session_id', sessionId);
    query.set('request_id', artifact.requestId);
    query.set('revision', String(artifact.revision));
    query.set('sha256', artifact.sha256!);
    const current = () =>
      epoch === this.receiptEpoch &&
      this.sessionId === sessionId &&
      this.receipts[key] === entry &&
      Boolean(this.selectedArtifact(key));
    this.fetchJson(
      '/api/first-job/artifact?' + query.toString(),
      { cache: 'no-store' },
      entry.controller
    )
      .then((result) => {
        if (!current()) return;
        const receipt = result.body?.artifact as
          (FirstJobArtifact & { body?: unknown }) | undefined;
        if (!result.ok) {
          if (result.status === 401 || result.status === 403) {
            this.refusal = refusalKey(result.body);
            this.invalidateReadAccess('forbidden');
            return;
          }
          entry.status = result.status === 404 ? 'unavailable' : 'failed';
          return;
        }
        if (
          !result.body.ok ||
          result.body.sessionId !== sessionId ||
          !this.validArtifact(receipt) ||
          this.receiptKey(receipt) !== key ||
          receipt.format !== artifact.format ||
          receipt.verification !== 'verified' ||
          !['latest_verified', 'older_verified'].includes(receipt.currentness ?? '') ||
          typeof receipt.verifiedAt !== 'number' ||
          !Number.isFinite(receipt.verifiedAt) ||
          typeof receipt.body !== 'string'
        ) {
          entry.status = 'unavailable';
          return;
        }
        // The server verifies the bytes. Keep the exact string, never parse, prettify or inject HTML.
        entry.body = receipt.body as string;
        entry.currentness = receipt.currentness;
        entry.verifiedAt = receipt.verifiedAt;
        entry.status = 'ready';
      })
      .catch(() => {
        if (current()) entry.status = 'failed';
      })
      .finally(() => {
        if (current()) this.render();
      });
  }
  loadSelectedReceipts(retry: boolean): void {
    for (const slot of Object.keys(this.selection) as ReceiptSlot[]) {
      const key = this.selection[slot];
      const entry = this.receipts[key];
      if (retry && entry && entry.status !== 'ready' && entry.status !== 'loading')
        delete this.receipts[key];
      this.readReceipt(key);
    }
  }
  receiptStatus(slot: ReceiptSlot): string {
    const key = this.selection[slot];
    const artifact = this.selectedArtifact(key);
    const entry = artifact && this.receipts[key];
    return !key
      ? 'empty'
      : !artifact
        ? this.receiptAccessError || 'unavailable'
        : entry
          ? entry.status
          : 'loading';
  }
  comparisonKey(): string {
    const artifacts = this.verifiedArtifacts();
    const left = this.selectedArtifact(this.selection.left) && this.receipts[this.selection.left];
    const right =
      this.selectedArtifact(this.selection.right) && this.receipts[this.selection.right];
    return artifacts.length < 2
      ? 'compare_empty'
      : this.selection.left === this.selection.right
        ? 'compare_same_version'
        : left && right && left.status === 'ready' && right.status === 'ready'
          ? left.body === right.body
            ? 'compare_same'
            : 'compare_different'
          : 'compare_wait';
  }
  receiptRetryDisabled(): boolean {
    return (
      this.readBlocked ||
      !(Object.keys(this.selection) as ReceiptSlot[]).some((slot) => {
        const key = this.selection[slot];
        const entry = this.selectedArtifact(key) && this.receipts[key];
        return entry && entry.status !== 'ready' && entry.status !== 'loading';
      })
    );
  }
  selectReceipt(slot: ReceiptSlot, key: string): void {
    if (!this.selectedArtifact(key)) return;
    this.selection[slot] = key;
    this.loadSelectedReceipts(false);
    this.notify();
  }
  retryReceipts(): void {
    this.loadSelectedReceipts(true);
    this.notify();
  }

  // --- view keys (Studio `render`) -------------------------------------------
  readinessKey(): string {
    let readiness = this.snapshot?.readiness;
    const mapping = this.setup?.mapping;
    if (this.setup)
      readiness = mapping
        ? { status: mapping.status, ready: mapping.status === 'diagnostic_mapping_ready' }
        : { status: 'mapping_unavailable', ready: false };
    let key =
      !this.loaded && !mapping
        ? 'loading'
        : readiness && readiness.status === 'diagnostic_mapping_ready' && readiness.ready === true
          ? 'ready'
          : [
                'mapping_missing',
                'mapping_mismatch',
                'mapping_ambiguous',
                'mapping_unavailable',
                'mapping_changed',
              ].includes(readiness?.status ?? '')
            ? readiness!.status
            : 'mapping_unavailable';
    if (this.refreshing || this.resumeRead || !this.visible()) key = 'loading';
    else if (!this.loaded && !mapping) key = 'mapping_unavailable';
    return key;
  }
  statusKey(): string {
    const verified = this.tasks().some(
      (task) => task.artifact?.verification === 'verified' && HASH.test(task.artifact.sha256 ?? '')
    );
    return this.sending
      ? 'wait'
      : !this.loaded
        ? this.refreshing
          ? 'loading'
          : this.errorKey || 'load_failed'
        : this.pending
          ? 'uncertain'
          : this.heldRequests.length && !this.otherUnfinishedWork()
            ? 'approval_held'
            : this.uncertainWork()
              ? 'uncertain'
              : this.busy()
                ? 'pending'
                : verified
                  ? 'verified'
                  : this.tasks().length
                    ? this.canRestart()
                      ? 'recovery_terminated'
                      : 'recorded'
                    : 'empty';
  }
  refreshModeKey(): string {
    return !this.visible()
      ? 'refresh_hidden'
      : this.progressing()
        ? this.networkError
          ? 'refresh_backoff'
          : 'refresh_active'
        : 'refresh_paused';
  }
  /** The status-only setup projection shown, or null (Studio `renderSetup`). */
  visibleSetup(): FirstJobSetup | null {
    return (this.visible() && !this.refreshing && !this.networkError && this.setup) || null;
  }
  nextKey(): string {
    const setup = this.visibleSetup();
    let nextKey =
      this.networkError || this.readBlocked
        ? 'next_unavailable'
        : !this.loaded || this.refreshing
          ? 'next_loading'
          : 'next_review';
    if (setup && !this.readBlocked) {
      const oidc = setup.oidc?.status;
      const user = setup.browser_user?.status;
      const approval = setup.approval_scope?.status;
      const mapping = setup.mapping?.status;
      const advancement = setup.advancement?.status;
      nextKey = !this.storageReady
        ? 'storage_required'
        : this.setupRecoveryBlocked()
          ? 'next_recovery'
          : this.pending || this.sending || this.approvalBusy
            ? 'next_pending'
            : advancement === 'running'
              ? 'next_running'
              : advancement === 'receipt_verified'
                ? 'next_result'
                : advancement === 'review_or_tick' || this.otherUnfinishedWork()
                  ? 'next_pending'
                  : oidc === 'configuration_required'
                    ? 'next_signin_setup'
                    : oidc === 'configured' && user === 'sign_in_required'
                      ? 'next_signin'
                      : user === 'binding_required'
                        ? 'next_account'
                        : mapping && mapping !== 'diagnostic_mapping_ready'
                          ? 'next_mapping'
                          : approval === 'ready' && this.canAct()
                            ? 'next_ready'
                            : 'next_review';
    }
    return nextKey;
  }
  signInVisible(): boolean {
    const setup = this.visibleSetup();
    return Boolean(
      setup &&
      setup.oidc?.status === 'configured' &&
      setup.browser_user?.status === 'sign_in_required'
    );
  }
  terminalHistory(): boolean {
    return (
      this.tasks().length > 0 &&
      this.tasks().every((task) => task.executionStatus === 'terminated_unstarted')
    );
  }
  retryDisabled(): boolean {
    return (
      !this.pending ||
      !this.pending.retrySafe ||
      !this.pending.checked ||
      !this.ready() ||
      !this.approvalReady ||
      !this.storageReady ||
      this.sending ||
      this.refreshing
    );
  }

  // --- polling ---------------------------------------------------------------
  private stopPolling(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  private schedulePolling(): void {
    if (
      !this.visible() ||
      !this.progressing() ||
      this.sending ||
      this.approvalBusy ||
      this.refreshing
    ) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setTimeout(
      () => {
        this.pollTimer = null;
        if (this.visible() && this.progressing()) void this.refresh();
      },
      Math.min(5000 * Math.pow(2, this.pollFailures), 60000)
    );
  }
  private suspendReads(force?: boolean): void {
    this.stopPolling();
    const recheck =
      force ||
      this.refreshing ||
      this.recoveryRequests.length > 0 ||
      this.setup ||
      (this.approvalReady &&
        this.diagnosticTenant() &&
        this.tasks().some((task) => this.statusHandoffTarget(task)));
    if (recheck) this.resumeRead = true;
    this.setup = null;
    if (this.refreshing) {
      this.refreshSequence++;
      this.refreshController?.abort();
      this.refreshController = null;
      this.refreshing = false;
    }
    // Preserve an in-flight decision callback; clearing guidance does not cancel a mutation.
    if (recheck && !this.approvalBusy) this.invalidateApproval();
    this.render();
  }
  private render(): void {
    if (!this.mounted) return;
    this.notify();
    this.schedulePolling();
  }

  // --- network ---------------------------------------------------------------
  private fetchJson(
    url: string,
    options: RequestInit,
    controller?: AbortController | null
  ): Promise<JsonResult> {
    if (options.method === 'POST') {
      // Bound the UI wait, never the server effect. A lost response is unknown,
      // not cancelled or safe to replay; late responses cannot change that state.
      return submitMutation(url, options);
    }
    const readController =
      controller || (typeof AbortController === 'function' ? new AbortController() : null);
    let timer: number | undefined;
    let onAbort: () => void = () => undefined;
    return new Promise<JsonResult>((resolve, reject) => {
      onAbort = () => reject(new Error('read_aborted'));
      if (readController) readController.signal.addEventListener('abort', onAbort, { once: true });
      timer = window.setTimeout(() => {
        reject(new Error('read_timeout'));
        readController?.abort();
      }, WAIT_MS);
      readJson(url, {
        ...options,
        ...(readController ? { signal: readController.signal } : {}),
      }).then(resolve, reject);
    }).finally(() => {
      window.clearTimeout(timer);
      readController?.signal.removeEventListener('abort', onAbort);
    });
  }
  private applySnapshot(body: FirstJobSnapshot): void {
    if (!body || !body.readiness || !Array.isArray(body.tasks) || !Array.isArray(body.messages))
      throw new Error('invalid_snapshot');
    this.snapshot = body;
    // Keep only the status-only setup projection apart from protected request history.
    this.setup = body.setup || null;
    this.loaded = true;
    this.receiptAccessError = null;
    this.refusal = null;
    if (SESSION.test(body.sessionId ?? '')) this.sessionId = body.sessionId!;
    if (this.pending) {
      const requestId = this.pending.body.request_id;
      if (this.tasks().some((task) => task.artifact?.requestId === requestId)) this.pending = null;
      else this.pending.checked = true;
    }
    this.save();
    this.syncReceipts();
  }
  private checkApproval(): Promise<void> {
    this.approvalReady = false;
    const sequence = ++this.approvalSequence;
    const check = this.approval.check({
      snapshot: this.snapshot,
      signal: this.refreshController?.signal,
      locale: this.locale,
      onChange: (status) => {
        if (sequence !== this.approvalSequence) return;
        this.approvalReady = status.ready === true;
        if (status.setupInvalidated && this.setup) {
          const setup = this.setup;
          setup.advancement = null;
          if (setup.browser_user?.status === 'verified') setup.browser_user = null;
          if (setup.approval_scope?.status === 'ready') setup.approval_scope = null;
        }
        if (status.setupScopeInvalidated && this.setup) {
          this.setup.approval_scope = null;
          this.setup.mapping = null;
          this.setup.advancement = null;
        }
        this.approvalBusy = status.busy === true;
        if (status.accessLost === true) {
          // Recovery identities/history still clear completely. The local GET
          // separately established these redacted configuration blockers.
          if (this.setup) {
            if (this.setup.browser_user?.status === 'verified') this.setup.browser_user = null;
            if (this.setup.approval_scope?.status === 'ready') this.setup.approval_scope = null;
            this.setup.advancement = null;
          }
          this.approvalReady = false;
          this.snapshot = null;
          this.loaded = false;
          this.readBlocked = true;
          this.heldRequests = [];
          this.receiptAccessError = 'forbidden';
          this.clearReceipts(true);
          this.stopPolling();
        }
        this.recoveryRequests =
          status.ready === true && Array.isArray(status.recoveryRequests)
            ? status.recoveryRequests.filter(
                (item) =>
                  item &&
                  UUID.test(item.request_id) &&
                  UUID.test(item.approval_request_id) &&
                  HASH.test(item.display_digest) &&
                  item.session_id === this.sessionId &&
                  this.snapshot?.scope?.tier === 'public' &&
                  item.tenant === this.snapshot.scope.tenant &&
                  Number.isSafeInteger(item.revision) &&
                  item.revision > 0 &&
                  item.revision <= 64 &&
                  ['eligible', 'terminated_unstarted'].includes(item.status)
              )
            : [];
        if (
          status.ready === true &&
          Array.isArray(status.recoveryRequests) &&
          this.recoveryRequests.length !== status.recoveryRequests.length
        )
          this.approvalReady = false;
        this.heldRequests = Array.isArray(status.heldRequests)
          ? status.heldRequests.filter(
              (held) =>
                held &&
                UUID.test(held.request_id) &&
                held.status === 'approval_verification_failed' &&
                held.recovery === 'operator_recovery'
            )
          : status.ready === true
            ? []
            : this.heldRequests;
        this.render();
        if (
          this.resumeRead &&
          this.visible() &&
          !this.approvalBusy &&
          !this.sending &&
          !this.refreshing
        )
          void this.refresh();
      },
      onDecision: () => {
        if (!this.visible()) {
          this.resumeRead = true;
          return;
        }
        void this.refresh();
      },
    });
    let timer: number | undefined;
    return new Promise<void>((resolve, reject) => {
      timer = window.setTimeout(() => {
        if (sequence === this.approvalSequence) this.invalidateApproval();
        reject(new Error('approval_read_timeout'));
      }, WAIT_MS);
      Promise.resolve(check).then(resolve, reject);
    }).finally(() => window.clearTimeout(timer));
  }
  private invalidateApproval(): void {
    this.approvalSequence++;
    this.approvalReady = false;
    this.approvalBusy = false;
    this.recoveryRequests = [];
    // A failed read cannot prove that a previously held request has recovered.
    this.approval.invalidate();
  }
  refresh(): Promise<void> {
    if (this.sending || this.approvalBusy || this.refreshing) return Promise.resolve();
    const sequence = ++this.refreshSequence;
    this.resumeRead = false;
    const requestedSession = this.sessionId;
    this.refreshing = true;
    this.readBlocked = false;
    this.refreshController = typeof AbortController === 'function' ? new AbortController() : null;
    this.invalidateApproval();
    this.render();
    const query = new URLSearchParams();
    if (this.locale) query.set('locale', this.locale);
    if (this.sessionId) query.set('session_id', this.sessionId);
    return this.fetchJson(
      '/api/first-job?' + query.toString(),
      { cache: 'no-store' },
      this.refreshController
    )
      .then((result) => {
        if (sequence !== this.refreshSequence) return;
        if (!result.ok || !result.body || !result.body.ok) {
          this.refusal = refusalKey(result.body);
          if (result.status >= 400 && result.status < 500) {
            this.invalidateReadAccess(
              result.status === 401 || result.status === 403 ? 'forbidden' : 'unavailable'
            );
            return;
          }
          throw new Error('status_unavailable');
        }
        if (
          requestedSession &&
          result.body.sessionId !== requestedSession &&
          (result.body.sessionId || !result.body.readiness || result.body.readiness.ready !== false)
        ) {
          this.invalidateReadAccess('unavailable');
          return;
        }
        this.applySnapshot(result.body);
        this.lastChecked = Date.now();
        this.networkError = false;
        this.pollFailures = 0;
        this.errorKey = !this.storageReady
          ? 'storage_required'
          : this.pending
            ? this.pending.retrySafe
              ? 'retry_safe'
              : 'uncertain'
            : null;
        return this.checkApproval();
      })
      .catch(() => {
        if (sequence !== this.refreshSequence) return;
        this.loaded = false;
        this.setup = null;
        this.networkError = true;
        this.pollFailures = Math.min(this.pollFailures + 1, 4);
        this.invalidateApproval();
        this.errorKey = this.pending ? 'uncertain' : 'load_failed';
      })
      .finally(() => {
        if (sequence !== this.refreshSequence) return;
        this.refreshController = null;
        this.refreshing = false;
        this.render();
      });
  }
  private sendPending(): Promise<void> | undefined {
    if (this.sending || !this.pending || !this.storageReady) return;
    this.sending = true;
    // An intake outcome is unknown until fresh server readback arrives.
    this.setup = null;
    this.pending.retrySafe = false;
    this.pending.checked = false;
    this.errorKey = null;
    // Persist the exact request before any network effect; reload never replays it.
    if (!this.save()) {
      this.sending = false;
      this.render();
      return;
    }
    this.render();
    const pending = this.pending;
    return this.fetchJson('/api/first-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending.body),
    })
      .then((result) => {
        if (!result.ok || !result.body || !result.body.ok) {
          this.refusal = refusalKey(result.body);
          pending.retrySafe = Boolean(result.body && result.body.retry_safe === true);
          pending.checked = false;
          this.loaded = false;
          this.errorKey = pending.retrySafe ? 'retry_safe' : 'uncertain';
          this.save();
          if ([401, 403, 409].includes(result.status)) this.invalidateReadAccess('forbidden');
          return;
        }
        this.applySnapshot(result.body);
        this.errorKey = !this.storageReady ? 'storage_required' : this.pending ? 'uncertain' : null;
        this.save();
        return this.checkApproval();
      })
      .catch(() => {
        this.errorKey = 'uncertain';
        this.loaded = false;
        this.save();
      })
      .finally(() => {
        this.sending = false;
        this.render();
      });
  }
  private submitNew(action: 'start' | 'revise', artifact?: Pending['body']['artifactRevision']) {
    if (!this.canAct()) return;
    if (action === 'start' && (this.tasks().length || this.messages().length) && !this.canRestart())
      return;
    const body: Pending['body'] = {
      action,
      request_id: window.crypto.randomUUID(),
      session_id: this.sessionId!,
      locale: this.locale,
    };
    if (artifact) body.artifactRevision = artifact;
    this.pending = { body, retrySafe: false, checked: false };
    return this.sendPending();
  }

  // --- controls --------------------------------------------------------------
  start(): Promise<void> | undefined {
    if (!this.tasks().length && !this.messages().length) return this.submitNew('start');
  }
  restart(): Promise<void> | undefined {
    if (this.canRestart()) return this.submitNew('start');
  }
  revise(artifact: FirstJobArtifact): Promise<void> | undefined {
    const target = this.revisionTarget(artifact);
    if (!this.canAct() || !target) return;
    return this.submitNew('revise', {
      requestId: target.requestId,
      revision: target.revision,
      sha256: target.sha256!,
      format: target.format === 'readable' ? 'compact' : 'readable',
    });
  }
  retry(): Promise<void> | undefined {
    if (
      this.pending &&
      this.pending.retrySafe &&
      this.pending.checked &&
      this.ready() &&
      this.approvalReady &&
      !this.sending &&
      !this.approvalBusy &&
      !this.refreshing
    )
      return this.sendPending();
  }
  /** The page's refresh button (Studio `load`). */
  load(): Promise<void> {
    if (this.sending || this.refreshing) return Promise.resolve();
    return this.refresh();
  }
  setLocale(locale: string): void {
    this.locale = locale;
  }

  mount(): () => void {
    if (this.mounted) return () => undefined;
    this.mounted = true;
    this.restore();
    const onVisibility = () => {
      if (!this.visible()) this.suspendReads();
      else if (this.resumeRead || this.progressing()) void this.refresh();
      else this.render();
    };
    const onPageHide = () => {
      this.pageActive = false;
      this.suspendReads(true);
    };
    const onPageShow = () => {
      this.pageActive = true;
      if (this.visible() && (this.resumeRead || this.progressing())) void this.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    this.detach = [
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('pagehide', onPageHide),
      () => window.removeEventListener('pageshow', onPageShow),
    ];
    void this.load();
    return () => this.unmount();
  }
  private unmount(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.stopPolling();
    this.refreshSequence++;
    this.refreshController?.abort();
    this.clearReceipts(false);
    this.approval.invalidate();
    this.mounted = false;
  }
}
