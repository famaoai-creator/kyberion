import { describe, expect, it } from 'vitest';
import { matchesAllowedOrigin } from './origin-policy.js';

describe('origin-policy', () => {
  it('matches exact http(s) origins only', () => {
    expect(matchesAllowedOrigin('https://www.yahoo.co.jp', 'https://www.yahoo.co.jp')).toBe(true);
    expect(matchesAllowedOrigin('https://www.yahoo.co.jp', 'https://news.yahoo.co.jp')).toBe(false);
  });

  it('rejects prefix tricks and sibling hosts', () => {
    expect(matchesAllowedOrigin('https://trusted.example.com', 'https://trusted.example.com.evil')).toBe(false);
    expect(matchesAllowedOrigin('https://github.com', 'https://gist.github.com')).toBe(false);
  });

  it('normalizes origin strings before comparing', () => {
    expect(matchesAllowedOrigin('https://www.yahoo.co.jp/', 'https://www.yahoo.co.jp')).toBe(true);
  });
});
