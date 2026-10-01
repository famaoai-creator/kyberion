import { discussionRoleLabel, fillCopy, loadDiscussionCopy } from './discussion-copy.js';
import { pickByLocale } from '../locale-normalize.js';
import type {
  DiscussionMessageView,
  DiscussionParticipant,
  DiscussionRoomState,
  DiscussionStance,
} from './discussion-types.js';

/**
 * The decision brief: one self-contained HTML document (no network, no
 * external scripts) that turns a concluded discussion into something a person
 * can review — consensus over rounds, who moved where, which objections were
 * resolved, the decision and its next actions.
 *
 * `view` is a read-only rendering (what is stored as the deliverable).
 * `review` adds editable next actions and the accept / send back / reject
 * controls; it talks to its host only through `postMessage`, so the HTML never
 * needs credentials and works inside a sandboxed iframe.
 */
export type DiscussionBriefMode = 'view' | 'review';

const AGENT_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#db2777',
  '#7c3aed',
  '#0891b2',
  '#65a30d',
  '#dc2626',
];

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** JSON safe to place inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

const STANCE_CLASS: Record<DiscussionStance, string> = {
  support: 'st-support',
  oppose: 'st-oppose',
  question: 'st-question',
  neutral: 'st-neutral',
};

function stanceLabel(stance: DiscussionStance, locale: 'ja' | 'en'): string {
  const labels = pickByLocale(locale, {
    en: { support: 'Support', oppose: 'Oppose', question: 'Question', neutral: 'Neutral' },
    // i18n-exempt: per-locale label table (the ja row of the stance labels)
    ja: { support: '賛成', oppose: '反対', question: '要確認', neutral: '中立' },
  });
  return labels[stance];
}

interface ObjectionRow {
  message: DiscussionMessageView;
  resolved: boolean;
}

function collectObjections(room: DiscussionRoomState): ObjectionRow[] {
  const rows: ObjectionRow[] = [];
  room.messages.forEach((message, index) => {
    if (message.kind !== 'agent') return;
    if (message.stance !== 'oppose' && message.stance !== 'question') return;
    const resolved = room.messages
      .slice(index + 1)
      .some(
        (later) =>
          later.kind === 'agent' && later.speaker === message.speaker && later.stance === 'support'
      );
    rows.push({ message, resolved });
  });
  return rows;
}

