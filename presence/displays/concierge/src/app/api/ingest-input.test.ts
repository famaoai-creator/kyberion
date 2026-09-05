import { describe, expect, it } from 'vitest';
import { parseIngestForm } from './ingest-input';

function validForm() {
  const form = new FormData();
  form.set('file', new File(['content'], 'brief.md', { type: 'text/markdown' }));
  form.set('tenant', ' tenant-a ');
  return form;
}

describe('concierge ingest form input', () => {
  it('normalizes the supported multipart fields', () => {
    const form = validForm();
    form.set('format', ' markdown ');
    form.set('dry_run', 'true');

    expect(parseIngestForm(form)).toMatchObject({
      ok: true,
      value: { tenant: 'tenant-a', format: 'markdown', dryRun: true },
    });
  });

  it('keeps absent dry_run backward-compatible as false', () => {
    expect(parseIngestForm(validForm())).toMatchObject({
      ok: true,
      value: { tenant: 'tenant-a', format: '', dryRun: false },
    });
  });

  it.each([
    ['missing file', (form: FormData) => form.delete('file'), 'file'],
    ['file field as text', (form: FormData) => form.set('file', 'brief.md'), 'file'],
    [
      'tenant as File',
      (form: FormData) => form.set('tenant', new File(['x'], 'tenant.txt')),
      'tenant',
    ],
    ['empty tenant', (form: FormData) => form.set('tenant', '  '), 'tenant'],
    ['unsupported format', (form: FormData) => form.set('format', 'exe'), 'format'],
    [
      'dry_run as object-like text',
      (form: FormData) => form.set('dry_run', '[object Object]'),
      'dry_run',
    ],
    ['unknown field', (form: FormData) => form.set('redirect', 'https://example.test'), 'unknown'],
  ])('rejects %s before normalization', (_label, mutate, field) => {
    const form = validForm();
    mutate(form);
    expect(parseIngestForm(form)).toEqual({ ok: false, field });
  });

  it('rejects duplicate fields instead of selecting an ambiguous first value', () => {
    const form = validForm();
    form.append('tenant', 'tenant-b');
    expect(parseIngestForm(form)).toEqual({ ok: false, field: 'tenant' });
  });
});
