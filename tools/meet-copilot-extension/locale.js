// Small extension-local dictionary. The panel is a standalone Chrome asset,
// so it cannot import the repository's TypeScript catalog at runtime.
(function installKyberionMeetLocale(global) {
  'use strict';

  const messages = {
    ja: {
      'screen.title': '共有画面と指示語',
      'screen.capture': '画面を取り込む',
      'screen.resolve': '指示語を解決',
      'screen.hint':
        'フレームは端末内でOCRされ、PII除去後のテキストだけがこのパネルに戻ります。画像はセッション終了時に破棄されます。',
      'screen.contextLabel': '画面から抽出したテキスト',
      'screen.capturePending': '画面を取り込んでいます…',
      'screen.captureFailed': '画面を取り込めませんでした。',
      'screen.captureDone': '{kind} {size} を取り込みました（候補{count}件）。端末内でOCR中…',
      'screen.resolveMissing':
        '画面のテキストがまだ届いていません。「画面を取り込む」を先に実行してください。',
      'screen.resolvePending': '指示語を解決しています…',
      'screen.resolveTitle': '指示語の対応',
      'screen.referenceItem':
        '「{expression}」→ {refersTo}（確度: {confidence}／根拠: {evidence}）',
      'screen.resolveEmpty': '画面テキストと対応づけられる指示語は見つかりませんでした。',
      'screen.localGenerated': 'ローカル生成: {provider}',
      'ai.referenceInputMissing': '指示語を解決する字幕がまだありません。',
      'ai.referenceScreenMissing':
        '画面から抽出したテキストがありません。先に画面を取り込んでください。',
      'ai.referencePrompt1':
        '直近の発言に含まれる指示語（これ・それ・ここ・あちら など）が、共有画面上のどの項目を指しているか推定してください。',
      'ai.referencePrompt2':
        '画面テキストに対応が見つからない指示語は返さないでください。項目名を推測で作らないでください。',
      'ai.referencePrompt3':
        'evidence には、根拠にした画面テキストの該当箇所をそのまま入れてください。',
      'ai.referenceParseLabel': '指示語解決',
      'screen.contextReceived':
        '画面テキストを取得しました（{count}文字、PII除去済み・{provider}）',
      'screen.contextEmpty': '画面から読み取れるテキストがありませんでした。',
    },
    en: {
      'screen.title': 'Shared screen and references',
      'screen.capture': 'Capture screen',
      'screen.resolve': 'Resolve references',
      'screen.hint':
        'The frame is OCR-processed on device. Only PII-redacted text returns to this panel; the image is discarded when the session ends.',
      'screen.contextLabel': 'Text extracted from the screen',
      'screen.capturePending': 'Capturing the screen…',
      'screen.captureFailed': 'The screen could not be captured.',
      'screen.captureDone': '{kind} {size} captured ({count} candidates). Running on-device OCR…',
      'screen.resolveMissing': 'No screen text has arrived. Capture the screen first.',
      'screen.resolvePending': 'Resolving references…',
      'screen.resolveTitle': 'Resolved references',
      'screen.referenceItem':
        '"{expression}" → {refersTo} (confidence: {confidence}; evidence: {evidence})',
      'screen.resolveEmpty': 'No references could be matched to the screen text.',
      'screen.localGenerated': 'Generated locally: {provider}',
      'ai.referenceInputMissing': 'There are no transcript lines to resolve references from.',
      'ai.referenceScreenMissing': 'No text was extracted from the screen. Capture it first.',
      'ai.referencePrompt1':
        'Infer which items on the shared screen the demonstratives in the recent speech refer to.',
      'ai.referencePrompt2':
        'Do not return a demonstrative when no matching screen text exists. Do not invent item names.',
      'ai.referencePrompt3': 'In evidence, include the relevant screen text used as the basis.',
      'ai.referenceParseLabel': 'reference resolution',
      'screen.contextReceived':
        'Screen text received ({count} characters, PII-redacted, {provider})',
      'screen.contextEmpty': 'No readable text was found on the screen.',
    },
  };

  const locale =
    navigator.language && navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  function t(key, params) {
    const template = messages[locale][key] || messages.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`));
  }

  global.KyberionMeetLocale = { locale, t };
  if (typeof document !== 'undefined') {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
    });
  }
})(globalThis);