function trendSvg(room: DiscussionRoomState, noData: string): string {
  const points = room.consensus_history;
  if (points.length === 0) return `<p class="muted">${esc(noData)}</p>`;
  const width = 320;
  const height = 130;
  const padX = 26;
  const padTop = 20;
  const padBottom = 24;
  const x = (i: number) =>
    points.length === 1 ? width / 2 : padX + (i * (width - padX * 2)) / (points.length - 1);
  const y = (v: number) => padTop + (1 - v) * (height - padTop - padBottom);
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const threshold = y(room.config.consensus_threshold);
  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" class="dot"/>` +
        `<text x="${x(i).toFixed(1)}" y="${(y(p.value) - 9).toFixed(1)}" text-anchor="middle" class="val">${Math.round(p.value * 100)}</text>` +
        `<text x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="axis">${p.round}</text>`
    )
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(noData)}" class="trend">
  <line x1="${padX}" x2="${width - padX}" y1="${threshold.toFixed(1)}" y2="${threshold.toFixed(1)}" class="thr"/>
  <path d="${area}" class="area"/><path d="${line}" class="ln"/>${dots}</svg>`;
}

function stanceMatrix(room: DiscussionRoomState, locale: 'ja' | 'en'): string {
  const speakers = room.participants.filter((p) => p.role !== 'facilitator');
  const rounds = [
    ...new Set(room.messages.filter((m) => m.kind === 'agent').map((m) => m.round)),
  ].sort((a, b) => a - b);
  if (speakers.length === 0 || rounds.length === 0) return '';
  const head = rounds.map((r) => `<th scope="col">${r}</th>`).join('');
  const body = speakers
    .map((p) => {
      const cells = rounds
        .map((round) => {
          const last = [...room.messages]
            .reverse()
            .find((m) => m.kind === 'agent' && m.speaker === p.id && m.round === round);
          if (!last?.stance)
            return '<td><span class="cell st-none" aria-hidden="true"></span></td>';
          return `<td><a class="cell ${STANCE_CLASS[last.stance]}" href="#m-${esc(last.id)}" data-jump="${esc(last.id)}" title="${esc(stanceLabel(last.stance, locale))}"><span class="sr">${esc(stanceLabel(last.stance, locale))}</span></a></td>`;
        })
        .join('');
      return `<tr><th scope="row"><span class="dot-agent" style="background:${agentColor(room, p)}"></span>${esc(discussionRoleLabel(p.role, locale))}</th>${cells}</tr>`;
    })
    .join('');
  return `<table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
  <div class="legend">${(['support', 'question', 'neutral', 'oppose'] as DiscussionStance[])
    .map(
      (s) => `<span><i class="cell ${STANCE_CLASS[s]}"></i>${esc(stanceLabel(s, locale))}</span>`
    )
    .join('')}</div>`;
}

function agentColor(room: DiscussionRoomState, participant: DiscussionParticipant): string {
  const index = room.participants.findIndex((p) => p.id === participant.id);
  return AGENT_COLORS[(index < 0 ? 0 : index) % AGENT_COLORS.length];
}

export function renderDiscussionBriefHtml(
  room: DiscussionRoomState,
  options: { mode: DiscussionBriefMode }
): string {
  const locale = room.config.locale;
  const copy = loadDiscussionCopy().brief;
  const t = (key: string, vars: Record<string, string | number> = {}) =>
    fillCopy(copy[key]?.[locale] ?? key, vars);
  const decision = room.decision;
  const { proposals, review, mission, work_items: created } = room.outcomes;
  const reviewable = options.mode === 'review' && Boolean(decision) && !review;
  const roleOptions = room.participants.map((p) => ({
    id: p.role,
    label: discussionRoleLabel(p.role, locale),
  }));
  const objections = collectObjections(room);
  const verdictLabel = review ? t(`verdict_${review.verdict.replace('-', '_')}`) : '';

  const chips = [
    `${esc(t('consensus'))} ${Math.round(room.consensus * 100)}%`,
    `${room.participants.length} ${esc(t('participants'))}`,
    `${room.messages.length} / ${room.round} ${esc(t('round', { round: '' }).trim())}`,
    room.scope.tenant_slug ? esc(room.scope.tenant_slug) : '',
    room.scope.mission_id ? esc(room.scope.mission_id) : '',
  ]
    .filter(Boolean)
    .map((c) => `<span class="chip">${c}</span>`)
    .join('');

  const proposalRows = proposals
    .map((proposal) => {
      const included = proposal.included !== false;
      const done = created[proposal.id];
      if (!reviewable) {
        return `<tr data-id="${esc(proposal.id)}"${included ? '' : ' class="dropped"'}>
          <td>${included ? '✓' : '—'}</td><td>${esc(proposal.title)}${done ? ` <span class="pill ok">${esc(done)}</span>` : ''}</td>
          <td>${esc(t(`priority_${proposal.priority}`))}</td>
          <td>${esc(proposal.owner_role ? discussionRoleLabel(proposal.owner_role, locale) : t('owner_none'))}</td></tr>`;
      }
      const prio = (['high', 'normal', 'low'] as const)
        .map(
          (p) =>
            `<option value="${p}"${proposal.priority === p ? ' selected' : ''}>${esc(t(`priority_${p}`))}</option>`
        )
        .join('');
      const owners = [`<option value="">${esc(t('owner_none'))}</option>`]
        .concat(
          roleOptions.map(
            (r) =>
              `<option value="${esc(r.id)}"${proposal.owner_role === r.id ? ' selected' : ''}>${esc(r.label)}</option>`
          )
        )
        .join('');
      return `<tr data-id="${esc(proposal.id)}">
        <td><input type="checkbox" class="f-include" ${included ? 'checked' : ''} aria-label="${esc(t('col_include'))}"></td>
        <td><input type="text" class="f-title" maxlength="100" value="${esc(proposal.title)}"></td>
        <td><select class="f-priority">${prio}</select></td>
        <td><select class="f-owner">${owners}</select></td></tr>`;
    })
    .join('');

  const transcript = (() => {
    const byRound = new Map<number, DiscussionMessageView[]>();
    for (const m of room.messages) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m]);
    return [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, messages]) => {
        const items = messages
          .map((m) => {
            const participant = room.participants.find((p) => p.id === m.speaker);
            const who =
              m.kind === 'human'
                ? t('human')
                : discussionRoleLabel(participant?.role ?? m.speaker, locale);
            const color = participant ? agentColor(room, participant) : '#64748b';
            return `<article class="msg" id="m-${esc(m.id)}" data-speaker="${esc(m.speaker)}" style="--c:${color}">
              <header><strong>${esc(who)}</strong>${participant ? `<span class="muted">${esc(participant.name)}</span>` : ''}${
                m.stance
                  ? `<span class="tag ${STANCE_CLASS[m.stance]}">${esc(stanceLabel(m.stance, locale))}</span>`
                  : ''
              }</header><p>${esc(m.text)}</p></article>`;
          })
          .join('');
        return `<details open class="round"><summary>${esc(t('round', { round }))}</summary>${items}</details>`;
      })
      .join('');
  })();

  const filters = room.participants
    .map(
      (p) =>
        `<button type="button" class="fchip" data-filter="${esc(p.id)}" style="--c:${agentColor(room, p)}">${esc(discussionRoleLabel(p.role, locale))}</button>`
    )
    .join('');

  const dissentHtml = decision?.dissent.length
    ? `<h3>${esc(t('dissent'))}</h3><ul>${decision.dissent.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
    : '';
  const agreementsHtml = decision?.agreements.length
    ? `<h3>${esc(t('agreements'))}</h3><ul>${decision.agreements.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '';

  const reviewPanel = (() => {
    if (review) {
      return `<section class="card review-done"><h2>${esc(t('reviewed'))}: ${esc(verdictLabel)}</h2>${
        review.note ? `<p>${esc(review.note)}</p>` : ''
      }${mission ? `<p class="muted">${esc(t('mission_pending'))}</p>` : ''}</section>`;
    }
    if (options.mode !== 'review' || !decision) {
      return decision ? `<p class="muted note">${esc(t('readonly_hint'))}</p>` : '';
    }
    return `<section class="card review" id="review"><h2>${esc(t('review_title'))}</h2>
      <p class="muted">${esc(t('edit_hint'))}</p>
      <label class="fld"><span>${esc(t('note_label'))}</span><textarea id="note" rows="3" maxlength="1000" placeholder="${esc(t('note_placeholder'))}"></textarea></label>
      ${room.scope.mission_id ? '' : `<label class="chk"><input type="checkbox" id="req-mission" checked> ${esc(t('request_mission'))}</label>`}
      <div class="actions"><button type="button" class="btn primary" data-verdict="accept">${esc(t('accept'))}</button>
      <button type="button" class="btn" data-verdict="request-changes">${esc(t('request_changes'))}</button>
      <button type="button" class="btn danger" data-verdict="reject">${esc(t('reject'))}</button></div>
      <p id="status" class="muted" role="status"></p></section>`;
  })();

  const data = {
    mode: options.mode,
    roomId: room.id,
    strings: {
      sending: t('sending'),
      sent: t('sent'),
      failed: t('failed'),
      noteRequired: t('note_required'),
    },
  };

  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t('eyebrow'))}: ${esc(room.title)}</title>
<style>${BRIEF_CSS}</style></head><body>
<main>
<header class="top"><div class="eyebrow">${esc(t('eyebrow'))}</div><h1>${esc(room.title)}</h1>
<p class="goal"><strong>${esc(t('goal'))}:</strong> ${esc(room.goal)}</p><div class="chips">${chips}</div></header>
${
  decision
    ? `<section class="card decision"><h2>${esc(t('decision'))}</h2><p class="lead">${esc(decision.summary)}</p>${agreementsHtml}${dissentHtml}</section>`
    : ''
}
<div class="cols">
<section class="card"><h2>${esc(t('stance_map'))}</h2>${stanceMatrix(room, locale)}</section>
<section class="card"><h2>${esc(t('consensus_trend'))}</h2>${trendSvg(room, t('no_data'))}</section>
</div>
${
  objections.length
    ? `<section class="card"><h2>${esc(t('objections'))}</h2><ul class="objections">${objections
        .map((o) => {
          const p = room.participants.find((x) => x.id === o.message.speaker);
          return `<li><a href="#m-${esc(o.message.id)}" data-jump="${esc(o.message.id)}"><strong>${esc(
            discussionRoleLabel(p?.role ?? o.message.speaker, locale)
          )}</strong> ${esc(clip(o.message.text, 150))}</a><span class="pill ${o.resolved ? 'ok' : 'warn'}">${esc(
            o.resolved ? t('resolved') : t('unresolved')
          )}</span></li>`;
        })
        .join('')}</ul></section>`
    : ''
}
${
  proposals.length
    ? `<section class="card"><h2>${esc(t('next_steps'))}</h2><table class="proposals" id="proposals"><thead><tr><th>${esc(
        t('col_include')
      )}</th><th>${esc(t('col_title'))}</th><th>${esc(t('col_priority'))}</th><th>${esc(
        t('col_owner')
      )}</th></tr></thead><tbody>${proposalRows}</tbody></table></section>`
    : ''
}
${reviewPanel}
<section class="card"><h2>${esc(t('discussion'))}</h2>
<div class="tools"><button type="button" class="fchip on" data-filter="*">${esc(t('filter_all'))}</button>${filters}
<span class="spacer"></span><button type="button" class="link" id="expand">${esc(t('expand_all'))}</button>
<button type="button" class="link" id="collapse">${esc(t('collapse_all'))}</button></div>${transcript}</section>
<footer class="muted">${esc(t('generated', { id: room.id }))}</footer>
</main>
<script type="application/json" id="brief-data">${scriptJson(data)}</script>
<script>${BRIEF_JS}</script>
</body></html>`;
}

