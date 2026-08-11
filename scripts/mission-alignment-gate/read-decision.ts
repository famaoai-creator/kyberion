/**
 * read-decision.ts — レビュー済みミッションブリーフから「承認/要修正」判断とフィードバックを読み取る
 *
 * Sovereign が report-review で承認/要修正＋コメント/編集し 💾保存 した後、AIがこれを実行して
 *  - decision（approved / changes / pending）
 *  - コメント一覧（要修正の反映用）
 *  - approved の場合でも、HTML の判断は正本ではないため起動コマンドを出さない。
 *    正本の approval-store を `mission_alignment_decision --strict` で確認する。
 *
 * 使い方:
 *   node_modules/.bin/tsx scripts/mission-alignment-gate/read-decision.ts <reviewed.html> <mission-brief.json>
 */
import { safeReadFile, safeExistsSync } from '@agent/core/secure-io';
import { t as catalogT } from '@agent/core/t';

const htmlPath = process.argv[2];
const jsonPath = process.argv[3];
if (!htmlPath || !jsonPath) {
  console.error('usage: read-decision <reviewed.html> <mission-brief.json>');
  process.exit(1);
}
if (!safeExistsSync(htmlPath)) {
  console.error(`html not found: ${htmlPath}`);
  process.exit(1);
}

const html = safeReadFile(htmlPath, { encoding: 'utf8' }) as string;
// mg-gate 要素の開始タグに限定して属性を読む（CSSセレクタ data-decision="approved" への誤マッチ防止）
const gateTag = (html.match(/<div\s+id="mg-gate"[^>]*>/) || [''])[0];
const decision = (gateTag.match(/data-decision="([^"]*)"/) || [])[1] || 'pending';
const at = (gateTag.match(/data-decided-at="([^"]*)"/) || [])[1] || '';
const by = (gateTag.match(/data-decided-by="([^"]*)"/) || [])[1] || '';
const comments: string[] = [];
const reNote = /data-note="([^"]*)"/g;
let mm: RegExpExecArray | null;
while ((mm = reNote.exec(html)))
  comments.push(mm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

const b = safeExistsSync(jsonPath)
  ? JSON.parse(safeReadFile(jsonPath, { encoding: 'utf8' }) as string)
  : {};

console.log(
  JSON.stringify(
    { decision, decidedAt: at, decidedBy: by, commentCount: comments.length, comments },
    null,
    2
  )
);

if (decision === 'approved') {
  console.log(`\n=== ${catalogT('mission_alignment:decision_approved')} ===`);
  console.log(
    'Static HTML is not an approval record. Re-check the shared approval-store with ' +
      `node dist/scripts/mission_alignment_decision.js --mission ${b.missionId || '<MISSION_ID>'} --strict`
  );
  console.log(
    'If the strict check passes, use mission_controller gate-pass ALIGNMENT_APPROVED; do not run start from this output.'
  );
  process.exitCode = 2;
} else if (decision === 'changes' || decision === 'rejected') {
  console.log(`\n=== ${catalogT('mission_alignment:decision_changes')} ===`);
} else {
  console.log(`\n=== ${catalogT('mission_alignment:decision_pending')} ===`);
}
