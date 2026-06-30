import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { evaluateCondition, getPathValue, resolveVars, resolveWriteArtifactSpec } from './logic-utils.js';
import { pathResolver } from '../path-resolver.js';

describe('logic-utils', () => {
  const ctx = {
    mission: {
      id: 'MSN-123',
      status: 'active',
      priority: 7,
      tags: ['surface'],
      meta: { owner: 'operator' },
    },
  };

  it('returns non-string values unchanged', () => {
    expect(resolveVars(42, ctx)).toBe(42);
  });

  it('resolves single variables and interpolated strings', () => {
    expect(resolveVars('{{mission.id}}', ctx)).toBe('MSN-123');
    expect(resolveVars('Mission {{mission.id}} is {{mission.status}}', ctx)).toBe('Mission MSN-123 is active');
  });

  it('serializes embedded objects and falls back to empty string', () => {
    expect(resolveVars('meta={{mission.meta}}', ctx)).toBe('meta={"owner":"operator"}');
    expect(resolveVars('{{mission.missing}}', ctx)).toBe('');
  });

  it('resolveVars supports {{var|default}} syntax', () => {
    expect(resolveVars('{{mission.missing|fallback}}', ctx)).toBe('fallback');
    expect(resolveVars('{{mission.id|fallback}}', ctx)).toBe('MSN-123');
    expect(resolveVars('Hello {{mission.missing|World}}', ctx)).toBe('Hello World');
    expect(resolveVars('Hello {{mission.id|World}}', ctx)).toBe('Hello MSN-123');
  });

  it('resolveVars default preserves type for single-var match', () => {
    const numCtx = { count: 42 };
    expect(resolveVars('{{count}}', numCtx)).toBe(42);
    expect(resolveVars('{{missing|0}}', numCtx)).toBe('0');
  });

  it('resolveVars resolves inline @domain path tokens to machine-local paths', () => {
    expect(resolveVars('{{@root}}', ctx)).toBe(pathResolver.rootDir());
    expect(resolveVars('{{@knowledge:product/x.md}}', ctx)).toBe(pathResolver.knowledge('product/x.md'));
    expect(resolveVars('{{@shared:tmp/run.json}}', ctx)).toBe(pathResolver.shared('tmp/run.json'));
    expect(resolveVars('{{@tmp:run.json}}', ctx)).toBe(pathResolver.shared('tmp/run.json'));
  });

  it('resolveVars interpolates @domain path tokens within a larger string', () => {
    expect(resolveVars('input={{@knowledge:a.json}}', ctx)).toBe(`input=${pathResolver.knowledge('a.json')}`);
  });

  it('resolveVars keeps an unknown @domain token literal', () => {
    expect(resolveVars('{{@nope:x}}', ctx)).toBe('{{@nope:x}}');
  });

  it('resolveVars produces absolute, in-repo path-token results', () => {
    const resolved = resolveVars('{{@active:missions}}', ctx) as string;
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.startsWith(pathResolver.rootDir())).toBe(true);
  });

  it('resolves multi-var strings that start AND end with {{ }} correctly', () => {
    const c = { account_org: '田中製造株式会社', account_name: '田中誠' };
    // "{{account_org}} / {{account_name}}" starts with {{ and ends with }} — must NOT be
    // treated as a single var (which would return '' for unknown key "account_org}} / {{account_name")
    expect(resolveVars('{{account_org}} / {{account_name}}', c)).toBe('田中製造株式会社 / 田中誠');
    expect(resolveVars('{{account_org}}', c)).toBe('田中製造株式会社');
  });

  it('resolves deep and indexed path values safely', () => {
    expect(getPathValue({ report: { metrics: [{ count: 3 }] } }, 'report.metrics[0].count')).toBe(3);
    expect(getPathValue({ report: { metrics: { count: 5 } } }, 'report.metrics.count')).toBe(5);
    expect(getPathValue({ report: {} }, 'report.metrics.count')).toBeUndefined();
  });

  it('evaluates supported condition operators', () => {
    expect(evaluateCondition(undefined, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.id', operator: 'exists' }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.missing', operator: 'not_exists' }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.tags', operator: 'not_empty' }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.tags', operator: 'empty' }, { mission: { tags: [] } })).toBe(true);
    expect(evaluateCondition({ from: 'mission.status', operator: 'eq', value: 'active' }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.status', operator: 'ne', value: 'paused' }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.priority', operator: 'gt', value: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.priority', operator: 'lt', value: 10 }, ctx)).toBe(true);
    expect(evaluateCondition({ from: 'mission.priority', operator: 'unknown' }, ctx)).toBe(true);
  });

  it('builds unified write artifact specs from path, output_path, content, and from', () => {
    expect(resolveWriteArtifactSpec({ path: 'out.txt', content: 'hello' }, ctx)).toEqual({
      path: 'out.txt',
      content: 'hello',
    });
    expect(resolveWriteArtifactSpec({ output_path: 'out.json', from: 'mission.meta' }, ctx)).toEqual({
      path: 'out.json',
      content: ctx.mission.meta,
    });
    expect(resolveWriteArtifactSpec({ output_path: 'out.json', from: 'mission' }, ctx)).toEqual({
      path: 'out.json',
      content: ctx.mission,
    });
  });
});