const BRIEF_CSS = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--mute:#64748b;--line:#e2e8f0;--acc:#1d4ed8;--ok:#047857;--okbg:#d1fae5;--warn:#b45309;--warnbg:#fef3c7;--bad:#b91c1c;--badbg:#fee2e2;--neu:#94a3b8}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#141b29;--ink:#e6edf7;--mute:#94a3b8;--line:#263247;--acc:#7aa7ff;--ok:#6ee7b7;--okbg:#064e3b;--warn:#fcd34d;--warnbg:#451a03;--bad:#fca5a5;--badbg:#450a0a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 20px 48px;display:flex;flex-direction:column;gap:16px}
.top .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--acc);font-weight:700}
h1{margin:2px 0 4px;font-size:26px;line-height:1.3}h2{margin:0 0 10px;font-size:14px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}h3{margin:14px 0 4px;font-size:13px;color:var(--mute)}
.goal{margin:0 0 8px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:2px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px;background:var(--card)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.decision{border-color:var(--acc)}.lead{font-size:17px;font-weight:600;margin:0}ul{margin:4px 0 0;padding-left:1.2em}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:720px){.cols{grid-template-columns:1fr}}
.muted{color:var(--mute);font-size:13px}.sr{position:absolute;left:-9999px}
table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}
.matrix th[scope=row]{font-weight:600;white-space:nowrap}.matrix td{text-align:center}.matrix thead th{color:var(--mute);font-size:12px;text-align:center}
.cell{display:inline-block;width:22px;height:22px;border-radius:6px;vertical-align:middle;text-decoration:none}a.cell:hover{outline:2px solid var(--acc);outline-offset:2px}
.st-support{background:var(--ok)}.st-oppose{background:var(--bad)}.st-question{background:#d97706}.st-neutral{background:var(--neu)}.st-none{background:transparent;border:1px dashed var(--line)}
.legend{display:flex;gap:12px;margin-top:8px;font-size:12px;color:var(--mute)}.legend .cell{width:12px;height:12px;margin-right:4px;border-radius:3px}
.dot-agent{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.trend{width:100%;height:auto}.trend .ln{fill:none;stroke:var(--acc);stroke-width:2.5;stroke-linejoin:round}.trend .area{fill:var(--acc);opacity:.12}.trend .dot{fill:var(--card);stroke:var(--acc);stroke-width:2.5}.trend .thr{stroke:var(--line);stroke-dasharray:4 4;stroke-width:1.5}.trend .val{font-size:10px;fill:var(--ink)}.trend .axis{font-size:10px;fill:var(--mute)}
.objections{list-style:none;padding:0;display:flex;flex-direction:column;gap:6px}.objections li{display:flex;gap:10px;align-items:center;justify-content:space-between}.objections a{color:inherit;text-decoration:none}.objections a:hover{color:var(--acc)}
.pill{padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}
input[type=text],select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
.proposals .dropped td{opacity:.5;text-decoration:line-through}.proposals td:first-child{width:56px;text-align:center}
.review{border-color:var(--acc)}.fld{display:flex;flex-direction:column;gap:4px;margin:10px 0;font-size:13px;color:var(--mute)}.chk{display:block;margin:6px 0;font-size:14px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.btn{font:inherit;font-weight:700;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}.btn.danger{color:var(--bad)}.btn:disabled{opacity:.5;cursor:not-allowed}
.review-done{border-color:var(--ok)}.review-done h2{color:var(--ok)}
.tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}.spacer{flex:1}.fchip{font:inherit;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--c,var(--line));background:transparent;color:var(--ink);cursor:pointer}.fchip.on{background:var(--c,var(--acc));color:#fff}.link{font:inherit;font-size:12px;background:none;border:0;color:var(--acc);cursor:pointer}
details.round{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer;font-weight:700;font-size:13px;color:var(--mute)}
.msg{border-left:3px solid var(--c,var(--neu));padding:4px 12px;margin:8px 0}.msg header{display:flex;gap:8px;align-items:center;font-size:13px}.msg p{margin:2px 0 0}.msg.hit{background:var(--warnbg)}.msg.hide{display:none}
.tag{padding:0 8px;border-radius:999px;font-size:11px;color:#fff}.note{text-align:center}footer{text-align:center}
@media print{body{background:#fff}.tools,.review{display:none}}`;

const BRIEF_JS = `(function(){
var data=JSON.parse(document.getElementById('brief-data').textContent);
function all(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
// Agent filter
var active=null;
all('[data-filter]').forEach(function(btn){btn.addEventListener('click',function(){
  var f=btn.getAttribute('data-filter');active=(f==='*'||active===f)?null:f;
  all('[data-filter]').forEach(function(b){b.classList.toggle('on',(active===null&&b.getAttribute('data-filter')==='*')||b.getAttribute('data-filter')===active);});
  all('.msg').forEach(function(m){m.classList.toggle('hide',active!==null&&m.getAttribute('data-speaker')!==active);});
});});
// Jump from the matrix / objections to the exact message
all('[data-jump]').forEach(function(a){a.addEventListener('click',function(e){
  e.preventDefault();var el=document.getElementById('m-'+a.getAttribute('data-jump'));if(!el)return;
  var d=el.closest('details');if(d)d.open=true;el.classList.remove('hide');el.scrollIntoView({behavior:'smooth',block:'center'});
  el.classList.add('hit');setTimeout(function(){el.classList.remove('hit');},1800);});});
function setOpen(v){all('details.round').forEach(function(d){d.open=v;});}
var ex=document.getElementById('expand'),co=document.getElementById('collapse');
if(ex)ex.addEventListener('click',function(){setOpen(true);});if(co)co.addEventListener('click',function(){setOpen(false);});
// Review controls (only present in review mode)
var status=document.getElementById('status');
function setStatus(t){if(status)status.textContent=t;}
function collect(){var edits=[];all('#proposals tbody tr[data-id]').forEach(function(tr){
  var inc=tr.querySelector('.f-include');if(!inc)return;
  edits.push({id:tr.getAttribute('data-id'),included:inc.checked,title:tr.querySelector('.f-title').value,
    priority:tr.querySelector('.f-priority').value,owner_role:tr.querySelector('.f-owner').value||null});});return edits;}
all('[data-verdict]').forEach(function(btn){btn.addEventListener('click',function(){
  var verdict=btn.getAttribute('data-verdict');var note=(document.getElementById('note')||{}).value||'';
  if(verdict==='request-changes'&&!note.trim()){setStatus(data.strings.noteRequired);return;}
  var rm=document.getElementById('req-mission');
  all('[data-verdict]').forEach(function(b){b.disabled=true;});setStatus(data.strings.sending);
  window.parent.postMessage({source:'kyberion-brief',type:'review',roomId:data.roomId,
    payload:{verdict:verdict,note:note,edits:collect(),request_mission:rm?rm.checked:false}},'*');});});
window.addEventListener('message',function(e){var m=e.data;if(!m||m.source!=='kyberion-brief-host')return;
  if(m.ok){setStatus(data.strings.sent+(m.note?' — '+m.note:''));}else{setStatus(data.strings.failed+(m.error?': '+m.error:''));
    all('[data-verdict]').forEach(function(b){b.disabled=false;});}});
})();`;
