import { describe, it, expect, vi, beforeEach } from 'vitest';

const ROW = 'table tr.item';

interface FakeDom {
  present: Set<string>;
  /** Attached but not shown. */
  hidden?: Set<string>;
  /** Row templates matched by row_selector but not shown. */
  hiddenRows?: Array<Record<string, string>>;
  rows: Array<Record<string, string>>;
  labels: Map<string, string[]>;
  total?: string;
  hang?: string;
  failFill?: boolean;
}

const mocks = vi.hoisted(() => ({
  tenant: 'acme' as string | undefined,
  files: new Map<string, string>(),
  runExternalOperation: vi.fn(),
  getSecret: vi.fn((_key: string): string | undefined => 'value'),
  launch: vi.fn(),
  dom: undefined as unknown as FakeDom,
  closed: 0,
}));

vi.mock('@agent/core/scope-envelope', () => ({ currentScopeEnvelope: () => undefined }));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeContext: () => ({ tenant_slug: mocks.tenant, tier: 'confidential' }),
}));
vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  pathResolver: {
    ...((await importOriginal()) as { pathResolver: object }).pathResolver,
    rootDir: () => '/repo',
    rootResolve: (relative: string) =>
      relative.startsWith('/') ? relative : `/repo/${relative.replace(/^\.\//, '')}`,
  },
}));
vi.mock('@agent/core/secure-io', () => ({
  safeReadFile: (file: string) => {
    const content = mocks.files.get(file);
    if (content === undefined) throw new Error(`missing ${file}`);
    return content;
  },
}));
vi.mock('@agent/core/secret/secret-guard', () => ({ getSecret: mocks.getSecret }));
vi.mock('@agent/core/secret/secret-identity', () => {
  const normalizeSecretKey = (key: string) => {
    const normalized = key
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)) throw new Error('invalid key');
    return normalized;
  };
  return {
    normalizeSecretKey,
    buildEnvSecretName: (service: string, key: string) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(service)) throw new Error('invalid service');
      return `${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${normalizeSecretKey(key)}`;
    },
  };
});
vi.mock('@agent/core/governance/external-operation', () => ({
  runExternalOperation: mocks.runExternalOperation,
}));
vi.mock('@playwright/test', () => ({ chromium: { launch: mocks.launch } }));

import {
  approvalQueueProfileHash,
  approvalQueueSecretName,
  inspectInsideConfinement,
  isDecisiveLabel,
  parseApprovalQueueProfile,
  runApprovalQueueInspect,
  sessionFreeUrl,
} from './approval-queue-inspect.js';

const PROFILE = {
  version: 1,
  system: 'workflow',
  origins: ['https://wf.example.jp'],
  credential: { service: 'workflow', user_key: 'login_user', password_key: 'login_password' },
  login: {
    url: 'https://wf.example.jp/login.aspx',
    user_selector: '#user',
    password_selector: '#pass',
    submit_selector: '#login',
    success_selector: '#menu',
  },
  navigate: [
    { goto: 'https://wf.example.jp/list.aspx' },
    { click: 'a.menu', has_text: '承認待ち' },
  ],
  list: {
    ready_selector: 'table#list',
    row_selector: ROW,
    empty_selector: '.no-items',
    fields: { title: 'td.title' },
  },
};

