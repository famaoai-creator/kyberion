/**
 * render-brief.ts — ミッション・アラインメント・ゲート：ミッションブリーフHTMLレンダラ
 *
 * ③アラインメントで整理した意図/ゴール/実行の流れを、人間可読の「ミッションブリーフ」HTMLに描画する。
 * report-review レイヤを内蔵し、Sovereign が ✏️編集 / 💬コメント / 🎤音声 でフィードバックできる。
 * 静的レンダリングはプレビュー専用で、承認は記録しない。決裁は serve-brief と共有 approval-store を使う。
 *
 * フロー: brief.json → 静的プレビュー、または serve-brief → approval-store → strict gate-pass。
 *         HTML の data-decision は表示状態であり、承認の正本ではない。
 *
 * 使い方:
 *   node_modules/.bin/tsx scripts/mission-alignment-gate/render-brief.ts <mission-brief.json> [out.html]
 *   （confidential階層へ出力する場合は KYBERION_PERSONA を適切に設定）
 *
 * スキーマは README.md 参照。
 */
import { safeReadFile, safeWriteFile, safeExistsSync } from '@agent/core/secure-io';
import { resolveLocale } from '@agent/core/locale';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { reviewLayerMarkup } from '../report-review/review-layer.js';

/** MO-11: the brief schema (README.md). Every field is optional — the renderer
 *  degrades to “—” rather than failing on a partially drafted brief. */
export interface MissionBriefFlowStep {
  step?: string | number;
  title?: string;
  detail?: string;
  pipeline?: string;
}
export interface MissionBriefRisk {
  risk?: string;
  level?: string;
  mitigation?: string;
}
export interface MissionBriefRole {
  who?: string;
  role?: string;
}
export interface MissionBrief {
  missionId?: string;
  title?: string;
  intent?: string;
  persona?: string;
  tier?: string;
  sovereignSwitch?: string;
  victoryConditions?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: MissionBriefFlowStep[];
  roles?: MissionBriefRole[];
  deliverables?: string[];
  risks?: MissionBriefRisk[];
  openItems?: string[];
  gate?: { sudoGate?: string; riskLevel?: string; approvalRequired?: boolean };
  estimate?: { effort?: string; cost?: string };
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackType?: string;
  lifecycleModel?: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: unknown) =>
  String(s == null ? '' : s).replace(/[<>&]/g, (c) => HTML_ESCAPES[c] ?? c);
const li = (arr: string[] | undefined) =>
  arr && arr.length
    ? '<ul>' + arr.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>'
    : '<p class="muted">—</p>';

function mt(key: VocabularyKey, params?: Record<string, string | number>): string {
  return catalogT(key, params);
}

function briefMessages() {
  return {
    title: mt('mission_alignment:brief_title'),
    persona: mt('mission_alignment:label_persona'),
    tier: mt('mission_alignment:label_tier'),
    mode: mt('mission_alignment:label_mode'),
    risk: mt('mission_alignment:label_risk'),
    sudoGate: mt('mission_alignment:sudo_gate'),
    intent: mt('mission_alignment:section_intent'),
    goals: mt('mission_alignment:section_goals'),
    scope: mt('mission_alignment:section_scope'),
    scopeIn: mt('mission_alignment:scope_in'),
    scopeOut: mt('mission_alignment:scope_out'),
    flow: mt('mission_alignment:section_flow'),
    roles: mt('mission_alignment:section_roles'),
    deliverables: mt('mission_alignment:section_deliverables'),
    risks: mt('mission_alignment:section_risks'),
    estimate: mt('mission_alignment:section_estimate'),
    step: mt('mission_alignment:step'),
    pipelineBasis: mt('mission_alignment:pipeline_basis'),
    owner: mt('mission_alignment:owner'),
    role: mt('mission_alignment:role'),
    riskHeader: mt('mission_alignment:risk_header'),
    level: mt('mission_alignment:level'),
    mitigation: mt('mission_alignment:mitigation'),
    openItems: mt('mission_alignment:open_items'),
    effort: mt('mission_alignment:effort'),
    cost: mt('mission_alignment:cost'),
    adHoc: mt('mission_alignment:ad_hoc_flow'),
    empty: mt('mission_alignment:empty_value'),
    approvalUnbound: mt('mission_alignment:approval_unbound'),
    approved: mt('mission_alignment:approval_approved'),
    settled: mt('mission_alignment:approval_settled'),
    approveButton: mt('mission_alignment:approval_approve_button'),
    changesButton: mt('mission_alignment:approval_changes_button'),
    reasonPlaceholder: mt('mission_alignment:approval_reason_placeholder'),
    reasonIncorrect: mt('mission_alignment:reason_incorrect_content'),
    reasonDirection: mt('mission_alignment:reason_wrong_direction'),
    reasonQuality: mt('mission_alignment:reason_quality'),
    reasonScope: mt('mission_alignment:reason_scope'),
    reasonOther: mt('mission_alignment:reason_other'),
    pending: mt('mission_alignment:approval_pending'),
    chooseReason: mt('mission_alignment:approval_choose_reason'),
    deciderRequired: mt('mission_alignment:approval_decider_required'),
    commentPrompt: mt('mission_alignment:approval_comment_prompt'),
    deciderNamePrompt: mt('mission_alignment:decider_name_prompt'),
    sending: mt('mission_alignment:sending'),
    failed: (error: string) => mt('mission_alignment:failed', { error }),
    approvedShort: mt('mission_alignment:approved_short'),
    changesShort: mt('mission_alignment:changes_short'),
    submitted: (requestId: string) => mt('mission_alignment:approval_submitted', { requestId }),
    staticPreviewNotice: mt('mission_alignment:static_preview_notice'),
    staticPreviewCommands: mt('mission_alignment:static_preview_commands'),
  };
}

