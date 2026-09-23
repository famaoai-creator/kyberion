// UI-01c (SURFACE_UI_UNIFICATION_PLAN §3.3 "ファイルと秘密情報の扱い"): the
// catalog schema must make file contents and secret values unrepresentable
// in props — they only ever travel as a runtime `onAction` payload.
import { describe, expect, it } from 'vitest';
import { KB_FORM_ACTIONS, validateA2UIComponentProps } from './a2ui-catalog.js';

const secretBase = { name: 'openai', label: 'Token', action: { id: 'secret.introduce' } };

describe('kyberion-base forms: secrets and files never live in props', () => {
  it('ui:secret-field has no value slot (or any alias of it)', () => {
    expect(() => validateA2UIComponentProps('ui:secret-field', secretBase)).not.toThrow();
    for (const key of ['value', 'defaultValue', 'default_value', 'secret', 'token']) {
      expect(
        () => validateA2UIComponentProps('ui:secret-field', { ...secretBase, [key]: 'sk-123' }),
        key
      ).toThrow(/props are invalid/u);
    }
  });

  it('ui:secret-field only exposes at most the last four characters', () => {
    expect(() =>
      validateA2UIComponentProps('ui:secret-field', {
        ...secretBase,
        configured: true,
        last4: 'abcd',
      })
    ).not.toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:secret-field', { ...secretBase, last4: 'abcde' })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:secret-field', { ...secretBase, last4: 'ab-d' })
    ).toThrow();
    // A submit action is mandatory: the value has nowhere else to go.
    expect(() =>
      validateA2UIComponentProps('ui:secret-field', { name: 'x', label: 'Token' })
    ).toThrow();
  });

  it('ui:file-drop file entries carry metadata only', () => {
    const entry = { id: 'f1', name: 'a.pdf', size: 3, status: 'done' };
    expect(() =>
      validateA2UIComponentProps('ui:file-drop', { name: 'docs', label: 'Docs', files: [entry] })
    ).not.toThrow();
    for (const key of ['content', 'data', 'blob', 'base64', 'url', 'path']) {
      expect(
        () =>
          validateA2UIComponentProps('ui:file-drop', {
            name: 'docs',
            label: 'Docs',
            files: [{ ...entry, [key]: 'AAAA' }],
          }),
        key
      ).toThrow(/props are invalid/u);
    }
    expect(() =>
      validateA2UIComponentProps('ui:file-drop', { name: 'docs', label: 'Docs', value: 'x' })
    ).toThrow();
  });

  it('camera / avatar components have no image-data slot and reject data: URLs', () => {
    expect(() =>
      validateA2UIComponentProps('ui:camera-capture', { name: 'p', label: 'P', image: 'x' })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:avatar-picker', {
        name: 'a',
        label: 'A',
        image_url: 'data:image/png;base64,AAAA',
      })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:avatar-picker', {
        name: 'a',
        label: 'A',
        image_url: '/api/avatar?v=2',
      })
    ).not.toThrow();
  });

  it('validates field names, option lists and save-bar actions', () => {
    expect(() =>
      validateA2UIComponentProps('ui:switch', { name: 'bad name', label: 'x' })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:select', { name: 'x', label: 'x', options: [] })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:segmented', {
        name: 'x',
        label: 'x',
        options: [{ value: 'a', label: 'A' }],
      })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:save-bar', { state: 'dirty' })).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:integration-item', { title: 'x', state: 'unknown' })
    ).toThrow();
  });

  it('declares the default action ids the renderers dispatch', () => {
    expect(KB_FORM_ACTIONS.fieldChange).toBe('field.change');
    expect(Object.values(KB_FORM_ACTIONS).every((id) => /^[a-z0-9][a-z0-9:._-]*$/.test(id))).toBe(
      true
    );
  });
});