function fakeLocator(selectors: string[], visibleOnly = false): Record<string, unknown> {
  const dom = mocks.dom;
  const rowList = (visible: boolean) =>
    visible ? dom.rows : [...dom.rows, ...(dom.hiddenRows ?? [])];
  const matches = (selector: string, visible = false) =>
    selector === ROW
      ? rowList(visible).length > 0
      : dom.present.has(selector) && !(visible && dom.hidden?.has(selector));
  const locator: Record<string, unknown> = {
    selectors,
    visibleOnly,
    first: () => locator,
    filter: () => fakeLocator(selectors, true),
    or: (other: { selectors: string[]; visibleOnly: boolean }) =>
      fakeLocator([...selectors, ...other.selectors], visibleOnly || other.visibleOnly),
    waitFor: async (options?: { state?: string }) => {
      if (dom.hang && selectors.includes(dom.hang)) await new Promise(() => undefined);
      if (!selectors.some((s) => matches(s, visibleOnly || options?.state === 'visible')))
        throw new Error(
          `Timeout 30000ms exceeded.\nwaiting for locator('${selectors[0]}') at https://wf.example.jp/list.aspx;jsessionid=SECRET?token=SECRET`
        );
    },
    count: async () =>
      selectors[0] === ROW
        ? rowList(visibleOnly).length
        : selectors.some((selector) => matches(selector, visibleOnly))
          ? 1
          : 0,
    fill: async (value: string) => {
      if (dom.failFill) throw new Error(`fill failed\ncall log: value=${value}`);
    },
    click: async () => undefined,
    evaluate: async () => dom.labels.get(selectors[0]) ?? ['表示'],
    evaluateAll: async (fn: (elements: unknown[], args: unknown) => unknown, args: unknown) =>
      fn(
        rowList(visibleOnly).map((row) => ({
          querySelector: (selector: string) =>
            selector in row ? { innerText: row[selector], textContent: row[selector] } : null,
        })),
        args
      ),
    innerText: async () => dom.total ?? '',
  };
  return locator;
}

function fakeBrowser() {
  const page = {
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    url: () => 'https://wf.example.jp/list.aspx;jsessionid=SECRET?token=SECRET',
    locator: (selector: string) => fakeLocator([selector]),
  };
  const context = {
    addInitScript: async () => undefined,
    route: async () => undefined,
    routeWebSocket: async () => undefined,
    newPage: async () => page,
  };
  return {
    newContext: async () => context,
    close: async () => {
      mocks.closed += 1;
    },
  };
}

function rows(count: number, title = (index: number) => `申請 ${index}`) {
  return Array.from({ length: count }, (_, index) => ({ 'td.title': title(index) }));
}

beforeEach(() => {
  mocks.dom = {
    present: new Set(['#user', '#pass', '#login', '#menu', 'a.menu', 'table#list']),
    rows: rows(3),
    labels: new Map([['#login', ['ログイン']]]),
  };
  mocks.closed = 0;
  mocks.launch.mockReset();
  mocks.launch.mockImplementation(async () => fakeBrowser());
  mocks.getSecret.mockReset();
  mocks.getSecret.mockImplementation(() => 'value');
});

const inspect = (patch: Partial<typeof PROFILE> = {}, deadlineMs?: number) =>
  inspectInsideConfinement(
    parseApprovalQueueProfile({ ...PROFILE, ...patch }),
    'https://wf.example.jp',
    true,
    'knowledge/confidential/acme/approval-queues/workflow.json',
    deadlineMs
  );

describe('approval queue profile', () => {
  it('accepts a profile whose every URL stays inside the declared origins', () => {
    expect(parseApprovalQueueProfile(PROFILE).navigate).toHaveLength(2);
  });
  it.each([
    ['login outside the set', { login: { ...PROFILE.login, url: 'https://evil.example/login' } }],
    ['plain http login', { login: { ...PROFILE.login, url: 'http://wf.example.jp/login.aspx' } }],
    ['navigation outside the set', { navigate: [{ goto: 'https://evil.example/' }] }],
    ['mixed navigation step', { navigate: [{ goto: 'https://wf.example.jp/', click: 'a' }] }],
    ['unknown navigation key', { navigate: [{ evaluate: 'fetch()' }] }],
    [
      'too many navigation steps',
      { navigate: Array.from({ length: 21 }, () => ({ wait_for: 'a' })) },
    ],
    ['origin with a path', { origins: ['https://wf.example.jp/app'] }],
    ['unbounded item limit', { list: { ...PROFILE.list, max_items: 100_000 } }],
    ['no login success marker', { login: { ...PROFILE.login, success_selector: undefined } }],
    ['no list ready marker', { list: { ...PROFILE.list, ready_selector: undefined } }],
    ['no empty-state marker', { list: { ...PROFILE.list, empty_selector: undefined } }],
    ['an unsafe field name', { list: { ...PROFILE.list, fields: { __proto__x: 'td' } } }],
    [
      'too many fields',
      {
        list: {
          ...PROFILE.list,
          fields: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, 'td'])),
        },
      },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseApprovalQueueProfile({ ...PROFILE, ...patch })).toThrow(
      /^\[APPROVAL_QUEUE_PROFILE\] .+ — .+ \| next: .+ \| evidence: profile=/
    );
  });
  it('names the field, the value and the fix', () => {
    expect(() =>
      parseApprovalQueueProfile(
        { ...PROFILE, navigate: [{ evaluate: 'fetch()' }] },
        'knowledge/confidential/acme/approval-queues/workflow.json'
      )
    ).toThrow(
      'navigate[0] has unsupported keys: evaluate — the profile cannot run as written | next: use goto, click, has_text or wait_for | evidence: profile=knowledge/confidential/acme/approval-queues/workflow.json'
    );
    expect(() =>
      parseApprovalQueueProfile({
        ...PROFILE,
        login: { ...PROFILE.login, url: 'http://wf.example.jp/login.aspx' },
      })
    ).toThrow(/login\.url must use https/);
  });
});