function flowRows(flow: MissionBriefFlowStep[] | undefined, empty: string, adHoc: string): string {
  if (!flow || !flow.length) return `<tr><td colspan="3" class="muted">${esc(empty)}</td></tr>`;
  return flow
    .map(
      (s, i) =>
        `<tr><td>${esc(s.step || i + 1)}</td><td><b>${esc(s.title)}</b><br><span class="muted">${esc(s.detail || '')}</span></td><td>${s.pipeline ? `<code>${esc(s.pipeline)}</code>` : `<span class="muted">${esc(adHoc)}</span>`}</td></tr>`
    )
    .join('');
}
function riskRows(risks: MissionBriefRisk[] | undefined): string {
  if (!risks || !risks.length) return '<tr><td colspan="3" class="muted">—</td></tr>';
  return risks
    .map(
      (r) =>
        `<tr><td>${esc(r.risk)}</td><td style="text-align:center">${esc(r.level ?? '')}</td><td>${esc(r.mitigation || '')}</td></tr>`
    )
    .join('');
}
function roleRows(roles: MissionBriefRole[] | undefined): string {
  if (!roles || !roles.length) return '<tr><td colspan="2" class="muted">—</td></tr>';
  return roles.map((r) => `<tr><td>${esc(r.who)}</td><td>${esc(r.role)}</td></tr>`).join('');
}

/**
 * MO-11: binding to the approval record that this brief is asking about.
 * When present the gate posts to the store; when absent the gate renders
 * read-only, because a decision that is not recorded in the approval store
 * is not a decision at all.
 */
export interface BriefApprovalBinding {
  requestId: string;
  status: string;
  decidedBy?: string;
  decidedAt?: string;
  decidedAuthMethod?: string;
  /** Endpoint + CSRF token injected by serve-brief. */
  endpoint?: string;
  token?: string;
}

