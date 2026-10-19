import { frontDeskFetch } from '../../../lib/front-desk-fetch';
import {
  getFrontDeskAuthRevision,
  readFrontDeskRequestToken,
} from '../../../lib/front-desk-auth-token';
import { parseSettingsMe } from '../../../lib/settings-types';
import { settingsDraftContext } from '../../../lib/use-settings-draft';
import {
  companyActionAllowed,
  initialCompanyState,
  parseCompanyReview,
  parseCompanySetup,
  type CompanyAction,
  type CompanyNotice,
  type CompanySetupState,
} from './company-setup-model';

type Transport = (path: string, init?: RequestInit) => Promise<Response>;
class SetupError extends Error {
  constructor(readonly kind: CompanyNotice) {
    super(kind);
  }
}
export function companyBrowserContext(): string {
  return JSON.stringify([
    getFrontDeskAuthRevision(),
    readFrontDeskRequestToken(),
    typeof window === 'undefined' ? '' : window.location.pathname + window.location.search,
  ]);
}
/** The deadline includes reading the body. Aborting never implies a POST was rolled back. */
async function payload(
  transport: Transport,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) abort.abort();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SetupError('failed'));
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
  });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const response = await transport(path, { ...init, signal: abort.signal });
        if (response.status === 401) throw new SetupError('expired');
        if (response.status === 403) throw new SetupError('forbidden');
        const value: unknown = await response.json();
        if (!response.ok) throw new SetupError('failed');
        return value;
      })(),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
    if (onAbort) abort.signal.removeEventListener('abort', onAbort);
  }
}
export function createCompanySetupController(
  options: {
    request?: Transport;
    context?: () => string;
    timeoutMs?: number;
  } = {}
) {
  const request = options.request ?? frontDeskFetch;
  const context = options.context ?? companyBrowserContext;
  const timeoutMs = options.timeoutMs ?? 45_000;
  let state = initialCompanyState();
  let generation = 0;
  let active: AbortController | undefined;
  let boundContext: string | undefined;
  let identity: string | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: CompanySetupState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation++;
    active?.abort();
    active = undefined;
  };
  const suspend = () => {
    cancel();
    boundContext = undefined;
    identity = undefined;
    publish({ ...initialCompanyState(state.tenantSlug), notice: 'changed', needsRefresh: true });
  };
  const begin = () => {
    const selected = ++generation;
    const capturedContext = context();
    const controller = new AbortController();
    active = controller;
    const current = () =>
      selected === generation && !controller.signal.aborted && capturedContext === context();
    return { selected, capturedContext, controller, current };
  };
  const read = (path: string, signal: AbortSignal, command?: Record<string, string>) =>
    payload(
      request,
      path,
      {
        signal,
        ...(command
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(command),
            }
          : {}),
      },
      timeoutMs
    );
  const finish = (ticket: ReturnType<typeof begin>) => {
    if (ticket.selected !== generation) return;
    active = undefined;
    if (!ticket.current()) suspend();
    else if (state.busy) publish({ ...state, busy: false });
  };
  async function load(tenantSlug = state.tenantSlug) {
    cancel();
    boundContext = undefined;
    identity = undefined;
    const ticket = begin();
    publish({ ...initialCompanyState(tenantSlug), busy: true });
    try {
      const rawMe = await read('/api/me', ticket.controller.signal);
      if (!ticket.current()) return;
      const me = parseSettingsMe(rawMe);
      const identityKey = settingsDraftContext(rawMe);
      if (!me || !identityKey) throw new SetupError('failed');
      const tenants = me.tenants
        .filter((row) => row.role === 'owner' && row.status === 'active')
        .map((row) => ({ slug: row.tenant_slug, name: row.display_name }));
      if (!tenants.length) throw new SetupError('forbidden');
      const selected =
        tenantSlug ||
        (tenants.some((row) => row.slug === me.viewing?.tenant_slug)
          ? me.viewing!.tenant_slug
          : tenants.length === 1
            ? tenants[0].slug
            : '');
      if (selected && !tenants.some((row) => row.slug === selected))
        throw new SetupError('forbidden');
      publish({ ...state, tenants, tenantSlug: selected });
      if (!selected) return;
      const value = await read(
        '/api/setup/company?' + new URLSearchParams({ tenant: selected }),
        ticket.controller.signal
      );
      if (!ticket.current()) return;
      const setup = parseCompanySetup(value, selected);
      if (!setup) throw new SetupError('failed');
      const after = await read('/api/me', ticket.controller.signal);
      if (!ticket.current()) return;
      if (settingsDraftContext(after) !== identityKey) {
        suspend();
        return;
      }
      identity = identityKey;
      boundContext = ticket.capturedContext;
      publish({
        ...state,
        setup,
        busy: false,
        draft: { vertical: '', firstWork: setup.firstWork },
      });
    } catch (error) {
      if (ticket.current())
        publish({
          ...state,
          setup: null,
          review: null,
          busy: false,
          notice: error instanceof SetupError ? error.kind : 'failed',
        });
    } finally {
      finish(ticket);
    }
  }
  async function act(action: CompanyAction) {
    if (!companyActionAllowed(state, action)) return;
    if (!boundContext || boundContext !== context()) {
      suspend();
      return;
    }
    const before = state;
    const setup = before.setup!;
    const ticket = begin();
    let sent = false;
    publish({ ...state, busy: true, notice: null });
    try {
      const rawMe = await read('/api/me', ticket.controller.signal);
      if (!ticket.current()) return;
      if (!identity || settingsDraftContext(rawMe) !== identity) {
        suspend();
        return;
      }
      const command: Record<string, string> = { action, tenantSlug: setup.tenantSlug };
      if (action === 'preview_company' || action === 'register_company') {
        command.vertical = before.draft.vertical;
        command.firstWork = before.draft.firstWork.trim();
      }
      if (action === 'register_company' || action === 'apply_first_work')
        command.reviewDigest = before.review!.digest;
      if (action === 'apply_activation') command.requestId = setup.activationApproval!.id;
      sent = true;
      const result = await read('/api/setup/company', ticket.controller.signal, command);
      if (!ticket.current()) return;
      const rawAfter = await read('/api/me', ticket.controller.signal);
      if (!ticket.current()) return;
      if (settingsDraftContext(rawAfter) !== identity) {
        suspend();
        return;
      }
      if (action === 'preview_company' || action === 'preview_first_work') {
        const review = parseCompanyReview(result);
        if (!review) throw new SetupError('uncertain');
        publish({
          ...state,
          busy: false,
          review: {
            ...review,
            action: action === 'preview_company' ? 'register_company' : 'apply_first_work',
          },
        });
      } else {
        const next = parseCompanySetup(result, setup.tenantSlug);
        if (!next) throw new SetupError('uncertain');
        publish({
          ...state,
          setup: next,
          review: null,
          busy: false,
          draft: { ...state.draft, firstWork: next.firstWork },
        });
      }
    } catch (error) {
      if (!ticket.current()) return;
      const kind = error instanceof SetupError ? error.kind : 'failed';
      const denied = kind === 'expired' || kind === 'forbidden';
      publish({
        ...state,
        busy: false,
        review: null,
        ...(denied ? { setup: null, tenants: [] } : {}),
        notice: sent && !denied ? 'uncertain' : kind,
        needsRefresh: true,
      });
    } finally {
      finish(ticket);
    }
  }
  async function verifyIdentity() {
    if (state.busy || state.needsRefresh || !state.setup) return;
    if (!boundContext || boundContext !== context()) {
      suspend();
      return;
    }
    const ticket = begin();
    publish({ ...state, busy: true });
    try {
      const value = await read('/api/me', ticket.controller.signal);
      if (!ticket.current()) return;
      if (!identity || settingsDraftContext(value) !== identity) suspend();
    } catch {
      if (ticket.current()) suspend();
    } finally {
      finish(ticket);
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    refresh: () => (state.busy ? Promise.resolve() : load()),
    act,
    verifyIdentity,
    updateDraft: (patch: Partial<CompanySetupState['draft']>) => {
      if (state.busy || state.needsRefresh || state.setup?.stage !== 'unregistered') return;
      publish({ ...state, draft: { ...state.draft, ...patch }, review: null });
    },
    dismissReview: () => {
      if (!state.busy) publish({ ...state, review: null });
    },
    suspend,
    contextChanged: () => boundContext !== undefined && boundContext !== context(),
    dispose: () => {
      cancel();
      listeners.clear();
      state = initialCompanyState();
    },
  };
}
export type CompanySetupController = ReturnType<typeof createCompanySetupController>;
