/**
 * 初めての仕事 (`/first-job`) approval view, moved from presence-studio
 * `static/first-job-approval.js` (Kyberion server phase 2); the guide is
 * `first-job-controller.ts`. Dedicated diagnostic approval: no credential
 * creation or loopback identity inference. Every decision is an explicit
 * click bound to the latest server display digest. Reload and refresh only
 * read; cookie verification and effect authorization stay server-side.
 */
import { frontDeskFetch } from '../../lib/front-desk-fetch';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const SESSION = /^concierge-[a-f0-9]{64}$/;
/** Bound on every UI wait (reads and mutations). */
export const WAIT_MS = 15000;

export type ReceiptFormat = 'compact' | 'readable';
export interface FirstJobArtifact {
  requestId: string;
  revision: number;
  sha256?: string;
  format?: ReceiptFormat;
  verification?: string;
  currentness?: string;
  verifiedAt?: number;
  canRevise?: boolean;
}
export interface FirstJobTask {
  id: string;
  turnState?: string;
  executionStatus?: string;
  artifact?: FirstJobArtifact;
}
export interface FirstJobMessage {
  id: string;
  role: string;
  artifact?: FirstJobArtifact;
}
export interface SetupCheck {
  status: string;
  owner: string;
  next_action: string;
}
export type FirstJobSetup = Record<string, SetupCheck | null | undefined>;
export interface FirstJobSnapshot {
  ok: boolean;
  readiness: { ready: boolean; status: string };
  scope?: { tenant?: string; tier?: string };
  sessionId?: string;
  messages: FirstJobMessage[];
  pending: number;
  tasks: FirstJobTask[];
  setup?: FirstJobSetup | null;
}
export interface ApprovalItem {
  approval_request_id: string;
  request_id: string;
  revision: number;
  expires_at: string;
  execution_deadline_at: string;
  display_digest: string;
  payload_hash: string;
  effect_binding: string;
  receipt_format: string;
  tenant: string;
}
export interface HeldRequest {
  request_id: string;
  status: string;
  recovery: string;
}
export interface RecoveryRequest {
  request_id: string;
  approval_request_id: string;
  session_id: string;
  status: 'eligible' | 'terminated_unstarted';
  display_digest: string;
  revision: number;
  tenant: string;
}
export type JsonResult = { ok: boolean; status: number; body: any };
export interface ApprovalStatus {
  ready: boolean;
  busy: boolean;
  accessLost?: boolean;
  setupInvalidated?: boolean;
  setupScopeInvalidated?: boolean;
  heldRequests?: HeldRequest[];
  recoveryRequests?: RecoveryRequest[];
}
export interface ApprovalContext {
  snapshot: FirstJobSnapshot | null;
  signal?: AbortSignal;
  locale: string;
  onChange: (status: ApprovalStatus) => void;
  onDecision: () => void;
}

export function readJson(url: string, init: RequestInit): Promise<JsonResult> {
  return frontDeskFetch(url, init).then((response) =>
    response.json().then(
      (body: unknown) => ({ ok: response.ok, status: response.status, body }),
      () => ({ ok: response.ok, status: response.status, body: null })
    )
  );
}

/** A timeout is an unknown outcome, never cancellation or permission to replay. */
export function submitMutation(url: string, init: RequestInit): Promise<JsonResult> {
  let timer: number | undefined;
  return new Promise<JsonResult>((resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error('mutation_unknown')), WAIT_MS);
    readJson(url, init).then(resolve, reject);
  }).finally(() => window.clearTimeout(timer));
}

/** The diagnostic approval view (Studio `first-job-approval.js`). */
export class FirstJobApprovalPanel {
  context: ApprovalContext | null = null;
  generation = 0;
  loading = false;
  readController: AbortController | null = null;
  sending = false;
  eligible = false;
  authStatus: string | null = null;
  readiness: string | null = null;
  items: ApprovalItem[] = [];
  held: HeldRequest[] = [];
  recovery: RecoveryRequest[] = [];
  confirmRecovery: string | null = null;
  error: string | null = null;
  message: string | null = null;
  /** Recovery control to focus after the next render (Studio `render(focusRecovery)`). */
  focusRecovery: string | null = null;

  constructor(private readonly notify: () => void) {}