export function renderMissionBriefHtml(
  b: MissionBrief,
  options: { approval?: BriefApprovalBinding } = {}
): string {
  const gate = b.gate || {};
  const sw = b.sovereignSwitch || 'governance-first';
  const m = briefMessages();
  const htmlLang = resolveLocale();

  return `<!doctype html>
<html lang="${esc(htmlLang)}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)} — ${esc(b.title || b.missionId || 'mission')}</title>
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--ink:#1a1f29;--muted:#5b6472;--line:#e3e7ee;--accent:#1f3a5f;--accent2:#2f5c9e;--soft:#eef3fb;--warn:#a8451a;--warn-bg:#fbede6;--ok:#1f7a4d;--ok-bg:#e6f5ec}
  @media(prefers-color-scheme:dark){:root{--bg:#0f1420;--panel:#161d2b;--ink:#e7ecf3;--muted:#9aa6b6;--line:#26303f;--accent:#6ea8e6;--accent2:#7fb2e0;--soft:#16283f;--warn:#e0865f;--warn-bg:#2e1d14;--ok:#5cc98c;--ok-bg:#12261b}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.66;font-size:15px;
    font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:28px 20px 90px}
  h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;color:var(--accent);border-bottom:2px solid var(--line);padding-bottom:6px;margin:30px 0 10px}
  .meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:13px;margin:8px 0 4px}
  .meta b{color:var(--ink)}
  .muted{color:var(--muted)}
  .tblwrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13.5px;margin:6px 0}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:var(--soft);color:var(--accent);font-size:12px}
  code{background:var(--soft);color:var(--accent2);padding:1px 5px;border-radius:5px;font-size:12px}
  ul{margin:6px 0;padding-left:20px}li{margin:3px 0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:640px){.grid{grid-template-columns:1fr}}
  .box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--panel)}
  .box h3{margin:0 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .sw{display:inline-block;font-weight:700;font-size:12px;padding:2px 9px;border-radius:999px;background:var(--soft);color:var(--accent2)}
  /* Approval gate persisted in the brief body. */
  #mg-gate{position:sticky;bottom:0;margin-top:26px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;
    background:var(--warn-bg);border:1px solid var(--warn);border-radius:12px;padding:12px 16px}
  #mg-gate[data-decision="approved"]{background:var(--ok-bg);border-color:var(--ok)}
  #mg-gate button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
  #mg-gate button.ok{background:var(--ok);color:#fff;border-color:var(--ok)}
  #mg-gate button.chg{background:var(--warn);color:#fff;border-color:var(--warn)}
  #mg-status{font-size:13px}
</style></head>
<body>
<div class="wrap">
  <h1>${esc(m.title)}${b.missionId ? `: <code>${esc(b.missionId)}</code>` : ''}</h1>
  <div style="font-size:16px;font-weight:700">${esc(b.title || '')}</div>
  <div class="meta">
    <span><b>${esc(m.persona)}</b> ${esc(b.persona || m.empty)}</span>
    <span><b>${esc(m.tier)}</b> ${esc(b.tier || m.empty)}</span>
    <span><b>${esc(m.mode)}</b> <span class="sw">${esc(sw)}</span></span>
    <span><b>${esc(m.risk)}</b> Lv.${esc(gate.riskLevel ?? m.empty)}${gate.sudoGate ? esc(m.sudoGate) : ''}</span>
  </div>

  <h2>${esc(m.intent)}</h2>
  <p>${esc(b.intent || '')}</p>

  <h2>${esc(m.goals)}</h2>
  ${li(b.victoryConditions)}

  <h2>${esc(m.scope)}</h2>
  <div class="grid">
    <div class="box"><h3>${esc(m.scopeIn)}</h3>${li((b.scope || {}).in)}</div>
    <div class="box"><h3>${esc(m.scopeOut)}</h3>${li((b.scope || {}).out)}</div>
  </div>

  <h2>${esc(m.flow)}</h2>
  <div class="tblwrap"><table><thead><tr><th>#</th><th>${esc(m.step)}</th><th>${esc(m.pipelineBasis)}</th></tr></thead><tbody>${flowRows(b.flow, m.empty, m.adHoc)}</tbody></table></div>

  <h2>${esc(m.roles)}</h2>
  <div class="tblwrap"><table><thead><tr><th>${esc(m.owner)}</th><th>${esc(m.role)}</th></tr></thead><tbody>${roleRows(b.roles)}</tbody></table></div>

  <h2>${esc(m.deliverables)}</h2>
  ${li(b.deliverables)}

  <h2>${esc(m.risks)}</h2>
  <div class="tblwrap"><table><thead><tr><th>${esc(m.riskHeader)}</th><th>${esc(m.level)}</th><th>${esc(m.mitigation)}</th></tr></thead><tbody>${riskRows(b.risks)}</tbody></table></div>
  ${b.openItems && b.openItems.length ? `<p class="muted" style="margin-top:8px">${esc(m.openItems)}:</p>` + li(b.openItems) : ''}

  <h2>${esc(m.estimate)}</h2>
  <p>${esc(m.effort)}: ${esc((b.estimate || {}).effort || m.empty)} / ${esc(m.cost)}: ${esc((b.estimate || {}).cost || m.empty)}</p>

  <!-- MO-11 approval gate: decisions are stored in approval-store.
       This HTML is a renderer, not the source of truth. -->
  ${renderGateSection(options.approval, m)}
</div>
${reviewLayerMarkup()}
</body></html>`;
}

