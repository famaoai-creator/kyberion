import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { t as catalogT } from '@agent/core/t';
import { RV_SAVE_CONFIG_CLOSE, RV_SAVE_CONFIG_OPEN } from '../report-review/review-layer.js';
import { renderMissionBriefHtml } from './render-brief.js';

describe('renderMissionBriefHtml approval state', () => {
  it('serializes settled decision metadata for report-review readers', () => {
    const html = renderMissionBriefHtml(
      { missionId: 'MSN-RENDER-TEST', title: 'render test' },
      {
        approval: {
          requestId: 'apr-render-1',
          status: 'rejected',
          decidedBy: 'sovereign',
          decidedAt: '2026-08-11T12:00:00.000Z',
        },
      }
    );

    expect(html).toContain('data-decision="rejected"');
    expect(html).toContain('data-decided-by="sovereign"');
    expect(html).toContain('data-decided-at="2026-08-11T12:00:00.000Z"');
  });

  it('validates the approval response before updating the decision state', () => {
    const html = renderMissionBriefHtml(
      { missionId: 'MSN-RENDER-TEST', title: 'render test' },
      { approval: { requestId: 'apr-render-2', status: 'pending' } }
    );

    expect(html).toContain('body.ok !== true');
    expect(html).toContain('responseRequestId !== cfg.requestId');
    expect(html).toContain("responseStatus !== 'approved'");
    expect(html).toContain("responseStatus !== 'rejected'");
  });
});

describe('renderMissionBriefHtml hardening (review follow-ups)', () => {
  it('escapes quotes in attribute values (no data-* attribute breakout)', () => {
    const html = renderMissionBriefHtml(
      { missionId: 'MSN-RENDER-TEST', title: 'render test' },
      {
        approval: {
          requestId: 'apr-render-3',
          status: 'approved',
          decidedBy: 'x" onmouseover="alert(1)',
          decidedAt: "2026'",
        },
      }
    );
    expect(html).toContain('data-decided-by="x&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('data-decided-at="2026&#39;"');
  });

  it('keeps the decision token in a save-config region that exports strip', () => {
    const html = renderMissionBriefHtml(
      { missionId: 'MSN-RENDER-TEST', title: 'render test' },
      { approval: { requestId: 'apr-render-4', status: 'pending', token: 'tok-secret-123' } }
    );
    expect(html).toContain('tok-secret-123');
    const open = html.indexOf(RV_SAVE_CONFIG_OPEN);
    const close = html.indexOf(RV_SAVE_CONFIG_CLOSE);
    expect(open).toBeGreaterThan(-1);
    const token = html.indexOf('tok-secret-123');
    expect(token).toBeGreaterThan(open);
    expect(token).toBeLessThan(close);
    // Outside the reviewed content (.wrap), so a local snapshot never has it.
    expect(close).toBeLessThan(html.indexOf('<div class="wrap">'));
    // What the layer's export does: drop every save-config region.
    const exported = html.replace(
      new RegExp(`${RV_SAVE_CONFIG_OPEN}[\\s\\S]*?${RV_SAVE_CONFIG_CLOSE}`, 'g'),
      ''
    );
    expect(exported).not.toContain('tok-secret-123');
    // The client strips the same markers.
    const client = String(
      safeReadFile(pathResolver.rootResolve('scripts/report-review/review-layer-client.js'), {
        encoding: 'utf8',
      })
    );
    expect(client).toContain(
      `['${RV_SAVE_CONFIG_OPEN.slice(4, -3)}', '${RV_SAVE_CONFIG_CLOSE.slice(4, -3)}']`
    );
  });

  it('renders the page, the gate script and the review layer in the given locale', () => {
    const brief = { missionId: 'MSN-RENDER-TEST', title: 'render test' };
    const approval = { requestId: 'apr-render-5', status: 'pending' };
    const en = renderMissionBriefHtml(brief, { approval, locale: 'en' });
    const ja = renderMissionBriefHtml(brief, { approval, locale: 'ja' });
    expect(en).toContain('<html lang="en">');
    expect(ja).toContain('<html lang="ja">');
    expect(en).toContain(catalogT('mission_alignment:approval_approve_button', undefined, 'en'));
    expect(ja).toContain(catalogT('mission_alignment:approval_approve_button', undefined, 'ja'));
    expect(en).toContain('"locale":"en"');
    expect(ja).toContain('"locale":"ja"');
    // No hardcoded Japanese failure prefix in the gate script.
    expect(en).not.toContain('失敗: ');
    expect(en).toContain("MG_MESSAGES.failed.replace('__ERROR__', responseError)");
  });
});
