import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Hermetic: a temporary KYBERION_ROOT (governance, schemas and the training
// catalog copied in) under SYSTEM_ROLE=concierge, so both the role
// assumption (role-assumption-policy) and the path authority for
// `knowledge/personal/members/<id>/training.json` are the real ones — a route
// moved between processes re-checks both. Only the viewer, member resolution
// and the shared mutation guard are stubbed.
const viewer = vi.hoisted(() => ({ value: undefined as unknown }));
const guard = vi.hoisted(() => ({ denied: null as Response | null, calls: 0 }));
const member = vi.hoisted(() => ({ id: 'zz-training-me' as string | null }));

vi.mock('../../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/viewer-context')>()),
  resolveConciergeViewer: () => viewer.value,
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () => {
    guard.calls += 1;
    return guard.denied;
  },
}));
vi.mock('../../../../lib/work-inventory-member', () => ({
  resolveWorkInventoryMember: () => (member.id ? { member_id: member.id } : null),
}));

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../..'
);
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-training-me-${randomUUID()}`);

let route: typeof import('./route');
let io: typeof import('@agent/core');
let authority: typeof import('@agent/core/authority');
let training: typeof import('@agent/core/training-catalog');

function viewerWith(role: 'localadmin' | 'readonly', source: 'loopback' | 'token' = 'loopback') {
  return {
    context: {
      role,
      tenantSlugs: 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential', 'public'],
      source,
    },
  };
}

function request(body?: unknown): NextRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'accept-language': 'en' }),
    json: async () => body,
  } as unknown as NextRequest;
}

const recordPath = () => path.join(root, 'knowledge/personal/members/zz-training-me');
const recordExists = () =>
  authority.withExecutionContext('sovereign_concierge', () => io.safeExistsSync(recordPath()));
const firstLesson = () => training.loadTrainingCatalog().tracks[0].lessons[0].id;

beforeAll(async () => {
  const bootstrap = await import('@agent/core');
  const copy = (from: string, to: string): void => {
    bootstrap.safeMkdir(path.dirname(to), { recursive: true });
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  bootstrap.safeMkdir(root, { recursive: true });
  for (const name of ['schemas', 'governance', 'orchestration']) {
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  }
  copy(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(root, 'knowledge/public/common/project_standards.json')
  );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
  vi.resetModules();
  io = await import('@agent/core');
  authority = await import('@agent/core/authority');
  training = await import('@agent/core/training-catalog');
  route = await import('./route');
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  bootstrap.safeRmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  authority.withExecutionContext('sovereign_concierge', () =>
    io.safeRmSync(recordPath(), { recursive: true, force: true })
  );
  viewer.value = viewerWith('localadmin');
  guard.denied = null;
  guard.calls = 0;
  member.id = 'zz-training-me';
});

describe('concierge /api/training/me (the viewer’s own training progress)', () => {
  it('runs inside the temporary root, not the checkout', () => {
    expect(io.pathResolver.rootDir()).toBe(root);
  });

  it('reads an empty record for a member who has not started', async () => {
    const response = route.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).progress.lessons).toEqual({});
  });

  it('records a completed lesson for the server-resolved member only', async () => {
    const lessonId = firstLesson();
    const response = await route.POST(request({ lesson_id: lessonId, status: 'complete' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.progress.member_id).toBe('zz-training-me');
    expect(body.progress.lessons[lessonId].status).toBe('complete');
    expect(body.progress.lessons[lessonId].completed_at).toBeTruthy();
    const persisted = authority.withExecutionContext('sovereign_concierge', () =>
      training.readTrainingProgress('zz-training-me')
    );
    expect(persisted.lessons[lessonId].status).toBe('complete');
    expect((await route.GET(request()).json()).progress.lessons[lessonId].status).toBe('complete');
  });

  it('records in_progress without a completion time', async () => {
    const lessonId = firstLesson();
    const body = await (
      await route.POST(request({ lesson_id: lessonId, status: 'in_progress' }))
    ).json();
    expect(body.progress.lessons[lessonId]).toEqual({ status: 'in_progress' });
  });

  it('refuses a member id in the body, an unknown lesson or an unknown status — readable, coded', async () => {
    for (const body of [
      { lesson_id: firstLesson(), status: 'complete', member_id: 'someone-else' },
      { lesson_id: 'no-such-lesson', status: 'complete' },
      { lesson_id: firstLesson(), status: 'finished' },
    ]) {
      const response = await route.POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error_code: 'training_progress_invalid',
        error: expect.stringMatching(/lesson/i),
      });
    }
    expect(recordExists()).toBe(false);
  });

  it.each([
    ['a readonly member', viewerWith('readonly', 'token')],
    ['a remote localadmin token', viewerWith('localadmin', 'token')],
  ])(
    'keeps the studio rule (loopback localadmin only): refuses %s before the shared guard',
    async (_label, who) => {
      viewer.value = who;
      // Even when the shared guard would refuse with its own internal text, the
      // person gets this route's coded answer.
      guard.denied = new Response(JSON.stringify({ ok: false, error: 'internal' }), {
        status: 403,
      }) as never;
      const response = await route.POST(request({ lesson_id: firstLesson(), status: 'complete' }));
      expect(response.status).toBe(403);
      expect((await response.json()).error_code).toBe('training_mark_done_local_only');
      expect(guard.calls).toBe(0);
      expect(recordExists()).toBe(false);
    }
  );

  it('stops at the Concierge mutation gate before touching the store', async () => {
    guard.denied = new Response(JSON.stringify({ ok: false }), { status: 403 }) as never;
    const response = await route.POST(request({ lesson_id: firstLesson(), status: 'complete' }));
    expect(response.status).toBe(403);
    expect(guard.calls).toBe(1);
    expect(recordExists()).toBe(false);
  });

  it('answers a viewer with no member record with a readable, coded 404', async () => {
    member.id = null;
    const read = route.GET(request());
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error_code: 'training_member_not_found' });
    const write = await route.POST(request({ lesson_id: firstLesson(), status: 'complete' }));
    expect(write.status).toBe(404);
  });
});
