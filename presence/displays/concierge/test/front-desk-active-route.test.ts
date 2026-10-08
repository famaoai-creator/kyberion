import { describe, expect, it } from 'vitest';
import { currentItemId } from '../src/app/front-desk-rail';

describe('front-desk nested setup navigation', () => {
  it.each([
    ['/', 'decide'],
    ['/ingest', 'ingest'],
    ['/settings', 'settings'],
    ['/setup', 'settings'],
    ['/setup/sso', 'settings'],
    ['/setup/first-run', null],
    ['/signin', null],
    ['/login', null],
    [null, null],
  ])('maps %s to %s without marking first-run bootstrap as settings', (pathname, expected) => {
    expect(currentItemId(pathname)).toBe(expected);
  });
});
