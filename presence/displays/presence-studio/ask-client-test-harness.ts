import { vi, type Mock } from 'vitest';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';

type TestEvent = { preventDefault: () => void; key?: string };

class Element {
  value = '';
  private html = '';
  onHtml?: (value: string) => void;
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.onHtml?.(value);
  }
  textContent = '';
  disabled = false;
  hidden = true;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = 'none';
  setSelectionRange = vi.fn((start: number, end: number, direction: string) => {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  });
  focus = vi.fn() as Mock;
  scrollIntoView = vi.fn() as Mock;
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: TestEvent) => void> = {};
  classList = { add: vi.fn() as Mock, remove: vi.fn() as Mock, toggle: vi.fn() as Mock };
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, handler: (event: TestEvent) => void) {
    this.listeners[name] = handler;
  }
  fire(name: string, detail: Partial<TestEvent> = {}) {
    const event = { preventDefault: vi.fn() as Mock, ...detail };
    this.listeners[name]?.(event);
    return event;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const vocabularyTexts = () =>
  new Proxy({} as Record<string, string>, {
    get: (_target, key) => String(key),
  });
const session = 'concierge-' + 'a'.repeat(64);
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function harness(
  options: {
    storage?: Map<string, string>;
    ready?: Promise<unknown>;
    post?: (body: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
    hearing?: (
      url: string,
      init?: { method?: string; body?: string }
    ) => Promise<ReturnType<typeof response>>;
    history?: Record<string, unknown>;
    historyStatus?: number;
    conversation?: () => Promise<ReturnType<typeof response>>;
    vocabulary?: Promise<ReturnType<typeof response>>;
    progress?: () => Promise<ReturnType<typeof response>>;
    vocabularyRead?: () => Promise<ReturnType<typeof response>>;
    texts?: Record<string, string>;
    speech?: boolean;
    recoveryScript?: boolean;
    hearingScript?: boolean;
    completionScript?: boolean;
    nextActionsScript?: boolean;
    query?: string;
    hash?: string;
  } = {}
) {
  const elements = new Map(
    [
      'hearing-card',
      'hearing-title',
      'hearing-coverage',
      'hearing-canvas',
      'hearing-decide',
      'hearing-handoff',
      'hearing-handoff-status',
      'hearing-handoff-link',
      'hearing-sync-status',
      'hearing-sync-text',
      'hearing-sync-retry',
      'hearing-sync-continue',
      'ask-mic',
      'handsfree-toggle',
      'about-title',
      'about-empty',
      'ask-form',
      'ask-input',
      'ask-send',
      'turns',
      'ask-empty',
      'conversation-status',
      'conversation-selection',
      'conversation-reload',
      'conversation-legacy',
      'conversation-legacy-turns',
      'draft-choice',
      'draft-choice-preview',
      'draft-keep',
      'draft-replace',
      'draft-storage-warning',
      'home-draft-preserved',
      'pending-request-review',
      'pending-request-recovery',
      'pending-request-description',
      'recent-card',
      'recent-title',
      'recent-list',
      'recent-status',
      'recent-loading',
      'recent-error',
      'recent-retry',
      'ask-startup-status',
      'ask-startup-loading',
      'ask-startup-error',
      'ask-startup-retry',
    ].map((id) => [id, new Element()])
  );
  const chips = new Map(
    ['email', 'minutes', 'browser', 'webapp', 'unknown'].map((key) => {
      const chip = new Element();
      chip.setAttribute('data-chip', key);
      return [key, chip] as const;
    })
  );
  const storage = options.storage ?? new Map<string, string>();
  const location = {
    reload: vi.fn() as Mock,
    href: 'http://localhost/ask' + (options.query ?? '?tenant=alpha') + (options.hash ?? ''),
    origin: 'http://localhost',
    pathname: '/ask',
    search: options.query ?? '?tenant=alpha',
    hash: options.hash ?? '',
  };
  const scopedUrl = (path: string) => {
    const url = new URL(path, location.href);
    url.searchParams.set('tenant', 'alpha');
    for (const key of ['organizationId', 'projectId']) {
      const value = new URLSearchParams(location.search).get(key);
      if (value) url.searchParams.set(key, value);
    }
    return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
  };
  const shellListeners: Array<(state: { phase: string; message: string }) => void> = [];
  const window = {
    location,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    AbortController,
    SpeechRecognition: options.speech
      ? class {
          onstart?: () => void;
          onerror?: () => void;
          start() {
            this.onstart?.();
            this.onerror?.();
          }
          stop() {}
        }
      : undefined,
    crypto: { randomUUID },
    history: { state: null, replaceState: vi.fn() as Mock },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    KyberionPrefs: { locale: () => 'en', tenant: () => 'alpha', scopedUrl },
    FrontDeskRail: {
      ready: options.ready ?? Promise.resolve(),
      subscribe(listener: (state: { phase: string; message: string }) => void) {
        shellListeners.push(listener);
        return () => {};
      },
    },
    KyberionAsk: undefined as undefined | { mount: () => void },
  };
  const texts =
    options.texts ??
    new Proxy({} as Record<string, string>, {
      get: (_target, key) => String(key),
    });
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/hearing/'))
      return options.hearing ? options.hearing(url, init) : response({ ok: true, record: null });
    if (init?.method === 'POST')
      return options.post
        ? options.post(JSON.parse(init.body!))
        : response({ ok: true, reply: 'Done', mode: 'orchestrator' });
    if (url.startsWith('/api/ask-vocabulary'))
      return options.vocabularyRead
        ? options.vocabularyRead()
        : (options.vocabulary ?? response({ ok: true, texts }));
    if (url.startsWith('/api/progress'))
      return options.progress ? options.progress() : response({ ok: true, active: [] });
    if (url.startsWith('/api/conversation'))
      return options.conversation
        ? options.conversation()
        : response(
            {
              ok: true,
              sessionId: session,
              messages: [],
              pending: 0,
              ...options.history,
            },
            options.historyStatus ?? 200
          );
    throw new Error('unexpected ' + url);
  });
  let actionButtons: Element[] = [];
  elements.get('turns')!.onHtml = (html) => {
    actionButtons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
      const button = new Element();
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g))
        button.setAttribute(attr[1], attr[2]);
      button.innerHTML = match[2];
      return button;
    });
  };
  const eventListeners: Record<string, Array<(detail?: { persisted?: boolean }) => void>> = {};
  const browser = window as typeof window & {
    addEventListener: (event: string, listener: (detail?: { persisted?: boolean }) => void) => void;
  };
  browser.addEventListener = (event, listener) => {
    (eventListeners[event] ??= []).push(listener);
  };
  const document = {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      const key = /^\.ask-chip\[data-chip="([^"]+)"\]$/.exec(selector)?.[1];
      return key ? (chips.get(key) ?? null) : null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === '.ask-chip') return [...chips.values()];
      const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      return attribute
        ? actionButtons.filter((button) => button.getAttribute(attribute) !== null)
        : [];
    },
  };
  elements.get('ask-send')!.disabled = true;
  const scripts = [
    ...(options.recoveryScript === false ? [] : ['ask-read-recovery.js']),
    ...(options.nextActionsScript === false ? [] : ['ask-next-actions.js']),
    ...(options.hearingScript === false ? [] : ['ask-hearing-recovery.js']),
    ...(options.completionScript === false ? [] : ['ask-hearing-completion.js']),
    'ask.js',
  ];
  runInNewContext(
    scripts
      .map((name) =>
        safeReadFile('presence/displays/presence-studio/static/' + name, {
          encoding: 'utf8',
        })
      )
      .join('\n'),
    {
      window,
      document,
      fetch,
      navigator: {},
      URL,
      URLSearchParams,
      crypto: window.crypto,
      console,
    }
  );
  window.KyberionAsk?.mount();
  return {
    elements,
    actions: () => actionButtons,
    browserEvent: (event: string, detail?: { persisted?: boolean }) =>
      eventListeners[event]?.forEach((listener) => listener(detail)),
    shell: (phase: string, message = '') =>
      shellListeners.forEach((listener) => listener({ phase, message })),
    chips,
    storage,
    fetch,
    window,
    input: elements.get('ask-input')!,
    form: elements.get('ask-form')!,
  };
}

export { Element, deferred, vocabularyTexts, session, response, flush, harness };