  private tellParent(): void {
    if (!this.context?.onChange) return;
    const update: ApprovalStatus = {
      ready: this.eligible && !this.loading && !this.sending,
      busy: this.sending,
    };
    if (
      [
        'authentication_required',
        'authentication_configuration_required',
        'access_denied',
      ].includes(this.authStatus ?? '')
    )
      update.accessLost = true;
    if (
      this.error ||
      ['authentication_required', 'authentication_configuration_required'].includes(
        this.authStatus ?? ''
      )
    )
      update.setupInvalidated = true;
    if (
      this.authStatus === 'access_denied' ||
      (this.authStatus === 'ready' &&
        ['scope_changed', 'diagnostic_unavailable'].includes(this.readiness ?? ''))
    )
      update.setupScopeInvalidated = true;
    if (this.held.length) update.heldRequests = this.held;
    if (this.recovery.length && this.eligible && !this.loading && !this.sending)
      update.recoveryRequests = this.recovery;
    this.context.onChange(update);
  }

  render(focusRecovery?: string): void {
    this.focusRecovery = focusRecovery ?? null;
    this.notify();
    this.tellParent();
  }

  validItem(item: ApprovalItem | undefined): boolean {
    const snapshot = this.context?.snapshot;
    return Boolean(
      item &&
      UUID.test(item.approval_request_id) &&
      UUID.test(item.request_id) &&
      Number.isSafeInteger(item.revision) &&
      item.revision > 0 &&
      item.revision <= 64 &&
      HASH.test(item.display_digest) &&
      HASH.test(item.payload_hash) &&
      /^first-job:[a-f0-9]{64}$/.test(item.effect_binding) &&
      typeof item.tenant === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.tenant) &&
      snapshot?.scope &&
      snapshot.scope.tier === 'public' &&
      item.tenant === snapshot.scope.tenant &&
      (item.receipt_format === 'pretty' || item.receipt_format === 'compact') &&
      typeof item.expires_at === 'string' &&
      Number.isFinite(Date.parse(item.expires_at)) &&
      typeof item.execution_deadline_at === 'string' &&
      Number.isFinite(Date.parse(item.execution_deadline_at)) &&
      Date.parse(item.execution_deadline_at) <= Date.parse(item.expires_at) &&
      Date.parse(item.execution_deadline_at) > Date.now()
    );
  }

  private validHeld(item: HeldRequest | undefined): boolean {
    return Boolean(
      item &&
      UUID.test(item.request_id) &&
      item.status === 'approval_verification_failed' &&
      item.recovery === 'operator_recovery'
    );
  }

  validRecovery(item: RecoveryRequest | undefined): boolean {
    const snapshot = this.context?.snapshot;
    return Boolean(
      item &&
      UUID.test(item.request_id) &&
      UUID.test(item.approval_request_id) &&
      SESSION.test(item.session_id) &&
      HASH.test(item.display_digest) &&
      Number.isSafeInteger(item.revision) &&
      item.revision > 0 &&
      item.revision <= 64 &&
      ['eligible', 'terminated_unstarted'].includes(item.status) &&
      typeof item.tenant === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.tenant) &&
      snapshot?.scope &&
      snapshot.scope.tier === 'public' &&
      item.tenant === snapshot.scope.tenant &&
      item.session_id === snapshot.sessionId
    );
  }

  authKey(): string {
    if (this.loading) return 'approval_loading';
    if (this.sending) return 'approval_sending';
    if (this.authStatus === 'authentication_configuration_required')
      return 'approval_configuration';
    if (this.authStatus === 'authentication_required') return 'approval_auth_needed';
    if (this.authStatus === 'access_denied') return 'approval_forbidden';
    if (this.readiness === 'scope_changed' || this.readiness === 'diagnostic_unavailable')
      return 'approval_diagnostic_unavailable';
    return this.eligible ? 'approval_ready' : 'approval_unknown';
  }

  statusKey(): string {
    if (this.sending) return 'approval_sending';
    if (this.message) return this.message;
    if (this.held.length) return 'approval_held';
    if (this.recovery.some((item) => item.status === 'eligible')) return 'recovery_eligible';
    if (this.recovery.length) return 'recovery_terminated';
    if (this.eligible && !this.items.length) return 'approval_empty';
    return this.authKey();
  }

  private reflectAccessLoss(result: JsonResult): void {
    if (![401, 403].includes(result.status)) return;
    this.authStatus = result.status === 401 ? 'authentication_required' : 'access_denied';
    this.items = [];
    this.held = [];
    this.recovery = [];
    this.confirmRecovery = null;
  }

  private readApproval(
    url: string,
    controller: AbortController | null,
    parentSignal?: AbortSignal
  ): Promise<JsonResult> {
    let timer: number | undefined;
    let cancel: () => void = () => undefined;
    return new Promise<JsonResult>((resolve, reject) => {
      cancel = () => {
        reject(new Error('approval_read_cancelled'));
        if (controller && !controller.signal.aborted) controller.abort();
      };
      if (controller) controller.signal.addEventListener('abort', cancel, { once: true });
      if (parentSignal) parentSignal.addEventListener('abort', cancel, { once: true });
      timer = window.setTimeout(cancel, WAIT_MS);
      if (parentSignal?.aborted) {
        cancel();
        return;
      }
      readJson(url, { cache: 'no-store', signal: controller?.signal }).then(resolve, reject);
    }).finally(() => {
      window.clearTimeout(timer);
      if (controller) controller.signal.removeEventListener('abort', cancel);
      if (parentSignal) parentSignal.removeEventListener('abort', cancel);
    });
  }

  private contextValid(context: ApprovalContext | null): boolean {
    const snapshot = context?.snapshot;
    return Boolean(
      snapshot &&
      SESSION.test(snapshot.sessionId ?? '') &&
      snapshot.readiness &&
      snapshot.readiness.ready === true &&
      snapshot.readiness.status === 'diagnostic_mapping_ready'
    );
  }

  /** The panel's own refresh button. */
  refresh(): void {
    if (!this.loading && !this.sending && this.context) void this.check(this.context);
  }

  check(context: ApprovalContext): Promise<void> {
    if (this.sending) return Promise.resolve();
    if (this.readController) this.readController.abort();
    this.readController = null;
    this.context = context;
    const generation = ++this.generation;
    this.eligible = false;
    this.items = [];
    this.held = [];
    this.recovery = [];
    this.confirmRecovery = null;
    this.error = null;
    this.message = null;
    this.authStatus = null;
    this.readiness = null;
    if (!this.contextValid(context)) {
      this.loading = false;
      this.readiness = 'diagnostic_unavailable';
      this.render();
      return Promise.resolve();
    }
    this.loading = true;
    this.render();
    const query = new URLSearchParams();
    query.set('session_id', context.snapshot!.sessionId!);
    if (context.locale) query.set('locale', context.locale);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    this.readController = controller;
    return this.readApproval(
      '/api/first-job/approvals?' + query.toString(),
      controller,
      context.signal
    )
      .then((result) => {
        if (generation !== this.generation) return;
        this.reflectAccessLoss(result);
        const body = result.body;
        if (
          !result.ok ||
          !body ||
          body.ok !== true ||
          !body.auth ||
          !body.readiness ||
          !Array.isArray(body.approvals)
        )
          throw new Error('approval_unavailable');
        this.authStatus = body.auth.status;
        this.readiness = body.readiness.status;
        this.eligible =
          body.auth.status === 'ready' &&
          body.readiness.ready === true &&
          body.readiness.status === 'ready';
        if (this.eligible) {
          const held: HeldRequest[] = body.held_requests === undefined ? [] : body.held_requests;
          const recovery: RecoveryRequest[] =
            body.recovery_requests === undefined ? [] : body.recovery_requests;
          const seen = new Set<string>();
          const approvals = body.approvals as ApprovalItem[];
          if (
            !approvals.every((item) => this.validItem(item)) ||
            !Array.isArray(held) ||
            !held.every((item) => this.validHeld(item)) ||
            !Array.isArray(recovery) ||
            !recovery.every((item) => this.validRecovery(item)) ||
            [...approvals, ...held, ...recovery].some((item) => {
              if (seen.has(item.request_id)) return true;
              seen.add(item.request_id);
              return false;
            }) ||
            held.some((item) =>
              approvals.some((approval) => approval.request_id === item.request_id)
            )
          ) {
            this.eligible = false;
            this.error = 'approval_changed';
          } else {
            this.items = approvals;
            this.held = held;
            this.recovery = recovery;
          }
        }
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.eligible = false;
        this.items = [];
        this.error = 'approval_failed';
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.readController = null;
        this.loading = false;
        this.render();
      });
  }

  invalidate(): void {
    if (this.readController) this.readController.abort();
    this.readController = null;
    this.generation += 1;
    this.eligible = false;
    this.loading = false;
    this.authStatus = null;
    this.items = [];
    this.held = [];
    this.recovery = [];
    this.confirmRecovery = null;
    this.sending = false;
    this.message = null;
    this.error = null;
    this.readiness = 'diagnostic_unavailable';
    if (this.context) this.render();
  }

  /** Approve or reject: the click handler (Studio's per-card button listener). */
  clickDecision(item: ApprovalItem, decision: 'approved' | 'rejected', generation: number): void {
    if (generation !== this.generation || !this.eligible || this.loading || this.sending) return;
    if (!this.validItem(item)) {
      this.eligible = false;
      this.error = 'approval_changed';
      this.render();
      return;
    }
    void this.decide(item, decision);
  }

  private decide(item: ApprovalItem, decision: 'approved' | 'rejected'): Promise<void> {
    this.sending = true;
    this.eligible = false;
    const generation = ++this.generation;
    this.confirmRecovery = null;
    this.error = null;
    this.render();
    const context = this.context!;
    const body = {
      decision,
      display_digest: item.display_digest,
      session_id: context.snapshot!.sessionId,
    };
    return submitMutation(
      '/api/first-job/approvals/' + encodeURIComponent(item.approval_request_id) + '/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
      .then((result) => {
        if (generation !== this.generation) return;
        this.reflectAccessLoss(result);
        if (
          !result.ok ||
          !result.body ||
          result.body.ok !== true ||
          result.body.approval_request_id !== item.approval_request_id ||
          result.body.status !== decision
        ) {
          this.error =
            result.body && result.body.retry_safe === true
              ? 'approval_changed'
              : 'approval_uncertain';
          return;
        }
        this.items = [];
        this.message = 'approval_recorded';
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.error = 'approval_uncertain';
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.sending = false;
        this.render();
        if (!this.error && context.onDecision) context.onDecision();
      });
  }

  /** The recovery card's review / confirm button. */
  clickRecovery(item: RecoveryRequest, confirming: boolean, generation: number): void {
    if (
      generation !== this.generation ||
      !this.eligible ||
      this.loading ||
      this.sending ||
      !this.validRecovery(item)
    )
      return;
    const key = item.request_id + ':' + item.display_digest;
    if (confirming) {
      if (this.confirmRecovery === key) void this.terminate(item);
    } else {
      this.generation += 1;
      this.confirmRecovery = key;
      this.render(key);
    }
  }

  clickRecoveryCancel(item: RecoveryRequest, generation: number): void {
    if (generation !== this.generation || this.sending || this.loading) return;
    this.generation += 1;
    this.confirmRecovery = null;
    this.render(item.request_id + ':' + item.display_digest);
  }

  private terminate(item: RecoveryRequest): Promise<void> {
    const context = this.context!;
    const generation = ++this.generation;
    this.sending = true;
    this.eligible = false;
    this.confirmRecovery = null;
    this.error = null;
    this.render();
    return submitMutation('/api/first-job/recovery/' + encodeURIComponent(item.request_id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: context.snapshot!.sessionId,
        display_digest: item.display_digest,
        action: 'terminate_unstarted',
      }),
    })
      .then((result) => {
        if (generation !== this.generation) return;
        this.reflectAccessLoss(result);
        if (
          !result.ok ||
          !result.body ||
          result.body.ok !== true ||
          result.body.request_id !== item.request_id ||
          result.body.status !== 'terminated_unstarted'
        ) {
          this.error =
            result.body && result.body.retry_safe === true
              ? 'recovery_changed'
              : 'recovery_uncertain';
          return;
        }
        // Only the next authoritative GET can grant terminal display/restart eligibility.
        this.recovery = [];
        this.message = 'recovery_readback';
      })
      .catch(() => {
        if (generation === this.generation) this.error = 'recovery_uncertain';
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.sending = false;
        this.render();
        if (!this.error && context.onDecision) context.onDecision();
      });
  }
}
