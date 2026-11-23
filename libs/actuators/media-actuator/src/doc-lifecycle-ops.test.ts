/**
 * Focused tests for the document-lifecycle ops added for the bizsim2 loop:
 * `document_pdf_from_brief` layout application, `pdf_text_edit`, and
 * `register_artifact` scoping / `if_exists: reuse` idempotency.
 */
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import path from 'node:path';
import { handleAction } from './index.js';

async function runSteps(context: Record<string, unknown>, steps: unknown[]): Promise<any> {
  const result = await handleAction({ action: 'pipeline', context, steps } as any);
  expect(result.status).toBe('succeeded');
  return result.context;
}

const INVOICE_BRIEF = {
  kind: 'document-brief',
  artifact_family: 'document',
  document_type: 'invoice',
  document_profile: 'qualified-invoice',
  render_target: 'pdf',
  locale: 'ja-JP',
  layout_template_id: 'jp-qualified-invoice-standard',
  payload: {
    invoice_number: 'T-0001',
    issue_date: '2026-11-23',
    due_date: '2026-12-31',
    subject: 'テスト請求',
    currency: 'JPY',
    issuer: { name: '発行者株式会社', registration_number: 'T0000000000000' },
    recipient: { name: '受領者株式会社 御中' },
    payment: { method: '銀行振込', bank_name: 'テスト銀行', account_number: '1234567' },
    notes: 'テスト備考',
    items: [
      { description: '開発費', quantity: 1, unit: '式', unit_price_ex_tax: 100000, tax_rate: 10 },
    ],
  },
};

describe('document_pdf_from_brief — layout application', () => {
  it('emits positioned elements and vectors from the layout template', async () => {
    const ctx = await runSteps({ last_json: INVOICE_BRIEF }, [
      {
        type: 'transform',
        op: 'document_pdf_from_brief',
        params: { from: 'last_json', export_as: 'design' },
      },
    ]);
    const design = ctx.design;
    expect(design.aesthetic?.elements?.length).toBeGreaterThan(10);
    const page = design.content?.pages?.[0];
    expect(page.vectors?.length).toBeGreaterThan(0);
    // Template labels are consumed (not the hardcoded plain-text path).
    const texts = design.aesthetic.elements.map((e: any) => e.text).join('|');
    expect(texts).toContain('御請求金額');
    expect(texts).toContain('T-0001');
    expect(texts).toContain('受領者株式会社');
    // Previously-dropped fields are rendered.
    expect(texts).toContain('テスト銀行');
    expect(texts).toContain('テスト備考');
  });

  it('produces different label sets per layout_template_id', async () => {
    const ctx = await runSteps(
      {
        last_json: {
          ...INVOICE_BRIEF,
          layout_template_id: 'jp-qualified-invoice-compact',
        },
      },
      [
        {
          type: 'transform',
          op: 'document_pdf_from_brief',
          params: { from: 'last_json', export_as: 'design' },
        },
      ]
    );
    const texts = ctx.design.aesthetic.elements.map((e: any) => e.text).join('|');
    expect(texts).toContain('今回ご請求額');
    expect(texts).not.toContain('御請求金額');
  });
});

describe('pdf_text_edit', () => {
  it('patches matched text in positioned elements and keeps the rest', async () => {
    const ctx = await runSteps({ last_json: INVOICE_BRIEF }, [
      {
        type: 'transform',
        op: 'document_pdf_from_brief',
        params: { from: 'last_json', export_as: 'design' },
      },
      {
        type: 'transform',
        op: 'pdf_text_edit',
        params: {
          from: 'design',
          export_as: 'edited',
          edits: [
            { match: 'T-0001', replace: 'T-0002' },
            { match: '受領者株式会社', replace: '変更先株式会社' },
          ],
        },
      },
    ]);
    const texts = ctx.edited.aesthetic.elements.map((e: any) => e.text).join('|');
    expect(texts).toContain('T-0002');
    expect(texts).toContain('変更先株式会社');
    expect(texts).toContain('御請求金額');
    expect(texts).not.toContain('T-0001');
    // Vectors pass through untouched.
    expect(ctx.edited.content.pages[0].vectors?.length).toBeGreaterThan(0);
  });

  it('fails when edits are missing', async () => {
    const result: any = await handleAction({
      action: 'pipeline',
      context: { design: { aesthetic: { elements: [] } } },
      steps: [{ type: 'transform', op: 'pdf_text_edit', params: { from: 'design' } }],
    } as any);
    expect(result.status).toBe('failed');
  });
});

describe('register_artifact', () => {
  const TMP = pathResolver.sharedTmp('doc-lifecycle-ops-tests');

  function fixtureFile(name: string, content: string): string {
    safeMkdir(TMP, { recursive: true });
    const filePath = path.join(TMP, name);
    safeWriteFile(filePath, content);
    return filePath;
  }

  // Real registrations write into governed live state and are covered
  // end-to-end by the bizsim2 pipelines; here we pin the guard rails.
  it('requires an explicit scope', async () => {
    const filePath = fixtureFile('reg-noscope.txt', 'x');
    const result: any = await handleAction({
      action: 'pipeline',
      context: {},
      steps: [
        { type: 'apply', op: 'register_artifact', params: { path: filePath, name: 'noscope.txt' } },
      ],
    } as any);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('scope is required');
  });

  it('fails clearly when the source file is missing', async () => {
    const result: any = await handleAction({
      action: 'pipeline',
      context: {},
      steps: [
        {
          type: 'apply',
          op: 'register_artifact',
          params: {
            path: path.join(TMP, 'does-not-exist.bin'),
            name: 'does-not-exist.bin',
            system: true,
          },
        },
      ],
    } as any);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('source file not found');
  });
});
