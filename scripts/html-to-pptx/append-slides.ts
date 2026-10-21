/**
 * append-slides — 既存 PPTX の末尾に、別 PPTX のスライドを差し込む。
 *
 * media-actuator には結合 op が無い（`pptx_patch`＝テキスト置換、`pptx_filter_slides`＝抽出、
 * `patchPptxParagraphs` はいずれも単一ファイル内の操作）。テンプレート由来のデッキに
 * 自動生成スライドを足す用途が満たせないため、その差分だけをここで埋める。
 *
 * 方式: OOXML パッケージ（zip）の部品コピー。source 側のスライド・レイアウト・マスタ・
 * テーマ・メディアを番号衝突しないよう採番し直して target へ複製し、
 * `presentation.xml`（sldIdLst / sldMasterIdLst）・`presentation.xml.rels`・
 * `[Content_Types].xml` を更新する。source のマスタごと持ち込むため見た目は維持される。
 *
 * 前提: 双方の `sldSz`（スライドサイズ）が一致していること。異なる場合は中止する
 * （4:3 のデッキに 16:9 のスライドを入れると右側が切れるため）。
 *
 * Run:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/html-to-pptx/append-slides.ts \
 *     <target.pptx> <source.pptx> <out.pptx> [--at <1-based index>]
 */
import AdmZip from 'adm-zip';
import path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { t } from '@agent/core/t';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { cliOptionValue } from '../lib/cli-guard.js';

const USAGE = 'usage: append-slides.ts <target.pptx> <source.pptx> <out.pptx> [--at N]';

