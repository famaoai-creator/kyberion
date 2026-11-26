/**
 * Synthetic 4:3 deck for the text-fit checks. Every text box is named for the
 * outcome a correct check must report: `ok-*` must not be flagged, `wrap-*`
 * must be an unexpected_wrap, `overflow-*` must be an overflow. Wording is
 * neutral placeholder Japanese, chosen to reproduce the observed failure
 * classes (chevron / home-plate labels, a body box one line too short, a
 * one-sentence headline, labels in a dashed rounded rectangle).
 */
import type { PptxDesignProtocol, PptxElement } from '@agent/core/contracts/pptx-protocol';

const FONT = 'BIZ UDPGothic';
const LABEL_MARGIN: [number, number, number, number] = [0.03, 0.05, 0.03, 0.05];

function label(
  name: string,
  shapeType: string,
  pos: PptxElement['pos'],
  text: string,
  fontSize: number,
  extra: Partial<PptxElement['style']> = {}
): PptxElement {
  return {
    type: 'shape',
    name,
    shapeType,
    pos,
    text,
    style: {
      fill: 'DCE6F2',
      line: '1F4E79',
      color: '1F2937',
      fontFamily: FONT,
      fontSize,
      bold: true,
      align: 'center',
      valign: 'middle',
      margin: LABEL_MARGIN,
      lineSpacing: 100,
      ...extra,
    },
  };
}

function textBox(
  name: string,
  pos: PptxElement['pos'],
  text: string,
  fontSize: number,
  extra: Partial<PptxElement['style']> = {}
): PptxElement {
  return {
    type: 'text',
    name,
    pos,
    text,
    autofit: 'none',
    style: {
      color: '1F2937',
      fontFamily: FONT,
      fontSize,
      align: 'left',
      valign: 'top',
      margin: LABEL_MARGIN,
      lineSpacing: 100,
      ...extra,
    },
  };
}

/** Slide 1 reproduces the failure classes; slide 2 holds the known-good twins. */
export function buildTextFitFixtureProtocol(): PptxDesignProtocol {
  const failing: PptxElement[] = [
    textBox(
      'wrap-headline-18pt',
      { x: 0.2, y: 0.3, w: 9.6, h: 0.66 },
      '社内の手続きを一つの画面にまとめ、担当者が確認するだけで次の工程へ進めるようにします',
      18,
      { bold: true, align: 'center', margin: [0, 0, 0, 0] }
    ),
    label(
      'wrap-chevron-label',
      'chevron',
      { x: 0.3, y: 1.0, w: 3.0, h: 0.42 },
      '②次の工程　自動処理で検証を実施する',
      11
    ),
    label(
      'wrap-homeplate-label',
      'homePlate',
      { x: 3.5, y: 1.0, w: 2.4, h: 0.42 },
      '①現在の工程　担当者が手作業で確認',
      11
    ),
    textBox(
      'overflow-body-3-lines',
      { x: 0.3, y: 1.6, w: 2.97, h: 0.62 },
      '画面の操作を記録して手順書を作成\n担当者が確認した結果を次の工程の入力として使う\n例外の時だけ担当者へ通知',
      9.5
    ),
    label(
      'wrap-dashed-roundrect',
      'roundRect',
      { x: 3.5, y: 1.6, w: 1.6, h: 0.36 },
      '検証環境の準備と動作確認',
      10.5,
      { lineDash: 'dash', fill: 'FFFFFF' }
    ),
    label(
      'wrap-dashed-roundrect-mixed',
      'roundRect',
      { x: 5.3, y: 1.6, w: 1.6, h: 0.36 },
      'API連携の設計レビュー',
      10.5,
      { lineDash: 'dash', fill: 'FFFFFF' }
    ),
  ];

  const good: PptxElement[] = [
    textBox(
      'ok-headline-17pt',
      { x: 0.2, y: 0.3, w: 9.6, h: 0.66 },
      '社内の手続きを一つの画面にまとめ、担当者が確認するだけで次の工程へ進めます',
      17,
      { bold: true, align: 'center', margin: [0, 0, 0, 0] }
    ),
    label(
      'ok-chevron-label',
      'chevron',
      { x: 0.3, y: 1.0, w: 3.0, h: 0.42 },
      '②次の工程　自動処理で検証',
      11
    ),
    label(
      'ok-homeplate-label',
      'homePlate',
      { x: 3.5, y: 1.0, w: 2.4, h: 0.42 },
      '①現在の工程　手作業',
      11
    ),
    textBox(
      'ok-body-3-lines',
      { x: 0.3, y: 1.6, w: 2.97, h: 0.62 },
      '画面の操作を記録して手順書を作成\n確認した結果を次の工程の入力にする\n例外の時だけ担当者へ通知',
      9.5
    ),
    label(
      'ok-dashed-roundrect',
      'roundRect',
      { x: 3.5, y: 1.6, w: 1.6, h: 0.36 },
      '検証環境の準備',
      10.5,
      { lineDash: 'dash', fill: 'FFFFFF' }
    ),
    label(
      'ok-two-line-label',
      'rect',
      { x: 5.3, y: 1.6, w: 1.4, h: 0.6 },
      '確認の結果\nAPIで連携',
      9.5
    ),
    textBox(
      'ok-flowing-body',
      { x: 0.3, y: 2.6, w: 4.0, h: 1.4 },
      '本文は左揃えで、枠の高さに余裕があるため折り返しても問題ありません。手順の説明や補足のように、行を指定せずに流し込む文章を想定しています。',
      11,
      { margin: [0.05, 0.1, 0.05, 0.1] }
    ),
    label('ok-ellipse-label', 'ellipse', { x: 4.6, y: 2.6, w: 1.4, h: 0.8 }, '担当者', 12),
    label(
      'ok-latin-label',
      'roundRect',
      { x: 6.3, y: 2.6, w: 2.4, h: 0.42 },
      'Review the API design',
      11
    ),
  ];

  return {
    version: '3.0.0',
    generatedAt: '2026-11-26T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: {},
    master: { elements: [] },
    slides: [
      { id: 'failing', elements: failing },
      { id: 'good', elements: good },
    ],
  };
}
