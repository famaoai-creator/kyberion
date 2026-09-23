import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  checkI18nHardcoding,
  isExcludedFile,
  isScannedSourceFile,
  isTestFile,
  resolveDefaultScanRoots,
  readI18nHardcodingTextFile,
  isGeneratedFileText,
  scanFileForKanaLiterals,
  scanHtmlForKanaLiterals,
} from './check_i18n_hardcoding.js';

const FIXTURE_DIR = pathResolver.sharedTmp('check-i18n-hardcoding');

function writeFixture(relativePath: string, content: string): string {
  const fullPath = pathResolver.sharedTmp(`check-i18n-hardcoding/${relativePath}`);
  safeMkdir(pathResolver.sharedTmp(`check-i18n-hardcoding/${path.dirname(relativePath)}`), {
    recursive: true,
  });
  safeWriteFile(fullPath, content);
  return fullPath;
}

describe('scanFileForKanaLiterals', () => {
  it('detects a plain string literal containing Hiragana/Katakana', () => {
    const result = scanFileForKanaLiterals("export const label = 'こんにちは';\n", 'example.ts');
    expect(result).toEqual({ count: 1, exemptions: 0 });
  });

  it('detects Hiragana/Katakana in each template literal part around a substitution', () => {
    // Two literal parts here (`こんにちは ` head, ` さん` tail) each contain kana,
    // so both are counted — the substitution itself is not a literal.
    const result = scanFileForKanaLiterals(
      'export function greet(name: string) {\n  return `こんにちは ${name} さん`;\n}\n',
      'example.ts'
    );
    expect(result).toEqual({ count: 2, exemptions: 0 });
  });

  it('detects a JSX text node containing Hiragana/Katakana', () => {
    const result = scanFileForKanaLiterals(
      'export function Component() {\n  return <div>おはよう</div>;\n}\n',
      'example.tsx'
    );
    expect(result).toEqual({ count: 1, exemptions: 0 });
  });

  it('does not detect Japanese text that only appears in a comment', () => {
    const result = scanFileForKanaLiterals(
      "// これはコメントです\nexport const value = 'plain english';\n",
      'example.ts'
    );
    expect(result).toEqual({ count: 0, exemptions: 0 });
  });

  it('does not detect kanji-only strings (out of scope by design)', () => {
    const result = scanFileForKanaLiterals("export const label = '漢字';\n", 'example.ts');
    expect(result).toEqual({ count: 0, exemptions: 0 });
  });

  it('honors an inline i18n-exempt comment on the same line', () => {
    const result = scanFileForKanaLiterals(
      "export const label = 'こんにちは'; // i18n-exempt: legacy voice-hub response, migrated in I18N-04\n",
      'example.ts'
    );
    expect(result).toEqual({ count: 0, exemptions: 1 });
  });

  it('honors an i18n-exempt comment on the line above', () => {
    const result = scanFileForKanaLiterals(
      "// i18n-exempt: legacy voice-hub response, migrated in I18N-04\nexport const label = 'こんにちは';\n",
      'example.ts'
    );
    expect(result).toEqual({ count: 0, exemptions: 1 });
  });

  it('rejects an i18n-exempt comment with no reason', () => {
    const result = scanFileForKanaLiterals(
      "export const label = 'こんにちは'; // i18n-exempt:\n",
      'example.ts'
    );
    expect(result).toEqual({ count: 1, exemptions: 0 });
  });

  it('rejects an i18n-exempt comment missing the colon-delimited reason entirely', () => {
    const result = scanFileForKanaLiterals(
      "export const label = 'こんにちは'; // i18n-exempt\n",
      'example.ts'
    );
    expect(result).toEqual({ count: 1, exemptions: 0 });
  });
});

describe('isTestFile / isExcludedFile', () => {
  it('recognizes .test. and .spec. files and __tests__ directories as test files', () => {
    expect(isTestFile('scripts/check_i18n_hardcoding.test.ts')).toBe(true);
    expect(isTestFile('libs/core/foo.spec.ts')).toBe(true);
    expect(isTestFile('libs/core/__tests__/bar.ts')).toBe(true);
    expect(isTestFile('scripts/check_i18n_hardcoding.ts')).toBe(false);
  });

  it('excludes native-*-engine/examples per plan §2.7', () => {
    expect(isExcludedFile('libs/core/src/native-pptx-engine/examples/gen_project_plan.ts')).toBe(
      true
    );
    expect(isExcludedFile('libs/core/src/native-xlsx-engine/examples/gen_wbs.ts')).toBe(true);
    expect(isExcludedFile('libs/core/src/native-pptx-engine/builders.ts')).toBe(false);
  });
});

