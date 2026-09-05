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
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { t as catalogT } from '@agent/core/t';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { loadMissionBriefAtPath } from './mission-brief.js';

type Print = (value: unknown) => void;

export function resolveDecisionResourcePath(inputPath: string, allowMissingLeaf = false): string {
  return assertSafeRepositoryPath(inputPath, { allowMissingLeaf });
}

export function main(argv: string[] = [], print: Print = () => undefined): void {
  const htmlPath = argv[0];
  const jsonPath = argv[1];
  if (!htmlPath || !jsonPath)
    throw new ScriptExitError(1, 'usage: read-decision <reviewed.html> <mission-brief.json>');
  const safeHtmlPath = resolveDecisionResourcePath(htmlPath, true);
  if (!safeExistsSync(safeHtmlPath)) throw new ScriptExitError(1, `html not found: ${htmlPath}`);
  if (!safeLstat(safeHtmlPath).isFile())
    throw new ScriptExitError(1, `html is not a regular file: ${htmlPath}`);

  const html = readTextFile(safeHtmlPath);
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

  const safeJsonPath = resolveDecisionResourcePath(jsonPath, true);
  const b =
    safeExistsSync(safeJsonPath) && safeLstat(safeJsonPath).isFile()
      ? loadMissionBriefAtPath(safeJsonPath)
      : {};

  print(
    JSON.stringify(
      { decision, decidedAt: at, decidedBy: by, commentCount: comments.length, comments },
      null,
      2
    )
  );

  if (decision === 'approved') {
    print(`\n=== ${catalogT('mission_alignment:decision_approved')} ===`);
    print(
      'Static HTML is not an approval record. Re-check the shared approval-store with ' +
        `node dist/scripts/mission_alignment_decision.js --mission ${b.missionId || '<MISSION_ID>'} --strict`
    );
    print(
      'If the strict check passes, use mission_controller gate-pass ALIGNMENT_APPROVED; do not run start from this output.'
    );
    throw new ScriptExitError(2, '', true);
  } else if (decision === 'changes' || decision === 'rejected') {
    print(`\n=== ${catalogT('mission_alignment:decision_changes')} ===`);
  } else {
    print(`\n=== ${catalogT('mission_alignment:decision_pending')} ===`);
  }
}

if (
  isDirectScript(import.meta.url, 'read-decision.ts') ||
  isDirectScript(import.meta.url, 'read-decision.js')
)
  void defineScript({
    name: 'mission-alignment:read-decision',
    flags: [],
    run: ({ argv, print }) => main(argv, print),
  })();
