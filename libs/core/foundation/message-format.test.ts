import { describe, expect, it } from 'vitest';
import { extractPlaceholderNames, renderMessage } from './message-format.js';

describe('message-format (I18N-02 ICU MessageFormat subset)', () => {
  describe('renderMessage', () => {
    it('returns the template unchanged when no params are supplied', () => {
      expect(renderMessage('Please provide {input}.')).toBe('Please provide {input}.');
    });

    it('substitutes simple {name} interpolation', () => {
      expect(renderMessage('Please provide {input}.', { input: 'a project id' })).toBe(
        'Please provide a project id.'
      );
    });

    it('substitutes multiple distinct placeholders', () => {
      expect(renderMessage('{greeting}, {name}!', { greeting: 'Hello', name: 'Sovereign' })).toBe(
        'Hello, Sovereign!'
      );
    });

    it('leaves an unresolved placeholder untouched (loud, greppable)', () => {
      expect(renderMessage('Please provide {input}.', { other: 'x' })).toBe(
        'Please provide {input}.'
      );
    });

    it('renders plural "one" for count === 1', () => {
      expect(renderMessage('{count, plural, one {# item} other {# items}}', { count: 1 })).toBe(
        '1 item'
      );
    });

    it('renders plural "other" for count !== 1 (0, 2, negative)', () => {
      expect(renderMessage('{count, plural, one {# item} other {# items}}', { count: 0 })).toBe(
        '0 items'
      );
      expect(renderMessage('{count, plural, one {# item} other {# items}}', { count: 2 })).toBe(
        '2 items'
      );
      expect(renderMessage('{count, plural, one {# item} other {# items}}', { count: -1 })).toBe(
        '-1 items'
      );
    });

    it('supports a plural block alongside a simple placeholder', () => {
      expect(
        renderMessage('{name}: {count, plural, one {# task} other {# tasks}} remaining', {
          name: 'Mission',
          count: 3,
        })
      ).toBe('Mission: 3 tasks remaining');
    });

    it('does not support gender, ordinal, select, or date/number ICU constructs (subset only)', () => {
      // `select` is out of scope: it is not specially parsed, so the raw
      // template (minus any {name} substitution attempted) passes through.
      const template = '{gender, select, male {he} female {she} other {they}}';
      expect(renderMessage(template, { gender: 'male' })).toBe(template);
    });
  });

  describe('extractPlaceholderNames', () => {
    it('extracts a simple placeholder name', () => {
      expect(extractPlaceholderNames('Please provide {input}.')).toEqual(['input']);
    });

    it('extracts the plural argument name', () => {
      expect(extractPlaceholderNames('{count, plural, one {# item} other {# items}}')).toEqual([
        'count',
      ]);
    });

    it('extracts both the plural argument and a sibling simple placeholder', () => {
      expect(
        extractPlaceholderNames('{name}: {count, plural, one {# item} other {# items}}')
      ).toEqual(['count', 'name']);
    });

    it('returns an empty array for a template with no placeholders', () => {
      expect(extractPlaceholderNames('Readiness')).toEqual([]);
    });

    it('deduplicates and sorts placeholder names', () => {
      expect(extractPlaceholderNames('{b} and {a} and {b} again')).toEqual(['a', 'b']);
    });
  });
});
