import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { resolveTemplateValue } from './service-engine-helpers.js';

describe('service-engine-helpers template path tokens', () => {
  it('resolves whole-string path tokens inside template values', () => {
    expect(resolveTemplateValue('{{@shared:tmp/run.json}}', {})).toBe(pathResolver.shared('tmp/run.json'));
    expect(resolveTemplateValue({ out: '{{@knowledge:product/x.md}}' }, {})).toEqual({
      out: pathResolver.knowledge('product/x.md'),
    });
  });

  it('preserves unknown path token domains', () => {
    expect(resolveTemplateValue('{{@unknown:path}}', {})).toBe('{{@unknown:path}}');
  });
});
