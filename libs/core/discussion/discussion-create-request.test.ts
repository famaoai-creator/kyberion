import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiscussionRequest,
  DiscussionRequestConflictError,
  recoverDiscussionRequest,
  type CreateDiscussionRequestInput,
} from './discussion-create-request.js';
import type { DiscussionConfig } from './discussion-types.js';

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  publish: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  afterPublish: undefined as undefined | ((path: string, contents: string) => void),
}));
vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safePublishExclusiveFileSync: io.publish,
  safeReadFileSnapshot: io.read,
  safeLstat: io.stat,
}));
vi.mock('./discussion-request-storage-scope.js', () => ({
  withDiscussionRequestReceiptAccess: (_scope: unknown, fn: () => unknown) => fn(),
}));
function missing() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}
function fixture(
  overrides: Partial<CreateDiscussionRequestInput> = {}
): CreateDiscussionRequestInput {
  return {
    request_id: randomUUID(),
    actor: { principal_id: 'test-owner', source: 'token' },
    scope: {
      tenant_slug: 'fixture',
      organization_id: 'org',
      project_id: 'project',
      mission_id: 'mission',
    },
    input: { goal: 'Choose a plan', config: { speaker: 'scripted' } },
    ...overrides,
  };
}
function findFile(suffix: string): string {
  const found = [...io.files.keys()].find((key) => key.endsWith(suffix));
  if (!found) throw new Error('Fixture file missing: ' + suffix);
  return found;
}
function reservation() {
  return findFile('/reservation.json');
}
function receipt() {
  return findFile('/receipt.json');
}
function events() {
  return findFile('/events.jsonl');
}
function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Fixture must contain a JSON object');
  return value as Record<string, unknown>;
}
function patch(file: string, update: (value: Record<string, unknown>) => void) {
  const value = objectRecord(JSON.parse(io.files.get(file)!));
  update(value);
  io.files.set(file, JSON.stringify(value) + '\n');
}
function assertUnconfirmed(input: CreateDiscussionRequestInput) {
  expect(recoverDiscussionRequest(input)).toMatchObject({
    request: { status: 'unconfirmed' },
    should_start: false,
  });
  expect(createDiscussionRequest(input)).toMatchObject({
    request: { status: 'unconfirmed' },
    should_start: false,
  });
}
beforeEach(() => {
  io.files.clear();
  io.afterPublish = undefined;
  io.publish.mockReset().mockImplementation((file: string, contents: string) => {
    if (io.files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    io.files.set(file, contents);
    io.afterPublish?.(file, contents);
  });
  io.stat.mockReset().mockImplementation((file: string) => {
    if (!io.files.has(file)) throw missing();
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: Buffer.byteLength(io.files.get(file)!),
      dev: 1,
      ino: 1,
      mtimeMs: 1,
      ctimeMs: 1,
    };
  });
  io.read.mockReset().mockImplementation((file: string, maxBytes: number) => {
    if (!io.files.has(file)) throw missing();
    const bytes = Buffer.from(io.files.get(file)!);
    if (bytes.length > maxBytes) throw new Error('oversized snapshot');
    return bytes;
  });
});