describe('UI-01d scan scope: shared UI kit + gallery script', () => {
  it('scans TS everywhere and plain JS only for the shared UI renderer and the gallery', () => {
    expect(isScannedSourceFile('libs/shared-ui/src/components/data.tsx')).toBe(true);
    expect(isScannedSourceFile('libs/shared-ui/vanilla/kyberion-ui.js')).toBe(true);
    expect(isScannedSourceFile('presence/displays/presence-studio/static/ui-gallery.js')).toBe(
      true
    );
    expect(isScannedSourceFile('presence/displays/presence-studio/static/home.js')).toBe(true);
    expect(isScannedSourceFile('presence/displays/presence-studio/static/home.html')).toBe(true);
    expect(isScannedSourceFile('presence/displays/computer-surface/static/index.html')).toBe(true);
    expect(isScannedSourceFile('presence/displays/computer-surface/static/display-prefs.js')).toBe(
      true
    );
    expect(isScannedSourceFile('presence/displays/presence-studio/static/kyberion-ui.css')).toBe(
      false
    );
    expect(isScannedSourceFile('presence/displays/concierge/public/app.html')).toBe(false);
    expect(
      isScannedSourceFile('presence/displays/presence-studio/static/ui-gallery.fixtures.ja.json')
    ).toBe(false);
    const roots = resolveDefaultScanRoots().map((root) =>
      path.relative(pathResolver.rootDir(), root).split(path.sep).join('/')
    );
    expect(roots).toContain('libs/shared-ui');
    expect(roots).toContain('presence/displays/presence-studio');
  });

  it('flags kana in plain JS the same way as TS', () => {
    const source = "export const label = '\u8aad\u307f\u8fbc\u307f\u4e2d';\n";
    expect(scanFileForKanaLiterals(source, 'libs/shared-ui/vanilla/x.js').count).toBe(1);
  });
});