function renderGateSection(
  approval: BriefApprovalBinding | undefined,
  m: ReturnType<typeof briefMessages>
): string {
  if (!approval) {
    return `<div id="mg-gate" data-decision="unbound">
    <span id="mg-status">${esc(m.approvalUnbound)}</span>
  </div>`;
  }

  if (approval.status !== 'pending') {
    const label =
      approval.status === 'approved' ? `✅ ${esc(m.approved)}` : `⛔ ${esc(approval.status)}`;
    const how = approval.decidedAuthMethod ? ` (auth: ${esc(approval.decidedAuthMethod)})` : '';
    return `<div id="mg-gate" data-decision="${esc(approval.status)}" data-decided-by="${esc(approval.decidedBy || '')}" data-decided-at="${esc(approval.decidedAt || '')}">
    <span id="mg-status">${label} — ${esc(approval.decidedBy || '?')} / ${esc(approval.decidedAt || '')} ${how}<br>${esc(m.settled)}</span>
  </div>`;
  }

  // The reject vocabulary is the same closed set every other surface uses
  // (LC-10 RejectionReasonCategory), so the changes loop reads identically
  // whether the Sovereign answered here, in Slack, or in the concierge.
  return `<div id="mg-gate" data-decision="pending">
    <button class="ok" type="button" onclick="mgDecide('approved')">✅ ${esc(m.approveButton)}</button>
    <button class="chg" type="button" onclick="mgDecide('rejected')">✏️ ${esc(m.changesButton)}</button>
    <select id="mg-reason" aria-label="${esc(m.reasonPlaceholder)}">
      <option value="">${esc(m.reasonPlaceholder)}</option>
      <option value="incorrect_content">${esc(m.reasonIncorrect)}</option>
      <option value="wrong_direction">${esc(m.reasonDirection)}</option>
      <option value="quality">${esc(m.reasonQuality)}</option>
      <option value="scope">${esc(m.reasonScope)}</option>
      <option value="other">${esc(m.reasonOther)}</option>
    </select>
    <span id="mg-status">${esc(m.pending)}</span>
  </div>
  <script>
    var MG_MESSAGES = ${JSON.stringify({
      chooseReason: m.chooseReason,
      deciderRequired: m.deciderRequired,
      commentPrompt: m.commentPrompt,
      approved: m.approved,
      changes: m.changesButton,
      approvedShort: m.approvedShort,
      changesShort: m.changesShort,
      submitted: m.submitted('__REQUEST_ID__'),
      sending: m.sending,
      failed: m.failed('__ERROR__'),
      deciderNamePrompt: m.deciderNamePrompt,
    })};
    window.__MG_APPROVAL__ = ${JSON.stringify({
      requestId: approval.requestId,
      endpoint: approval.endpoint || '/decision',
      token: approval.token || '',
    })};
    async function mgDecide(d){
      var cfg = window.__MG_APPROVAL__;
      var status = document.getElementById('mg-status');
      var reason = document.getElementById('mg-reason').value;
      if (d === 'rejected' && !reason) { status.textContent = MG_MESSAGES.chooseReason; return; }
      var who = (window.prompt(MG_MESSAGES.deciderNamePrompt, '') || '').trim();
      if (!who) { status.textContent = MG_MESSAGES.deciderRequired; return; }
      var note = (window.prompt(MG_MESSAGES.commentPrompt, '') || '').trim();
      status.textContent = MG_MESSAGES.sending;
      try {
        var res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-rv-token': cfg.token },
          body: JSON.stringify({ requestId: cfg.requestId, decision: d, decidedBy: who, note: note, reasonCategory: reason || undefined })
        });
        var body = await res.json();
        if (!res.ok || !body.ok) { status.textContent = '失敗: ' + (body.error || res.status); return; }
        document.getElementById('mg-gate').setAttribute('data-decision', body.status);
        status.textContent = (body.status === 'approved' ? '✅ ' + MG_MESSAGES.approvedShort : '✏️ ' + MG_MESSAGES.changesShort) +
          ' — ' + MG_MESSAGES.submitted.replace('__REQUEST_ID__', body.requestId);
      } catch (e) {
        status.textContent = MG_MESSAGES.failed.replace('__ERROR__', String(e));
      }
    }
  </script>`;
}

/** CLI: static preview only. Deciding requires serve-brief (see below). */
function main(): void {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: render-brief <mission-brief.json> [out.html]');
    process.exitCode = 1;
    return;
  }
  const out = process.argv[3] || src.replace(/\.json$/iu, '') + '.html';
  if (!safeExistsSync(src)) {
    console.error(`brief not found: ${src}`);
    process.exitCode = 1;
    return;
  }
  const brief = JSON.parse(safeReadFile(src, { encoding: 'utf8' }) as string) as MissionBrief;
  const rendered = renderMissionBriefHtml(brief);
  safeWriteFile(out, rendered, { mkdir: true, encoding: 'utf8' });
  console.log(`rendered mission brief → ${out}`);
  console.log(missingStaticPreviewMessage());
  console.log(`  node dist/scripts/mission_alignment_request.js --mission <ID>`);
  console.log(
    `  KYBERION_PERSONA=<p> node_modules/.bin/tsx scripts/mission-alignment-gate/serve-brief.ts --mission <ID>`
  );
}

function missingStaticPreviewMessage(): string {
  return `${mt('mission_alignment:static_preview_notice')} ${mt('mission_alignment:static_preview_commands')}`;
}

if (process.argv[1] && /render-brief\.(ts|js)$/u.test(process.argv[1])) main();