describe('scoped permanent Discussion creation requests', () => {
  it('allows one launch winner and makes every duplicate/recovery read-only', () => {
    const input = fixture();
    const first = createDiscussionRequest(input);
    expect(first).toMatchObject({ request: { status: 'created' }, should_start: true });
    expect(first.room).toMatchObject({
      execution: null,
      status: 'forming',
      config: { speaker: 'scripted' },
    });
    expect(first.room?.id).toMatch(/^disc-request-[a-f0-9]{64}$/);
    expect(reservation()).toContain('/discussion-create-requests/confidential/fixture/by-actor/');
    expect(createDiscussionRequest(input)).toMatchObject({
      request: first.request,
      should_start: false,
    });
    expect(recoverDiscussionRequest(input)).toMatchObject({
      request: first.request,
      should_start: false,
    });
    expect(io.publish).toHaveBeenCalledTimes(3);
    expect(io.files.size).toBe(3);
    const persisted = JSON.parse(io.files.get(reservation())!);
    expect(persisted).not.toHaveProperty('intent');
    expect(persisted).not.toHaveProperty('goal');
    expect(persisted).not.toHaveProperty('config');
  });

  it.each(['reservation', 'receipt'])(
    'retries only transient ancestor instability for %s without repeating publication',
    (record) => {
      const input = fixture();
      const original = io.read.getMockImplementation()!;
      let attempts = 0;
      io.read.mockImplementation((file: string, maxBytes: number) => {
        if (file.endsWith('/' + record + '.json') && ++attempts < 8)
          throw new Error('[SECURITY] Snapshot ancestor changed during read');
        return original(file, maxBytes);
      });
      expect(createDiscussionRequest(input)).toMatchObject({
        request: { status: 'created' },
        should_start: true,
      });
      expect(attempts).toBeGreaterThanOrEqual(8);
      expect(io.publish).toHaveBeenCalledTimes(3);
      expect(recoverDiscussionRequest(input).should_start).toBe(false);
    }
  );

  it.each(['reservation', 'receipt'])(
    'fails closed after eight unstable %s snapshots without repeating publication',
    (record) => {
      const input = fixture();
      const original = io.read.getMockImplementation()!;
      let attempts = 0;
      io.read.mockImplementation((file: string, maxBytes: number) => {
        if (file.endsWith('/' + record + '.json')) {
          attempts++;
          throw new Error('[SECURITY] Snapshot ancestor changed during read');
        }
        return original(file, maxBytes);
      });
      expect(createDiscussionRequest(input)).toMatchObject({
        request: { status: 'unconfirmed' },
        should_start: false,
      });
      expect(attempts).toBe(8);
      expect(io.publish).toHaveBeenCalledTimes(record === 'reservation' ? 1 : 3);
      io.read.mockImplementation(original);
      expect(recoverDiscussionRequest(input).should_start).toBe(false);
      expect(createDiscussionRequest(input).should_start).toBe(false);
      expect(io.publish).toHaveBeenCalledTimes(record === 'reservation' ? 1 : 3);
    }
  );

  it.each(['snapshot', 'retry'])(
    'never treats an observed record disappearing during %s as absent',
    (phase) => {
      const input = fixture();
      io.afterPublish = (file) => {
        if (file.endsWith('/reservation.json')) throw new Error('interrupted after reservation');
      };
      expect(createDiscussionRequest(input).should_start).toBe(false);
      io.afterPublish = undefined;
      const claim = reservation();
      io.read.mockImplementation(() => {
        io.files.delete(claim);
        if (phase === 'retry') throw new Error('[SECURITY] Snapshot ancestor changed during read');
        throw missing();
      });
      expect(createDiscussionRequest(input)).toMatchObject({
        request: { status: 'unconfirmed' },
        should_start: false,
      });
      expect(io.read).toHaveBeenCalledTimes(1);
      expect(io.publish).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'])(
    'rejects a changed pinned leaf %s between ancestor-instability retries',
    (field) => {
      const input = fixture();
      const originalRead = io.read.getMockImplementation()!;
      const originalStat = io.stat.getMockImplementation()!;
      let failed = false;
      io.read.mockImplementation((file: string, maxBytes: number) => {
        if (file.endsWith('/reservation.json') && !failed) {
          failed = true;
          throw new Error('[SECURITY] Snapshot ancestor changed during read');
        }
        return originalRead(file, maxBytes);
      });
      io.stat.mockImplementation((file: string) => {
        const stat = originalStat(file);
        return failed && file.endsWith('/reservation.json')
          ? { ...stat, [field]: stat[field] + 1 }
          : stat;
      });
      expect(createDiscussionRequest(input)).toMatchObject({
        request: { status: 'unconfirmed' },
        should_start: false,
      });
      expect(io.read).toHaveBeenCalledTimes(1);
      expect(io.publish).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    '[SECURITY] Read access denied',
    '[SECURITY] Refusing to read symbolic link',
    '[SECURITY] Foreign hard link',
    '[SECURITY] File changed before snapshot read',
    '[SECURITY] File changed during snapshot read',
    'File exceeds snapshot byte limit',
    '[SECURITY] Snapshot ancestor changed during read: unrecognized variation',
  ])('does not retry other snapshot failures: %s', (message) => {
    const input = fixture();
    io.read.mockImplementation(() => {
      throw new Error(message);
    });
    expect(createDiscussionRequest(input)).toMatchObject({
      request: { status: 'unconfirmed' },
      should_start: false,
    });
    expect(io.read).toHaveBeenCalledTimes(1);
    expect(io.publish).toHaveBeenCalledTimes(1);
  });

  it('normalizes effective goal/title/config and default confidential scope before hashing', () => {
    const input = fixture({
      input: {
        goal: '  Choose a plan  ',
        title: ' ',
        config: { speaker: 'scripted', max_rounds: 99, single_pass: false },
      },
    });
    const first = createDiscussionRequest(input);
    const second = createDiscussionRequest({
      ...input,
      scope: { ...input.scope, tier: 'confidential' },
      input: {
        goal: 'Choose a plan',
        title: 'Choose a plan',
        config: { speaker: 'scripted', max_rounds: 8 },
      },
    });
    expect(second.request).toEqual(first.request);
    expect(second.should_start).toBe(false);
    const title = 'x'.repeat(120);
    const other = fixture({
      input: { goal: 'goal', title: title + 'ignored', config: { speaker: 'scripted' } },
    });
    const room = createDiscussionRequest(other);
    expect(createDiscussionRequest({ ...other, input: { ...other.input, title } }).request).toEqual(
      room.request
    );
  });

  it.each([
    ['goal', { goal: 'Different goal' }],
    ['title', { title: 'Different title' }],
    ['max_rounds', { config: { max_rounds: 2 } }],
    ['max_messages', { config: { max_messages: 9 } }],
    ['consensus_threshold', { config: { consensus_threshold: 0.5 } }],
    ['turn_delay_ms', { config: { turn_delay_ms: 1 } }],
    ['locale', { config: { locale: 'en' } }],
    ['speaker', { config: { speaker: 'reasoning', provider: 'codex' } }],
    ['provider', { config: { provider: 'codex' } }],
    ['max_provider_calls', { config: { max_provider_calls: 2 } }],
    ['provider_timeout_ms', { config: { provider_timeout_ms: 1000 } }],
    ['single_pass', { config: { single_pass: true } }],
    ['mode', { config: { mode: 'dialogue' } }],
  ] as const)('conflicts on changed semantic %s in the same namespace', (_label, changed) => {
    const input = fixture();
    createDiscussionRequest(input);
    const update = changed as { goal?: string; title?: string; config?: Partial<DiscussionConfig> };
    expect(() =>
      createDiscussionRequest({
        ...input,
        input: { ...input.input, ...update, config: { ...input.input.config, ...update.config } },
      })
    ).toThrow(DiscussionRequestConflictError);
    expect(io.publish).toHaveBeenCalledTimes(3);
  });

  it.each(['principal', 'source', 'member', 'tenant', 'organization', 'project', 'mission'])(
    'uses separate namespaces for %s and never scans other namespaces',
    (field) => {
      const input = fixture();
      const first = createDiscussionRequest(input);
      const other = structuredClone(input);
      if (field === 'principal') other.actor.principal_id = 'another';
      if (field === 'source') other.actor.source = 'loopback';
      if (field === 'member') other.actor.member_id = 'member';
      if (field === 'tenant') other.scope.tenant_slug = 'another-tenant';
      if (field === 'organization') other.scope.organization_id = 'another-org';
      if (field === 'project') other.scope.project_id = 'another-project';
      if (field === 'mission') other.scope.mission_id = 'another-mission';
      const second = createDiscussionRequest(other);
      expect(second.should_start).toBe(true);
      expect(second.request.room_id).not.toBe(first.request.room_id);
      expect(io.files.size).toBe(6);
    }
  );

  it('requires a real tenant for both token and loopback actors', () => {
    const input = fixture({ actor: { principal_id: 'local', source: 'loopback' }, scope: {} });
    expect(() => createDiscussionRequest(input)).toThrow(/tenant/);
    expect(() =>
      createDiscussionRequest({ ...input, actor: { ...input.actor, source: 'token' } })
    ).toThrow(/tenant/);
    expect(() =>
      createDiscussionRequest({ ...input, scope: { project_id: 'tenant-project' } })
    ).toThrow(/tenant/);
    for (const tier of ['personal', 'public'] as const)
      expect(() =>
        createDiscussionRequest({ ...input, scope: { tier, tenant_slug: 'fixture' } })
      ).toThrow(/confidential/);
    expect(() => createDiscussionRequest({ ...input, scope: { tenant_slug: 'shared' } })).toThrow(
      /tenant/
    );
    expect(io.publish).not.toHaveBeenCalled();
  });

  it('treats a different scope/actor lookup as unknown without leaking the original room', () => {
    const input = fixture();
    createDiscussionRequest(input);
    expect(
      recoverDiscussionRequest({ ...input, actor: { ...input.actor, principal_id: 'outsider' } })
    ).toEqual({
      request: {
        request_id: input.request_id,
        status: 'unconfirmed',
        reason: 'outcome_unconfirmed',
      },
      should_start: false,
    });
  });

  it.each(['', '{', 'null', '[]', '{}', '"text"', 'x'.repeat(33 * 1024)])(
    'never reclaims invalid reservation case %#',
    (contents) => {
      const input = fixture();
      createDiscussionRequest(input);
      const claim = reservation();
      io.files.set(claim, contents);
      const calls = io.publish.mock.calls.length;
      assertUnconfirmed(input);
      expect(io.publish).toHaveBeenCalledTimes(calls);
      expect(io.files.get(claim)).toBe(contents);
    }
  );

  it.each(['', '{', 'null', '{}', 'x'.repeat(33 * 1024)])(
    'keeps corrupted terminal commitment unconfirmed even with a bound room: %#',
    (contents) => {
      const input = fixture();
      createDiscussionRequest(input);
      io.files.set(receipt(), contents);
      assertUnconfirmed(input);
    }
  );

  it('never overwrites existing state if the reservation disappeared', () => {
    const input = fixture();
    createDiscussionRequest(input);
    io.files.delete(reservation());
    const calls = io.publish.mock.calls.length;
    assertUnconfirmed(input);
    expect(io.publish).toHaveBeenCalledTimes(calls);
  });

  it('never creates a missing room after an interrupted reservation', () => {
    const input = fixture();
    io.afterPublish = (file) => {
      if (file.endsWith('/reservation.json')) throw new Error('crash');
    };
    expect(createDiscussionRequest(input).should_start).toBe(false);
    expect(io.files.size).toBe(1);
    io.afterPublish = undefined;
    assertUnconfirmed(input);
    expect(io.files.size).toBe(1);
  });

  it('recovers bound room metadata after commit loss without ever launching', () => {
    const input = fixture();
    io.afterPublish = (file) => {
      if (file.endsWith('/events.jsonl')) throw new Error('crash');
    };
    expect(createDiscussionRequest(input).should_start).toBe(false);
    expect(io.files.size).toBe(2);
    io.afterPublish = undefined;
    expect(recoverDiscussionRequest(input)).toMatchObject({
      request: { status: 'created' },
      should_start: false,
    });
    expect(createDiscussionRequest(input)).toMatchObject({
      request: { status: 'created' },
      should_start: false,
    });
    expect(io.files.size).toBe(2);
  });

  it('does not return launch permission if committed receipt readback fails', () => {
    const input = fixture();
    io.afterPublish = (file) => {
      if (file.endsWith('/receipt.json')) throw new Error('lost acknowledgement');
    };
    expect(createDiscussionRequest(input).should_start).toBe(false);
    io.afterPublish = undefined;
    expect(recoverDiscussionRequest(input)).toMatchObject({
      request: { status: 'created' },
      should_start: false,
    });
  });

  it.each(['create', 'reject'])(
    'does not %s over an orphan room directory after record loss',
    (mode) => {
      const input = fixture();
      createDiscussionRequest(input);
      const directory = events().slice(0, -'/events.jsonl'.length);
      io.files.clear();
      const originalStat = io.stat.getMockImplementation()!;
      io.stat.mockImplementation((file: string) =>
        file === directory
          ? { isFile: () => false, isSymbolicLink: () => false, size: 0 }
          : originalStat(file)
      );
      const before = io.publish.mock.calls.length;
      expect(
        createDiscussionRequest({
          ...input,
          ...(mode === 'reject' ? { rejection: 'prerequisites_blocked' as const } : {}),
        })
      ).toMatchObject({ request: { status: 'unconfirmed' }, should_start: false });
      expect(io.publish).toHaveBeenCalledTimes(before);
    }
  );

  it('does not restart an accepted room whose event log is missing', () => {
    const input = fixture();
    createDiscussionRequest(input);
    io.files.delete(events());
    assertUnconfirmed(input);
    expect(io.files.size).toBe(2);
  });

  it.each([
    'empty',
    'torn',
    'missing-created',
    'duplicate-created',
    'scope',
    'actor',
    'source-digest',
    'full-config',
    'initial-title',
  ])('rejects invalid original room evidence: %s', (kind) => {
    const input = fixture();
    createDiscussionRequest(input);
    const file = events();
    if (kind === 'empty') io.files.set(file, '');
    if (kind === 'torn') io.files.set(file, io.files.get(file)! + '{');
    if (kind === 'missing-created')
      io.files.set(
        file,
        JSON.stringify({
          seq: 1,
          ts: new Date().toISOString(),
          type: 'status_changed',
          status: 'forming',
        })
      );
    if (kind === 'duplicate-created') {
      const initial = JSON.parse(io.files.get(file)!);
      io.files.set(file, io.files.get(file)! + JSON.stringify({ ...initial, seq: 2 }) + '\n');
    }
    if (kind === 'scope')
      patch(file, (event) => {
        objectRecord(event.scope).mission_id = 'another';
      });
    if (kind === 'actor')
      patch(file, (event) => {
        event.created_by = 'another';
      });
    if (kind === 'source-digest')
      patch(file, (event) => {
        objectRecord(event.request_binding).actor_sha256 = 'x';
      });
    if (kind === 'full-config')
      patch(file, (event) => {
        objectRecord(event.config).consensus_threshold = 0.1;
      });
    if (kind === 'initial-title')
      patch(file, (event) => {
        event.title = 'changed';
      });
    assertUnconfirmed(input);
  });

  it('validates the original title rather than a legitimate later rename', () => {
    const input = fixture();
    createDiscussionRequest(input);
    const file = events();
    io.files.set(
      file,
      io.files.get(file)! +
        JSON.stringify({
          seq: 2,
          ts: new Date().toISOString(),
          type: 'room_renamed',
          title: 'New title',
          actor: 'test-owner',
        }) +
        '\n'
    );
    expect(recoverDiscussionRequest(input)).toMatchObject({
      request: { status: 'created' },
      room: { title: 'New title' },
      should_start: false,
    });
  });

  it('reserves rejection permanently and never turns it into an accepted request', () => {
    const input = fixture();
    expect(createDiscussionRequest({ ...input, rejection: 'prerequisites_blocked' })).toMatchObject(
      {
        request: { status: 'rejected', reason: 'prerequisites_blocked' },
        should_start: false,
      }
    );
    expect(io.files.size).toBe(2);
    expect(createDiscussionRequest(input).request.status).toBe('rejected');
    expect(recoverDiscussionRequest(input).request.status).toBe('rejected');
    expect(io.publish).toHaveBeenCalledTimes(2);
  });

  it('never changes accepted creation to rejection after readiness changes', () => {
    const input = fixture();
    const first = createDiscussionRequest(input);
    expect(createDiscussionRequest({ ...input, rejection: 'prerequisites_blocked' })).toMatchObject(
      { request: first.request, should_start: false }
    );
  });

  it('does not accept a rejected receipt colliding with an existing room', () => {
    const input = fixture();
    createDiscussionRequest(input);
    patch(receipt(), (record) => {
      record.status = 'rejected';
      record.reason = 'prerequisites_blocked';
    });
    assertUnconfirmed(input);
  });

  it('fails closed for denied, symlink, nonregular, and oversized reads', () => {
    const input = fixture();
    createDiscussionRequest(input);
    for (const error of ['denied', 'symlink', 'nonregular', 'oversized']) {
      io.read.mockImplementation(() => {
        throw new Error(error);
      });
      assertUnconfirmed(input);
    }
    expect(io.publish).toHaveBeenCalledTimes(3);
  });

  it.each(['same', 'changed'])(
    'handles an exclusive reservation collision for %s intent without creating a room',
    (kind) => {
      const input = fixture();
      createDiscussionRequest(input);
      const claimPath = reservation();
      const winner = io.files.get(claimPath)!;
      io.files.clear();
      io.publish.mockImplementation((file: string) => {
        expect(file).toBe(claimPath);
        io.files.set(file, winner);
        throw Object.assign(new Error('another process won'), { code: 'EEXIST' });
      });
      const retry = {
        ...input,
        input: { ...input.input, goal: kind === 'changed' ? 'Other goal' : input.input.goal },
      };
      if (kind === 'changed')
        expect(() => createDiscussionRequest(retry)).toThrow(DiscussionRequestConflictError);
      else
        expect(createDiscussionRequest(retry)).toMatchObject({
          request: { status: 'unconfirmed' },
          should_start: false,
        });
      expect(io.files.size).toBe(1);
    }
  );

  it.each(['intent_sha256', 'actor_sha256', 'scope_sha256', 'room_id', 'actor', 'scope'])(
    'fails closed for corrupted reservation identity %s',
    (key) => {
      const input = fixture();
      createDiscussionRequest(input);
      patch(reservation(), (record) => {
        record[key] = 'invalid';
      });
      assertUnconfirmed(input);
      expect(io.publish).toHaveBeenCalledTimes(3);
    }
  );

  it('rejects invalid UUID and config before reserving', () => {
    for (const request_id of ['../escape', '', 'not-a-uuid'])
      expect(() => createDiscussionRequest(fixture({ request_id }))).toThrow(/UUID/);
    for (const config of [{ consensus_threshold: NaN }, { locale: 'bad' }, { max_rounds: -1 }])
      expect(() =>
        createDiscussionRequest(
          fixture({ input: { goal: 'goal', config: config as Partial<DiscussionConfig> } })
        )
      ).toThrow();
    expect(io.publish).not.toHaveBeenCalled();
  });
});

describe('real child-process reservation and restart boundaries', () => {
  // Synthetic requests use the real scoped receipt capability and secure I/O.
  // Each process is a fresh normal-role runtime; no provider is imported or called.
  const child = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const args = JSON.parse(process.argv[1]);
    const root = process.cwd();
    const source = (name) => pathToFileURL(root + '/libs/core/' + name + '.ts').href;
    const realIo = source('secure-io');
    const proxy = 'data:text/javascript,' + encodeURIComponent(
      'export * from ' + JSON.stringify(realIo) + ';' +
      'import { safePublishExclusiveFileSync as publish } from ' + JSON.stringify(realIo) + ';' +
      'export function safePublishExclusiveFileSync(file, content) {' +
      'publish(file, content);' +
      (args.crash === 'reservation' ? 'if(file.endsWith("/reservation.json"))process.exit(77);' : '') +
      (args.crash === 'room' ? 'if(file.endsWith("/events.jsonl"))process.exit(77);' : '') +
      (args.crash === 'receipt' ? 'if(file.endsWith("/receipt.json"))process.exit(77);' : '') +
      '}'
    );
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === '../secure-io.js' &&
            /\\/discussion-(create-request|store)\\.ts(?:\\?|$)/.test(context.parentURL || ''))
          return { url: proxy, shortCircuit: true };
        return next(specifier, context);
      },
    });
    const { withExecutionContext } = await import(source('authority'));
    const api = await import(source('discussion/discussion-create-request'));
    const result = withExecutionContext('chronos_localadmin', () =>
      args.mode === 'recover' ? api.recoverDiscussionRequest(args.input) : api.createDiscussionRequest(args.input),
      undefined, args.input.scope.tenant_slug);
    console.log('DISCUSSION_RESULT ' + JSON.stringify(result));
  `;

  async function seedFixture(fixturePath: string) {
    const { withExecutionContext } = await import('../authority.js');
    const { safeReadFile, safeWriteFile, safeMkdir } = await import('../secure-io.js');
    const { pathResolver } = await import('../path-resolver.js');
    withExecutionContext('ecosystem_architect', () => {
      safeWriteFile(pathResolver.shared(fixturePath + '/package.json'), '{}');
      safeWriteFile(
        pathResolver.shared(fixturePath + '/knowledge/personal/tenants/fixture.json'),
        JSON.stringify({ tenant_slug: 'fixture', status: 'active' })
      );
      safeMkdir(pathResolver.shared(fixturePath + '/active/shared/runtime'), { recursive: true });
      for (const file of [
        'security-policy.json',
        'agent-policies.yaml',
        'role-assumption-policy.json',
        'role-authority-map.json',
        'env-registry.json',
        'mission-management-config.json',
        'authority-roles/chronos_localadmin.json',
        'authority-roles/discussion_request_store.json',
      ]) {
        const relative = 'knowledge/product/governance/' + file;
        safeWriteFile(
          pathResolver.shared(fixturePath + '/' + relative),
          safeReadFile(pathResolver.rootResolve(relative))
        );
      }
    });
  }

  async function runChild(
    fixturePath: string,
    input: CreateDiscussionRequestInput,
    mode = 'create',
    crash?: string
  ) {
    const { withExecutionContextAsync } = await import('../authority.js');
    const { safeExecResultAsync } = await import('../secure-io.js');
    const { pathResolver } = await import('../path-resolver.js');
    return withExecutionContextAsync('ecosystem_architect', () =>
      safeExecResultAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          child,
          JSON.stringify({ fixture: fixturePath, input, mode, crash }),
        ],
        {
          timeoutMs: 30000,
          env: {
            KYBERION_ROOT: pathResolver.shared(fixturePath),
            MISSION_ROLE: '',
            SYSTEM_ROLE: '',
            MISSION_ID: '',
            KYBERION_TENANT_SLUG: '',
            KYBERION_PERSONA: '',
            KYBERION_SUDO: '',
          },
        }
      )
    );
  }
  function result(output: { status: number | null; stdout: string; stderr: string }) {
    expect(output.status, output.stderr + output.stdout).toBe(0);
    const line = output.stdout.split('\n').find((entry) => entry.startsWith('DISCUSSION_RESULT '));
    expect(line, output.stderr + output.stdout).toBeTruthy();
    return JSON.parse(line!.slice('DISCUSSION_RESULT '.length));
  }
  async function cleanup(fixturePath: string) {
    const { withExecutionContext } = await import('../authority.js');
    const { safeRmSync } = await import('../secure-io.js');
    const { pathResolver } = await import('../path-resolver.js');
    withExecutionContext('ecosystem_architect', () =>
      safeRmSync(pathResolver.shared(fixturePath), { recursive: true, force: true })
    );
  }

  it('creates once under the normal role and recovers in a fresh process without a race', async () => {
    const fixturePath = 'tmp/discussion-request-process-' + randomUUID();
    const input = fixture();
    try {
      await seedFixture(fixturePath);
      const first = result(await runChild(fixturePath, input));
      expect(first).toMatchObject({ request: { status: 'created' }, should_start: true });
      expect(first.room.execution).toBeNull();
      expect(result(await runChild(fixturePath, input, 'recover'))).toMatchObject({
        request: first.request,
        should_start: false,
      });
      expect(result(await runChild(fixturePath, input))).toMatchObject({
        request: first.request,
        should_start: false,
      });
    } finally {
      await cleanup(fixturePath);
    }
  }, 60000);

  it('gives exactly one launch across clean simultaneous OS processes and no launch after restart', async () => {
    const fixturePath = 'tmp/discussion-request-process-' + randomUUID();
    const input = fixture();
    try {
      await seedFixture(fixturePath);
      const outputs = await Promise.all(
        Array.from({ length: 4 }, () => runChild(fixturePath, input))
      );
      const results = outputs.map(result);
      const winners = results.filter((entry) => entry.should_start);
      expect(winners.length, JSON.stringify(outputs)).toBe(1);
      expect(
        new Set(
          results.filter((entry) => entry.request.room_id).map((entry) => entry.request.room_id)
        ).size
      ).toBeLessThanOrEqual(1);
      const { withExecutionContext } = await import('../authority.js');
      const { safeReadFile } = await import('../secure-io.js');
      const { pathResolver } = await import('../path-resolver.js');
      const stable = (value: unknown): string =>
        value && typeof value === 'object'
          ? '{' +
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => JSON.stringify(key) + ':' + stable(entry))
              .join(',') +
            '}'
          : JSON.stringify(value);
      const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
      const record = withExecutionContext('ecosystem_architect', () =>
        safeReadFile(
          pathResolver.shared(
            fixturePath +
              '/active/shared/runtime/discussion-create-requests/confidential/fixture/by-actor/' +
              hash(input.actor) +
              '/' +
              hash({ ...input.scope, tier: 'confidential' }) +
              '/' +
              input.request_id +
              '/reservation.json'
          ),
          { encoding: 'utf8' }
        )
      );
      expect(JSON.parse(record as string)).toMatchObject({
        request_id: input.request_id,
        version: 1,
      });
      const recovered = result(await runChild(fixturePath, input, 'recover'));
      expect(recovered.should_start).toBe(false);
      expect(recovered.request.status).toBe('created');
      expect(result(await runChild(fixturePath, input))).toMatchObject({
        request: recovered.request,
        should_start: false,
      });
    } finally {
      await cleanup(fixturePath);
    }
  }, 60000);

  it.each([
    ['reservation', 'unconfirmed'],
    ['room', 'created'],
    ['receipt', 'created'],
  ])(
    'never launches after process death following %s publication',
    async (crash, status) => {
      const fixturePath = 'tmp/discussion-request-process-' + randomUUID();
      const input = fixture();
      try {
        await seedFixture(fixturePath);
        const stopped = await runChild(fixturePath, input, 'create', crash);
        expect(stopped.status, stopped.stderr + stopped.stdout).toBe(77);
        expect(result(await runChild(fixturePath, input, 'recover'))).toMatchObject({
          request: { status },
          should_start: false,
        });
        expect(result(await runChild(fixturePath, input))).toMatchObject({
          request: { status },
          should_start: false,
        });
      } finally {
        await cleanup(fixturePath);
      }
    },
    60000
  );
});