export function main(argv: string[] = []): void {
  const [targetPath, sourcePath, outPath] = argv.filter((a) => !a.startsWith('--'));
  const insertAt = Number(cliOptionValue(argv, '--at') ?? 0); // 0/未指定 = 末尾

  if (!targetPath || !sourcePath || !outPath) {
    throw new Error(USAGE);
  }
  for (const p of [targetPath, sourcePath]) {
    if (!safeExistsSync(p)) throw new Error(`not found: ${p}`);
  }

  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const dec = (b: Buffer): string => b.toString('utf8');

  const tz = new AdmZip(safeReadFile(targetPath, { encoding: null }) as Buffer);
  const sz = new AdmZip(safeReadFile(sourcePath, { encoding: null }) as Buffer);
  const tEntry = (n: string): Buffer => {
    const e = tz.getEntry(n);
    if (!e) throw new Error(`target part missing: ${n}`);
    return e.getData();
  };
  const sEntry = (n: string): Buffer => {
    const e = sz.getEntry(n);
    if (!e) throw new Error(`source part missing: ${n}`);
    return e.getData();
  };

  // ── スライドサイズの一致を確認（不一致なら切れるので中止）
  const tPres = dec(tEntry('ppt/presentation.xml'));
  const sPres = dec(sEntry('ppt/presentation.xml'));
  const size = (xml: string): string => /<p:sldSz[^/]*\/>/.exec(xml)?.[0] ?? '';
  const tSz = /cx="(\d+)"\s+cy="(\d+)"/.exec(size(tPres));
  const sSz = /cx="(\d+)"\s+cy="(\d+)"/.exec(size(sPres));
  if (!tSz || !sSz) throw new Error(t('media_tooling_slide_size_unreadable'));
  if (tSz[1] !== sSz[1] || tSz[2] !== sSz[2]) {
    throw new Error(
      t('media_tooling_slide_size_mismatch', {
        target: `${tSz[1]}x${tSz[2]}`,
        source: `${sSz[1]}x${sSz[2]}`,
      })
    );
  }

  // ── 採番の起点（target 側の既存最大番号）
  const maxNum = (zip: AdmZip, dir: string, prefix: string): number => {
    let m = 0;
    for (const e of zip.getEntries()) {
      const r = new RegExp(`^${dir}/${prefix}(\\d+)\\.xml$`).exec(e.entryName);
      if (r) m = Math.max(m, Number(r[1]));
    }
    return m;
  };
  let nSlide = maxNum(tz, 'ppt/slides', 'slide');
  let nLayout = maxNum(tz, 'ppt/slideLayouts', 'slideLayout');
  let nMaster = maxNum(tz, 'ppt/slideMasters', 'slideMaster');
  let nTheme = maxNum(tz, 'ppt/theme', 'theme');
  let nMedia = 0;
  for (const e of tz.getEntries()) {
    const r = /^ppt\/media\/[a-zA-Z]+(\d+)\.[a-z0-9]+$/.exec(e.entryName);
    if (r) nMedia = Math.max(nMedia, Number(r[1]));
  }

  // ── source の部品名 → target での新しい部品名
  const rename = new Map<string, string>();
  const sSlides: string[] = [];
  for (const e of sz.getEntries()) {
    const n = e.entryName;
    let r: RegExpExecArray | null;
    if ((r = /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))) {
      sSlides.push(n);
    } else if ((r = /^ppt\/slideLayouts\/slideLayout(\d+)\.xml$/.exec(n))) {
      rename.set(n, `ppt/slideLayouts/slideLayout${++nLayout}.xml`);
    } else if ((r = /^ppt\/slideMasters\/slideMaster(\d+)\.xml$/.exec(n))) {
      rename.set(n, `ppt/slideMasters/slideMaster${++nMaster}.xml`);
    } else if ((r = /^ppt\/theme\/theme(\d+)\.xml$/.exec(n))) {
      rename.set(n, `ppt/theme/theme${++nTheme}.xml`);
    } else if ((r = /^ppt\/media\/([a-zA-Z]+)(\d+)(\.[a-z0-9]+)$/.exec(n))) {
      rename.set(n, `ppt/media/${r[1]}${++nMedia}${r[3]}`);
    }
  }
  sSlides.sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const newSlideNames: string[] = [];
  for (const s of sSlides) {
    const nn = `ppt/slides/slide${++nSlide}.xml`;
    rename.set(s, nn);
    newSlideNames.push(nn);
  }

  /** rels の Target（相対パス）を新名に張り替える */
  function remapRels(relXml: string, fromPart: string): string {
    const baseDir = path.posix.dirname(fromPart);
    return relXml.replace(/Target="([^"]+)"/g, (m, tgt: string) => {
      if (/^(https?:|mailto:|#|\.\.\/\.\.\/)/.test(tgt) && !tgt.startsWith('../')) return m;
      const abs = path.posix.normalize(path.posix.join(baseDir, tgt));
      const renamed = rename.get(abs);
      if (!renamed) return m;
      return `Target="${path.posix.relative(baseDir, renamed)}"`;
    });
  }

  const out = new AdmZip(safeReadFile(targetPath, { encoding: null }) as Buffer);

  // ── source の部品を複製（rels も張り替えて）
  for (const [from, to] of rename) {
    out.addFile(to, sEntry(from));
    const relFrom = `${path.posix.dirname(from)}/_rels/${path.posix.basename(from)}.rels`;
    if (sz.getEntry(relFrom)) {
      const relTo = `${path.posix.dirname(to)}/_rels/${path.posix.basename(to)}.rels`;
      out.addFile(relTo, Buffer.from(remapRels(dec(sEntry(relFrom)), from), 'utf8'));
    }
  }

  // ── presentation.xml.rels に 新スライド／新マスタ の関係を追加
  const tRelsName = 'ppt/_rels/presentation.xml.rels';
  let tRels = dec(tEntry(tRelsName));
  let maxRid = 0;
  for (const m of tRels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, Number(m[1]));
  const addRel = (target: string, type: string): string => {
    const id = `rId${++maxRid}`;
    tRels = tRels.replace(
      '</Relationships>',
      `<Relationship Id="${id}" Type="${REL}/${type}" Target="${path.posix.relative('ppt', target)}"/></Relationships>`
    );
    return id;
  };
  const newMasterRids: string[] = [];
  for (const [from, to] of rename) {
    if (/^ppt\/slideMasters\//.test(from)) newMasterRids.push(addRel(to, 'slideMaster'));
  }
  const newSlideRids = newSlideNames.map((n) => addRel(n, 'slide'));
  out.addFile(tRelsName, Buffer.from(tRels, 'utf8'));

  // ── presentation.xml の sldIdLst / sldMasterIdLst を更新
  let pres = tPres;
  let maxSldId = 255;
  for (const m of pres.matchAll(/<p:sldId id="(\d+)"/g))
    maxSldId = Math.max(maxSldId, Number(m[1]));
  let maxMasterId = 2147483647 - 1000;
  for (const m of pres.matchAll(/<p:sldMasterId id="(\d+)"/g))
    maxMasterId = Math.max(maxMasterId, Number(m[1]));

  if (newMasterRids.length) {
    const add = newMasterRids
      .map((rid) => `<p:sldMasterId id="${++maxMasterId}" r:id="${rid}"/>`)
      .join('');
    pres = pres.replace('</p:sldMasterIdLst>', `${add}</p:sldMasterIdLst>`);
  }
  const sldIds = newSlideRids.map((rid) => `<p:sldId id="${++maxSldId}" r:id="${rid}"/>`);
  if (insertAt > 0) {
    const items = [...pres.matchAll(/<p:sldId [^>]*\/>/g)].map((m) => m[0]);
    const at = Math.min(Math.max(1, insertAt) - 1, items.length);
    const merged = [...items.slice(0, at), ...sldIds, ...items.slice(at)].join('');
    pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${merged}</p:sldIdLst>`);
  } else {
    pres = pres.replace('</p:sldIdLst>', `${sldIds.join('')}</p:sldIdLst>`);
  }
  out.addFile('ppt/presentation.xml', Buffer.from(pres, 'utf8'));

  // ── [Content_Types].xml に Override を追加
  const CT = '[Content_Types].xml';
  let ct = dec(tEntry(CT));
  const CTYPE: Record<string, string> = {
    slides: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    slideLayouts: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    slideMasters: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  };
  const adds: string[] = [];
  for (const to of rename.values()) {
    const kind = /^ppt\/(slides|slideLayouts|slideMasters|theme)\//.exec(to)?.[1];
    if (kind && !ct.includes(`PartName="/${to}"`))
      adds.push(`<Override PartName="/${to}" ContentType="${CTYPE[kind]}"/>`);
    const ext = /\.([a-z0-9]+)$/.exec(to)?.[1];
    if (/^ppt\/media\//.test(to) && ext && !new RegExp(`Extension="${ext}"`).test(ct)) {
      adds.push(
        `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`
      );
    }
  }
  ct = ct.replace('</Types>', `${adds.join('')}</Types>`);
  out.addFile(CT, Buffer.from(ct, 'utf8'));

  safeWriteFile(outPath, out.toBuffer(), { mkdir: true });

  const finalPres = dec(
    new AdmZip(safeReadFile(outPath, { encoding: null }) as Buffer)
      .getEntry('ppt/presentation.xml')!
      .getData()
  );
  console.log(
    t('media_tooling_append_summary', {
      target: path.basename(targetPath),
      added: newSlideNames.length,
      out: outPath,
      slides: [...finalPres.matchAll(/<p:sldId /g)].length,
      masters: [...finalPres.matchAll(/<p:sldMasterId /g)].length,
      position:
        insertAt > 0
          ? t('media_tooling_append_position_before', { index: insertAt })
          : t('media_tooling_append_position_end'),
    })
  );
}

const script = defineScript({
  name: 'media:append-slides',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (
  isDirectScript(import.meta.url, 'append-slides.ts') ||
  isDirectScript(import.meta.url, 'append-slides.js')
) {
  void script();
}
