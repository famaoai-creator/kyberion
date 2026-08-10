import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharedTmp } from './path-resolver.js';
import {
  createJsonlTail,
  detectRotation,
  splitCompleteLines,
  EMPTY_JSONL_CURSOR,
} from './jsonl-tail.js';

/**
 * EV-04/EV-08: these cover the defect the previous size-delta tailer had —
 * once the file was rotated or truncated the recorded offset permanently
 * exceeded the real size, `size > lastSize` never held again, and every later
 * append was lost silently.
 */
describe('jsonl-tail', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    // secure-io refuses paths outside the repo root, and the repo's temp
    // invariant is active/shared/tmp/ — not the OS temp dir.
    dir = sharedTmp(`jsonl-tail-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'stream.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const append = (...records: unknown[]): void => {
    fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };

  it('新規レコードのみを返し、二度目の read では何も返さない', () => {
    append({ n: 1 }, { n: 2 });
    const tail = createJsonlTail<{ n: number }>(file);

    expect(tail.read().records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(tail.read().records).toEqual([]);

    append({ n: 3 });
    expect(tail.read().records).toEqual([{ n: 3 }]);
  });

  it('切り詰め後の追記を読み落とさない（回帰: size 差分方式の恒久停止）', () => {
    append({ n: 1 }, { n: 2 });
    const tail = createJsonlTail<{ n: number }>(file);
    expect(tail.read().records).toHaveLength(2);

    // Truncate to a single, shorter record: the old implementation recorded an
    // offset past the new size and never delivered again.
    fs.writeFileSync(file, `${JSON.stringify({ n: 9 })}\n`);

    const batch = tail.read();
    expect(batch.rotated).toBe(true);
    expect(batch.records).toEqual([{ n: 9 }]);

    append({ n: 10 });
    expect(tail.read().records).toEqual([{ n: 10 }]);
  });

  it('ファイル置換（別 inode）を検知して先頭から読み直す', () => {
    append({ n: 1 });
    const tail = createJsonlTail<{ n: number }>(file);
    tail.read();

    fs.rmSync(file);
    append({ n: 2 }, { n: 3 });

    const batch = tail.read();
    expect(batch.rotated).toBe(true);
    expect(batch.records).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it('未完結行は消費せず、改行が届いてから1件として返す', () => {
    const tail = createJsonlTail<{ n: number }>(file);
    fs.writeFileSync(file, '{"n":1}\n{"n":2');

    // The partial second record must not be parsed-and-discarded.
    expect(tail.read().records).toEqual([{ n: 1 }]);

    fs.appendFileSync(file, '}\n');
    expect(tail.read().records).toEqual([{ n: 2 }]);
  });

  it('壊れた行は飛ばして残りを配信し、件数を報告する', () => {
    fs.writeFileSync(file, '{"n":1}\nnot json\n{"n":2}\n');
    const batch = createJsonlTail<{ n: number }>(file).read();

    expect(batch.records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(batch.malformed).toBe(1);
  });

  it('マルチバイト文字を含む行でもオフセットがずれない', () => {
    // Byte length differs from character length; a char-based offset would
    // desynchronise here and corrupt every subsequent read.
    append({ msg: '緊急アラート：システム障害' }, { msg: '復旧しました' });
    const tail = createJsonlTail<{ msg: string }>(file);
    expect(tail.read().records).toHaveLength(2);

    append({ msg: '追加' });
    expect(tail.read().records).toEqual([{ msg: '追加' }]);
  });

  it('seekToEnd は既存レコードを飛ばす', () => {
    append({ n: 1 }, { n: 2 });
    const tail = createJsonlTail<{ n: number }>(file);
    tail.seekToEnd();

    expect(tail.read().records).toEqual([]);
    append({ n: 3 });
    expect(tail.read().records).toEqual([{ n: 3 }]);
  });

  it('存在しないファイルは空を返し、出現後に読み始める', () => {
    const tail = createJsonlTail<{ n: number }>(file);
    expect(tail.read().records).toEqual([]);

    append({ n: 1 });
    expect(tail.read().records).toEqual([{ n: 1 }]);
  });

  describe('detectRotation', () => {
    it('未読カーソルではローテーション扱いしない', () => {
      expect(detectRotation(EMPTY_JSONL_CURSOR, { size: 100, fingerprint: 'abc', inode: 1 })).toBe(
        false
      );
    });

    it('サイズ後退・inode 変化・指紋変化のいずれでも検知する', () => {
      const cursor = { offset: 100, fingerprint: 'abc', inode: 1 };
      expect(detectRotation(cursor, { size: 50, fingerprint: 'abc', inode: 1 })).toBe(true);
      expect(detectRotation(cursor, { size: 200, fingerprint: 'abc', inode: 2 })).toBe(true);
      expect(detectRotation(cursor, { size: 200, fingerprint: 'zzz', inode: 1 })).toBe(true);
      expect(detectRotation(cursor, { size: 200, fingerprint: 'abc', inode: 1 })).toBe(false);
    });

    it('inode が取得できない環境（0）では inode 比較を根拠にしない', () => {
      const cursor = { offset: 100, fingerprint: 'abc', inode: 0 };
      expect(detectRotation(cursor, { size: 200, fingerprint: 'abc', inode: 0 })).toBe(false);
    });
  });

  describe('splitCompleteLines', () => {
    it('改行までを消費し、末尾の断片は残す', () => {
      expect(splitCompleteLines('a\nb\nc')).toEqual({ lines: ['a', 'b'], consumedChars: 4 });
    });

    it('改行が無ければ何も消費しない', () => {
      expect(splitCompleteLines('partial')).toEqual({ lines: [], consumedChars: 0 });
    });
  });
});
