import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { pathResolver, safeExistsSync, safeReaddir, safeRmSync } from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';
import { loadTrainingCatalog, readTrainingProgress } from '@agent/core/training-catalog';

// The store and the authority layer are real: this route writes
// `knowledge/personal/members/<id>/training.json`, and the role it assumes
// must actually be allowed to (a route moved between processes re-checks
// path authority). Only the viewer, member resolution and the request
// guard are stubbed.
const viewer = vi.hoisted(() => ({ value: undefined as unknown }));
const guard = vi.hoisted(() => ({ denied: null as Response | null }));
const member = vi.hoisted(() => ({ id: 'zz-concierge-training-me' as string | null }));

vi.mock('../../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/viewer-context')>()),
  resolveConciergeViewer: () => viewer.value,
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () => guard.denied,
}));
vi.mock('../../../../lib/work-inventory-member', () => ({
  resolveWorkInventoryMember: () => (member.id ? { member_id: member.id } : null),
}));

import { GET, POST } from './route';

const MEMBER_DIR = path.join(pathResolver.rootDir(), 'knowledge/personal/members');
let membersDirExisted = true;

function viewerWith(role: 'localadmin' | 'readonly') {
  return {
    context: {
      role,
      tenantSlugs: 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['personal', 'confidential', 'public'],
      source: role === 'localadmin' ? 'loopback' : 'token',
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

function removeTestMember() {
  withExecutionContext('ecosystem_architect', () => {
    const dir = path.join(MEMBER_DIR, 'zz-concierge-training-me');
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    if (!membersDirExisted && safeExistsSync(MEMBER_DIR) && safeReaddir(MEMBER_DIR).length === 0) {
      safeRmSync(MEMBER_DIR, { recursive: true, force: true });
    }
  });
}

const firstLesson = () => loadTrainingCatalog().tracks[0].lessons[0].id;

describe('concierge /api/training/me (the viewer’s own training progress)', () => {
  beforeAll(() => {
    membersDirExisted = safeExistsSync(MEMBER_DIR);
  });
  afterAll(removeTestMember);
  beforeEach(() => {
    removeTestMember();
    viewer.value = viewerWith('localadmin');
    guard.denied = null;
    member.id = 'zz-concierge-training-me';
  });

  it('reads an empty record for a member who has not started', async () => {
    const response = GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).progress.lessons).toEqual({});
  });

  it('records a completed lesson for the server-resolved member only', async () => {
    const lessonId = firstLesson();
    const response = await POST(request({ lesson_id: lessonId, status: 'complete' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.progress.member_id).toBe('zz-concierge-training-me');
    expect(body.progress.lessons[lessonId].status).toBe('complete');
    expect(body.progress.lessons[lessonId].completed_at).toBeTruthy();
    const persisted = withExecutionContext('ecosystem_architect', () =>
      readTrainingProgress('zz-concierge-training-me')
    );
    expect(persisted.lessons[lessonId].status).toBe('complete');
    const again = await GET(request()).json();
    expect(again.progress.lessons[lessonId].status).toBe('complete');
  });

  it('refuses a member id in the body (only lesson_id and status are accepted)', async () => {
    const response = await POST(
      request({ lesson_id: firstLesson(), status: 'complete', member_id: 'someone-else' })
    );
    expect(response.status).toBe(400);
  });

  it('refuses an unknown lesson or status with a readable 400', async () => {
    for (const body of [
      { lesson_id: 'no-such-lesson', status: 'complete' },
      { lesson_id: firstLesson(), status: 'finished' },
    ]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/lesson/i);
    }
  });

  it('keeps the studio posture: only a localadmin viewer may mark lessons', async () => {
    viewer.value = viewerWith('readonly');
    const response = await POST(request({ lesson_id: firstLesson(), status: 'complete' }));
    expect(response.status).toBe(403);
    expect(
      withExecutionContext('ecosystem_architect', () =>
        safeExistsSync(path.join(MEMBER_DIR, 'zz-concierge-training-me'))
      )
    ).toBe(false);
  });

  it('stops at the Concierge mutation gate before touching the store', async () => {
    guard.denied = new Response(JSON.stringify({ ok: false }), { status: 403 }) as never;
    const response = await POST(request({ lesson_id: firstLesson(), status: 'complete' }));
    expect(response.status).toBe(403);
  });

  it('answers a viewer with no member record with a readable 404', async () => {
    member.id = null;
    const read = GET(request());
    expect(read.status).toBe(404);
    expect((await read.json()).error).toMatch(/member/i);
    const write = await POST(request({ lesson_id: firstLesson(), status: 'complete' }));
    expect(write.status).toBe(404);
  });
});
