import { describe, expect, it } from 'vitest';
import { currentItemId } from '../src/app/front-desk-rail';

describe('front-desk nested setup navigation', () => {
  it.each([
    ['/', 'decide'],
    ['/ingest', 'ingest'],
    ['/management', 'organization'],
    ['/settings', 'settings'],
    ['/setup', 'settings'],
    ['/setup/sso', 'settings'],
    ['/setup/first-run', null],
    ['/w', 'overview'],
    ['/w/tenant/acme', 'overview'],
    ['/w/organization', 'organizations'],
    ['/w/project/p-1', 'projects'],
    ['/w/mission/MSN-1', 'missions'],
    ['/w/task/MSN-1%2Ft1', 'missions'],
    ['/w/work_item', 'work-items'],
    ['/w/approval/a-1', 'approvals'],
    ['/w/actor/m-1', 'actors'],
    ['/wiki', null],
    ['/signin', null],
    ['/login', null],
    [null, null],
  ])('maps %s to %s without marking first-run bootstrap as settings', (pathname, expected) => {
    expect(currentItemId(pathname)).toBe(expected);
  });
});