describe('checkI18nHardcoding', () => {
  it('rejects a directory replacement before workspace scanning', () => {
    expect(() => readI18nHardcodingTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for workspace scans', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_i18n_hardcoding.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(filePath');
  });

  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('writes a baseline when --update-baseline is requested and no baseline exists', () => {
    const baselinePath = pathResolver.sharedTmp('check-i18n-hardcoding/baseline.json');
    writeFixture('src/greeting.ts', "export const label = 'こんにちは';\n");

    const report = checkI18nHardcoding({
      baselinePath,
      scanRoots: [pathResolver.sharedTmp('check-i18n-hardcoding/src')],
      updateBaseline: true,
    });

    expect(report.status).toBe('pass');
    expect(report.updated_baseline).toBe(true);
    expect(safeExistsSync(baselinePath)).toBe(true);
    const written = JSON.parse(String(safeReadFile(baselinePath, { encoding: 'utf8' })));
    expect(written.files).toMatchObject({
      'active/shared/tmp/check-i18n-hardcoding/src/greeting.ts': 1,
    });
  });

  it('fails with a clear message when the baseline file is missing', () => {
    writeFixture('src/greeting.ts', "export const label = 'こんにちは';\n");
    const report = checkI18nHardcoding({
      baselinePath: pathResolver.sharedTmp('check-i18n-hardcoding/missing-baseline.json'),
      scanRoots: [pathResolver.sharedTmp('check-i18n-hardcoding/src')],
    });

    expect(report.status).toBe('fail');
    expect(report.violations).toEqual([expect.stringContaining('baseline missing')]);
  });

  it('passes when current counts exactly match the baseline', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    const filePath = writeFixture('src/greeting.ts', "export const label = 'こんにちは';\n");
    const relativeFile = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: { [relativeFile]: 1 },
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('pass');
    expect(report.violations).toEqual([]);
    expect(report.stale_entries).toEqual([]);
  });

  it('flags a file whose violation count increased relative to the baseline', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    const filePath = writeFixture(
      'src/greeting.ts',
      "export const a = 'こんにちは';\nexport const b = 'さようなら';\n"
    );
    const relativeFile = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: { [relativeFile]: 1 },
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('fail');
    expect(report.violations).toEqual([`${relativeFile}: increased from 1 to 2`]);
    expect(report.stale_entries).toEqual([]);
  });

  it('flags a new file (absent from baseline) with violations', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    const filePath = writeFixture('src/greeting.ts', "export const a = 'こんにちは';\n");
    const relativeFile = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: {},
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('fail');
    expect(report.violations).toEqual([
      `${relativeFile}: new file with 1 violation(s) (absent from baseline)`,
    ]);
  });

  it('reports (but does not violate) a file whose count decreased below the baseline', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    const filePath = writeFixture('src/greeting.ts', "export const a = 'こんにちは';\n");
    const relativeFile = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: { [relativeFile]: 3 },
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('fail');
    expect(report.violations).toEqual([]);
    expect(report.stale_entries).toEqual([
      `${relativeFile}: decreased from 3 to 1 (baseline is stale, run --update-baseline)`,
    ]);
  });

  it('reports a stale entry when a file was fully cleaned up (count dropped to zero)', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    const filePath = writeFixture('src/greeting.ts', "export const a = 'plain english';\n");
    const relativeFile = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: { [relativeFile]: 2 },
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('fail');
    expect(report.violations).toEqual([]);
    expect(report.stale_entries).toEqual([
      `${relativeFile}: decreased from 2 to 0 (baseline is stale, run --update-baseline)`,
    ]);
  });

  it('silently drops a baseline entry for a file that no longer exists', () => {
    const scanRoot = pathResolver.sharedTmp('check-i18n-hardcoding/src');
    writeFixture('src/greeting.ts', "export const a = 'plain english';\n");
    const deletedFileEntry = path.join(
      pathResolver.rootDir().split(path.sep).join('/'),
      'active/shared/tmp/check-i18n-hardcoding/src/deleted-file.ts'
    );
    const relativeDeletedFile = path
      .relative(pathResolver.rootDir(), deletedFileEntry)
      .split(path.sep)
      .join('/');
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        scan_roots: ['active/shared/tmp/check-i18n-hardcoding/src'],
        files: { [relativeDeletedFile]: 5 },
      })
    );

    const report = checkI18nHardcoding({ baselinePath, scanRoots: [scanRoot] });

    expect(report.status).toBe('pass');
    expect(report.violations).toEqual([]);
    expect(report.stale_entries).toEqual([]);
  });
});

describe('scanHtmlForKanaLiterals (static surface pages)', () => {
  const file = 'presence/displays/presence-studio/static/example.html';

  it('counts kana text nodes and attribute values, not comments or styles', () => {
    const html = [
      '<!-- コメントは対象外 -->',
      '<style>.x::before { content: "スタイル"; }</style>',
      '<p title="ツールチップ">こんにちは</p>',
      '<p>plain english</p>',
    ].join('\n');
    expect(scanHtmlForKanaLiterals(html, file)).toEqual({ count: 2, exemptions: 0 });
  });

  it('scans inline scripts with the JS rules (comments ignored)', () => {
    const html = "<script>\n// コメント\nconst a = 'ひらがな';\n</script>\n<div>ok</div>";
    expect(scanHtmlForKanaLiterals(html, file)).toEqual({ count: 1, exemptions: 0 });
  });

  it('honors an HTML i18n-exempt comment on the same or previous line', () => {
    const html = '<!-- i18n-exempt: brand wording -->\n<p>カタカナ</p>';
    expect(scanHtmlForKanaLiterals(html, file)).toEqual({ count: 0, exemptions: 1 });
  });

  it('recognizes generated file headers', () => {
    expect(isGeneratedFileText('/* GENERATED by scripts/x.ts - do not edit */\n')).toBe(true);
    expect(isGeneratedFileText('// Generated by x - do not edit\n')).toBe(true);
    expect(isGeneratedFileText('/*\n * home.js — hand written\n */\n')).toBe(false);
  });
});