describe('grant material', () => {
  it('hashes the file bytes and derives the secret-guard name', () => {
    expect(approvalQueueProfileHash('{}\n')).toBe(
      'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356'
    );
    expect(approvalQueueSecretName('shonin-time', 'login_user')).toBe('SHONIN_TIME_LOGIN_USER');
  });
});

describe('session-free result URL', () => {
  it('drops query, fragment and path parameters', () => {
    expect(sessionFreeUrl('https://wf.example.jp/app/list.do;jsessionid=SECRET?token=x#frag')).toBe(
      'https://wf.example.jp/app/list.do'
    );
  });
});

describe('decisive controls', () => {
  it.each([
    '承認',
    '一括承認',
    '承認します',
    '承認実行',
    '却下',
    '差戻し',
    '差し戻す',
    '否認',
    '確定',
    'Approve',
    'reject all',
  ])('refuses %s', (label) => expect(isDecisiveLabel(label)).toBe(true));
  it.each(['承認待ち一覧', 'ログイン', '表示', '申請一覧', '検索'])('allows %s', (label) =>
    expect(isDecisiveLabel(label)).toBe(false)
  );
});

describe('inspection run', () => {
  it('reads the rendered rows and returns a session-free URL', async () => {
    const result = await inspect();
    expect(result).toMatchObject({
      pending_count: 3,
      count_basis: 'rendered_rows',
      rendered_rows: 3,
      items: [{ title: '申請 0' }, { title: '申請 1' }, { title: '申請 2' }],
      truncated: false,
      extraction_misses: 0,
      final_url: 'https://wf.example.jp/list.aspx',
    });
    expect(mocks.closed).toBe(1);
  });

  it('reports zero only when the empty-state marker is shown', async () => {
    mocks.dom.rows = [];
    mocks.dom.present.add('.no-items');
    expect(await inspect()).toMatchObject({ pending_count: 0, truncated: false });
  });

  it('fails instead of reporting zero when neither rows nor the empty marker appear', async () => {
    mocks.dom.rows = [];
    await expect(inspect()).rejects.toThrow(/^\[APPROVAL_QUEUE_LIST\] list\.ready failed/);
    expect(mocks.closed).toBe(1);
  });

  it('does not count a hidden empty-state template as nothing pending', async () => {
    mocks.dom.rows = [];
    mocks.dom.present.add('.no-items');
    mocks.dom.hidden = new Set(['.no-items']);
    await expect(inspect()).rejects.toThrow(/^\[APPROVAL_QUEUE_LIST\] list\.ready failed/);
  });

  it('ignores hidden row templates when the empty state is shown', async () => {
    mocks.dom.rows = [];
    mocks.dom.hiddenRows = rows(2);
    mocks.dom.present.add('.no-items');
    expect(await inspect()).toMatchObject({ pending_count: 0, rendered_rows: 0, items: [] });
  });

  it('refuses a total smaller than the rows shown', async () => {
    mocks.dom.present.add('.total');
    mocks.dom.total = '1–20 / 全135件';
    await expect(inspect({ list: { ...PROFILE.list, total_selector: '.total' } })).rejects.toThrow(
      /^\[APPROVAL_QUEUE_LIST_INDETERMINATE\] list\.total_selector reads 1, fewer than the 3 rows shown/
    );
  });

  it('rejects credential keys that secret introduce would store under another name', () => {
    expect(() =>
      parseApprovalQueueProfile({
        ...PROFILE,
        credential: { ...PROFILE.credential, user_key: 'login-user' },
      })
    ).toThrow(/credential\.user_key is not a secret key name/);
  });

  it('prefers the system total and flags unrendered rows', async () => {
    mocks.dom.present.add('.total');
    mocks.dom.total = '全 1,045 件';
    expect(await inspect({ list: { ...PROFILE.list, total_selector: '.total' } })).toMatchObject({
      pending_count: 1045,
      count_basis: 'total_indicator',
      rendered_rows: 3,
      truncated: true,
      truncated_reason: 'not_rendered',
    });
  });

  it('bounds items by max_items and clips long values', async () => {
    mocks.dom.rows = rows(3, () => 'x'.repeat(1000));
    const result = await inspect({ list: { ...PROFILE.list, max_items: 2 } });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toHaveLength(512);
    expect(result).toMatchObject({
      truncated: true,
      truncated_reason: 'max_items',
      clipped_values: 2,
    });
  });

  it('fails when no field selector matches any row', async () => {
    await expect(
      inspect({ list: { ...PROFILE.list, fields: { title: 'td.missing' } } })
    ).rejects.toThrow(/No field selector matched in any row/);
  });

  it('classifies a sign-in timeout by phase without leaking session URLs', async () => {
    mocks.dom.present.delete('#menu');
    const error = await inspect().catch((caught: Error) => caught);
    expect(error.message).toMatch(
      /^\[APPROVAL_QUEUE_LOGIN\] login\.confirm failed — Timeout 30000ms exceeded\. \| next: .+ \| evidence: phase=login\.confirm url=https:\/\/wf\.example\.jp\/list\.aspx/
    );
    expect(error.message).not.toContain('SECRET');
    expect(mocks.closed).toBe(1);
  });

  it('reports a rejected sign-in as soon as the failure marker shows', async () => {
    mocks.dom.present.delete('#menu');
    mocks.dom.present.add('.login-error');
    await expect(
      inspect({ login: { ...PROFILE.login, failure_selector: '.login-error' } })
    ).rejects.toThrow(
      /^\[APPROVAL_QUEUE_LOGIN_REJECTED\] .+secret introduce workflow LOGIN_PASSWORD/
    );
  });

  it('never echoes a credential from a failed fill', async () => {
    mocks.dom.failFill = true;
    mocks.getSecret.mockImplementation(() => 'hunter2');
    const error = await inspect().catch((caught: Error) => caught);
    expect(error.message).toMatch(
      /^\[APPROVAL_QUEUE_LOGIN\] login\.fill failed — could not fill #user/
    );
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses a decisive click and names the step', async () => {
    mocks.dom.labels.set('a.menu', ['', '承認']);
    await expect(inspect()).rejects.toThrow(
      /^\[APPROVAL_QUEUE_DECISIVE_CLICK\] navigate\[1\] would press "承認"/
    );
    expect(mocks.closed).toBe(1);
  });

  it('stops at the deadline and closes the browser', async () => {
    mocks.dom.hang = 'table#list';
    await expect(inspect({}, 50)).rejects.toThrow(
      /^\[APPROVAL_QUEUE_DEADLINE\] .+ \| evidence: phase=list\.ready/
    );
    expect(mocks.closed).toBe(1);
  });

  it('says how to install Chromium when it cannot launch', async () => {
    mocks.launch.mockRejectedValue(new Error("Executable doesn't exist at /x/chrome"));
    await expect(inspect()).rejects.toThrow(
      /^\[APPROVAL_QUEUE_LAUNCH\] .+playwright install chromium/
    );
  });

  it('names the missing secret and how to register it before launching', async () => {
    mocks.getSecret.mockImplementation(() => undefined);
    await expect(inspect()).rejects.toThrow(
      /^\[APPROVAL_QUEUE_CREDENTIAL\] .+secret introduce workflow LOGIN_USER.+secret=WORKFLOW_LOGIN_USER/
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('runApprovalQueueInspect admission', () => {
  beforeEach(() => {
    mocks.tenant = 'acme';
    mocks.files.clear();
    mocks.files.set(
      '/repo/knowledge/confidential/acme/approval-queues/workflow.json',
      JSON.stringify(PROFILE)
    );
    mocks.runExternalOperation.mockReset();
  });

  it('admits one delegable, observation-only operation bound to origin and profile hash', async () => {
    const inspection = { system: 'workflow', pending_count: 0, items: [] };
    mocks.runExternalOperation.mockResolvedValue(inspection);
    const result = await runApprovalQueueInspect(
      {
        profile: 'knowledge/confidential/acme/approval-queues/workflow.json',
        origin: 'https://wf.example.jp',
      },
      {}
    );
    const [operation] = mocks.runExternalOperation.mock.calls[0];
    expect(operation).toMatchObject({
      operationId: 'browser:approval_queue_inspect',
      tenantSlug: 'acme',
      requiresApproval: true,
      delegable: true,
      observationOnly: true,
      effect: {
        navigation_confinement: 'authenticated-origin-set-v1',
        origin: 'https://wf.example.jp',
        confined_origins: ['https://wf.example.jp'],
        profile_path: 'knowledge/confidential/acme/approval-queues/workflow.json',
        profile_hash: approvalQueueProfileHash(JSON.stringify(PROFILE)),
      },
    });
    expect(result.context.approval_queue).toBe(inspection);
  });

  it('requires a tenant-bound execution', async () => {
    mocks.tenant = undefined;
    await expect(
      runApprovalQueueInspect(
        {
          profile: 'knowledge/confidential/acme/approval-queues/workflow.json',
          origin: 'https://wf.example.jp',
        },
        {}
      )
    ).rejects.toThrow(/^\[APPROVAL_QUEUE_SCOPE\]/);
    expect(mocks.runExternalOperation).not.toHaveBeenCalled();
  });

  it.each([
    'knowledge/confidential/other/approval-queues/workflow.json',
    'knowledge/confidential/acme/approval-queues/../charters/x.json',
    'knowledge/confidential/acme/approval-queues/workflow.md',
  ])('refuses profile path %s', async (profile) => {
    await expect(
      runApprovalQueueInspect({ profile, origin: 'https://wf.example.jp' }, {})
    ).rejects.toThrow(/APPROVAL_QUEUE_PROFILE_PATH.+approval-queues\/ as a \.json file/);
  });

  it('reports invalid JSON with the profile path', async () => {
    mocks.files.set(
      '/repo/knowledge/confidential/acme/approval-queues/workflow.json',
      '{ "version": 1,'
    );
    await expect(
      runApprovalQueueInspect(
        {
          profile: 'knowledge/confidential/acme/approval-queues/workflow.json',
          origin: 'https://wf.example.jp',
        },
        {}
      )
    ).rejects.toThrow(
      /^\[APPROVAL_QUEUE_PROFILE\] knowledge\/confidential\/acme\/approval-queues\/workflow\.json is not valid JSON/
    );
  });

  it('refuses an undeclared origin and extra inputs, listing what is allowed', async () => {
    const profile = 'knowledge/confidential/acme/approval-queues/workflow.json';
    await expect(
      runApprovalQueueInspect({ profile, origin: 'https://evil.example' }, {})
    ).rejects.toThrow(/APPROVAL_QUEUE_INPUT.+set origin to one of https:\/\/wf\.example\.jp/);
    await expect(
      runApprovalQueueInspect({ profile, origin: 'https://wf.example.jp', script: 'x' }, {})
    ).rejects.toThrow(/^\[APPROVAL_QUEUE_INPUT\] Unsupported parameters: script/);
    expect(mocks.runExternalOperation).not.toHaveBeenCalled();
  });
});
