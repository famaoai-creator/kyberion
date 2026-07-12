import { describe, expect, it } from 'vitest';
import {
  readKyberionDesignTokens,
  renderKyberionDesignTokenBlock,
  renderKyberionTailwindColorsBlock,
  replaceTokenBlock,
} from './design-token-utils.js';

describe('canonical design-token generation', () => {
  it('renders semantic tokens for automatic and explicit themes', () => {
    const block = renderKyberionDesignTokenBlock(readKyberionDesignTokens());
    expect(block).toContain('--kb-surface:');
    expect(block).toContain('--kb-border:');
    expect(block).toContain('--kb-success:');
    expect(block).toContain('--kb-danger:');
    expect(block).toContain("[data-theme='light']");
    expect(block).toContain("[data-theme='dark']");
    expect(block).not.toContain('--kb-border: 1px solid');
  });

  it('maps semantic tokens into Tailwind and replaces legacy explicit-theme blocks', () => {
    const block = renderKyberionDesignTokenBlock(readKyberionDesignTokens());
    const tailwind = renderKyberionTailwindColorsBlock();
    expect(tailwind).toContain('success: "var(--kb-success)"');
    expect(tailwind).toContain('danger: "var(--kb-danger)"');

    const legacy = [
      ':root {',
      '  --kb-bg-main: #fff;',
      '}',
      '',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --kb-bg-main: #000;',
      '  }',
      '}',
      '',
      "[data-theme='light'] {",
      '  --kb-bg-main: #fff;',
      '}',
      '',
      "[data-theme='dark'] {",
      '  --kb-bg-main: #000;',
      '}',
      '',
      'body { color: var(--kb-text-primary); }',
    ].join('\n');
    const replaced = replaceTokenBlock(legacy, block);
    expect(replaced.match(/\[data-theme='light'\]/gu)).toHaveLength(1);
    expect(replaced).toContain('body { color: var(--kb-text-primary); }');
  });
});
