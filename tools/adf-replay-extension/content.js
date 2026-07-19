let recordingEnabled = false;
let extractionMode = false;
let conditionalMode = false;
let snapshotHash = null;
const recordedFieldStates = new Set();
let lastExtractionPointer = null;
let lastConditionalPointer = null;

// True while the page has a pending WebAuthn (passkey) request — the OS dialog
// is up and the user is authenticating. Step waits extend instead of timing
// out, and positional fallback holds off. Set via the MAIN-world hook
// installed by the background script (installWebauthnHook).
let webauthnActive = false;
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.__kyberion !== 'webauthn') return;
  webauthnActive = event.data.phase === 'start';
  chrome.runtime
    .sendMessage({ type: 'bridge:webauthn-phase', phase: event.data.phase, ok: event.data.ok })
    .catch(() => undefined);
});

// Popup sentinel — armed during Pattern B execution to detect unexpected dialogs
let executionSentinelActive = false;
let sentinelObserver = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge:ping') {
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'bridge:observe') {
    observePage().then(sendResponse);
    return true;
  }
  if (message?.type === 'bridge:set-recording') {
    recordingEnabled = Boolean(message.enabled);
    if (!recordingEnabled) {
      extractionMode = false;
      conditionalMode = false;
    }
    if (recordingEnabled) {
      recordedFieldStates.clear();
      observePage();
    }
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'bridge:set-extraction-mode') {
    extractionMode = recordingEnabled && Boolean(message.enabled);
    if (extractionMode) conditionalMode = false;
    sendResponse({ ok: true, enabled: extractionMode });
    return;
  }
  if (message?.type === 'bridge:set-conditional-mode') {
    conditionalMode = recordingEnabled && Boolean(message.enabled);
    if (conditionalMode) extractionMode = false;
    sendResponse({ ok: true, enabled: conditionalMode });
    return;
  }
  if (message?.type === 'bridge:execute-step') {
    executeStep(message.step, message.value).then(sendResponse);
    return true;
  }
  if (message?.type === 'bridge:set-execution-active') {
    executionSentinelActive = true;
    armPopupSentinel();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'bridge:set-execution-inactive') {
    executionSentinelActive = false;
    disarmPopupSentinel();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'bridge:verify-golden') {
    sendResponse(verifyGolden(message.conditions || []));
    return;
  }
});

// Post-execution golden-scenario verification (#3): check each success condition
// against the live DOM. Kinds we cannot check in-page do not claim success but
// also do not block (verified:false).
function verifyGolden(conditions) {
  const results = conditions.map((condition) => {
    try {
      if (condition.kind === 'text_present') {
        const needle = condition.name_contains || '';
        const pass = !needle || (document.body?.innerText || '').includes(needle);
        return {
          kind: condition.kind,
          pass,
          detail: pass ? 'テキスト一致' : `"${needle}" が見つかりません`,
        };
      }
      if (condition.kind === 'ref_visible') {
        const matches = interactiveElements().filter(
          (el) =>
            (!condition.role || roleOf(el) === condition.role) &&
            (!condition.name_contains || accessibleName(el).includes(condition.name_contains)) &&
            isVisible(el)
        );
        return {
          kind: condition.kind,
          pass: matches.length > 0,
          detail: matches.length > 0 ? '要素あり' : '対象要素が見つかりません',
        };
      }
      return {
        kind: condition.kind,
        pass: true,
        verified: false,
        detail: 'このブラウザでは検証対象外',
      };
    } catch (error) {
      return {
        kind: condition.kind,
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return { ok: true, results };
}

// --- Approved-step executor (lease-bound replay) -------------------------------
// Re-snapshots before every step, resolves the reviewed ref against the live
// DOM, and refuses to act when the target is missing or ambiguous.
// Wait for the initial page load before touching the DOM — target resolution
// on a half-loaded page misses elements and can mislead the positional
// fallback. Capped: SPAs may never fire load for in-app transitions.
function pageReady(capMs = 15000) {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, capMs);
    window.addEventListener(
      'load',
      () => {
        clearTimeout(cap);
        resolve();
      },
      { once: true }
    );
  });
}

async function executeStep(step, value) {
  if (!step?.target?.ref) return { status: 'error', detail: 'ref がありません' };
  await pageReady();
  let resolved;
  if (step.op === 'click_if_present') {
    // Presence checks are intentionally one-shot: an absent optional target
    // should skip promptly instead of waiting the full ref-resolution timeout.
    await observePage();
    resolved = resolveTarget(step);
  } else {
    resolved = await waitForTarget(step);
  }
  if (!resolved.element) {
    if (step.op === 'click_if_present' && resolved.result?.status === 'not_found') {
      return { status: 'skipped', detail: '条件対象が表示されていないためスキップしました' };
    }
    return resolved.result;
  }
  const element = resolved.element;
  try {
    const outcome = await performAction(element, step, value);
    if (resolved.positionBased && outcome && outcome.status === 'done') {
      outcome.detail = `${outcome.detail || ''}（記録時と内容が変わっていたため、同じ位置の要素を操作しました）`;
    }
    return outcome;
  } catch (error) {
    return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

const TARGET_WAIT_TIMEOUT_MS = 10000;
const TARGET_WAIT_INTERVAL_MS = 100;

function candidatesFor(step) {
  // `submit_form` targets a <form>, which interactiveElements() deliberately
  // excludes — include forms in the candidate pool for that op.
  return step.op === 'submit_form'
    ? [...interactiveElements(), ...document.querySelectorAll('form')]
    : interactiveElements();
}

function resolveTarget(step) {
  const candidates = candidatesFor(step);
  const exact = candidates.filter(
    (element) => semanticRef(element, roleOf(element), accessibleName(element)) === step.target.ref
  );
  if (exact.length > 1) {
    return { result: { status: 'ambiguous', detail: `対象 ${step.target.ref} が複数あります` } };
  }
  if (exact.length === 1) {
    const element = exact[0];
    if (roleOf(element) !== step.target.role || accessibleName(element) !== step.target.name) {
      return {
        result: { status: 'ambiguous', detail: '対象の役割または名称が記録時から変化しました' },
      };
    }
    return { element };
  }

  // SPA updates can insert an earlier control and shift the occurrence-based
  // semantic ref. A unique role+accessible-name match is a safe recovery;
  // ambiguity still stops execution rather than guessing.
  if (step.target.role && step.target.name) {
    const fallback = candidates.filter(
      (element) =>
        roleOf(element) === step.target.role && accessibleName(element) === step.target.name
    );
    if (fallback.length > 1) {
      return { result: { status: 'ambiguous', detail: '同じ役割と名称の対象が複数あります' } };
    }
    if (fallback.length === 1) return { element: fallback[0] };
  }

  return { result: { status: 'not_found', detail: `対象 ${step.target.ref} が見つかりません` } };
}

// Positional fallback: on volatile-content pages (news feeds) the recorded
// accessible name is often gone by replay time. For LOW-RISK ops only, accept
// the element occupying the same structural slot when its role still matches —
// i.e. "click today's headline in the same position". Form-mutating ops keep
// the strict name match and stop instead of guessing.
// Positional recovery is read-only only. Clicking a different same-role element
// can navigate, submit, or trigger an external side effect, so clicks remain
// strict even when a structural path is available.
const POSITIONAL_FALLBACK_OPS = new Set(['wait_for_ref', 'extract_text_ref']);
// Give the exact (name-based) target this long to appear before considering the
// structural slot — avoids grabbing a placeholder on a still-loading page.
const POSITIONAL_GRACE_MS = 3000;

function positionalFallback(step) {
  if (!step.target.dom_path || !POSITIONAL_FALLBACK_OPS.has(step.op)) return null;
  let element = null;
  try {
    element = document.querySelector(step.target.dom_path);
  } catch {
    return null;
  }
  if (!(element instanceof HTMLElement) || !isVisible(element)) return null;
  if (step.target.role && roleOf(element) !== step.target.role) return null;
  return { element, positionBased: true };
}

// Absolute ceiling on a single step's wait, even across passkey pauses.
const TARGET_WAIT_HARD_CAP_MS = 180000;

async function waitForTarget(step) {
  // Extraction regions are often non-interactive containers (tables, panels)
  // that name-based resolution can never find — go positional immediately.
  const graceMs = step.op === 'extract_text_ref' ? 0 : POSITIONAL_GRACE_MS;
  let deadline = Date.now() + TARGET_WAIT_TIMEOUT_MS;
  let positionalAfter = Date.now() + graceMs;
  const hardCap = Date.now() + TARGET_WAIT_HARD_CAP_MS;
  let lastResult = null;
  while (Date.now() <= deadline) {
    // While a passkey/WebAuthn prompt is up the page is intentionally idle —
    // keep pushing the deadline so the step resumes after authentication
    // instead of timing out mid-login.
    if (webauthnActive) {
      deadline = Math.min(Date.now() + TARGET_WAIT_TIMEOUT_MS, hardCap);
      positionalAfter = Math.min(Date.now() + graceMs, hardCap);
    }
    await observePage();
    const resolved = resolveTarget(step);
    if (resolved.element || resolved.result?.status === 'ambiguous') return resolved;
    lastResult = resolved.result;
    if (Date.now() >= positionalAfter && !webauthnActive) {
      const positional = positionalFallback(step);
      if (positional) return positional;
    }
    await new Promise((resolve) => setTimeout(resolve, TARGET_WAIT_INTERVAL_MS));
  }
  const positional = positionalFallback(step);
  if (positional) return positional;
  return {
    result: {
      ...lastResult,
      detail: `${lastResult?.detail || '対象'}（${Math.round((TARGET_WAIT_TIMEOUT_MS / 1000) * 10) / 10}秒待機後）`,
    },
  };
}

async function performAction(element, step, value) {
  element.scrollIntoView({ block: 'center' });
  switch (step.op) {
    case 'click_ref':
    case 'click_if_present':
      element.click();
      return { status: 'done', detail: 'クリックしました' };
    case 'fill_ref':
      if (value == null || value === '')
        return { status: 'skipped', detail: '入力値が指定されていません' };
      setFieldValue(element, String(value));
      return { status: 'done', detail: '入力しました（値は記録しません）' };
    case 'select_ref':
      return applySelection(element, step.selection);
    case 'submit_form': {
      const form = element instanceof HTMLFormElement ? element : element.closest('form');
      if (!form) return { status: 'error', detail: 'フォームが見つかりません' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { status: 'done', detail: '送信しました' };
    }
    case 'press_ref': {
      // Dispatch a key press on the resolved element (default Enter).
      const key = typeof step.key === 'string' && step.key ? step.key : 'Enter';
      element.focus();
      const opts = { key, bubbles: true, cancelable: true };
      element.dispatchEvent(new KeyboardEvent('keydown', opts));
      element.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { status: 'done', detail: `${key} キーを送信しました` };
    }
    case 'wait_for_ref':
      // executeStep already re-snapshotted and uniquely resolved the ref before
      // calling performAction, so reaching here means the target is present.
      return { status: 'done', detail: '対象の出現を確認しました' };
    case 'extract_text_ref': {
      // Read-only observation. Redact before returning so no PII/secret leaves
      // the page (server re-redacts as well, browser-extension-bridge.ts).
      const text = safeText(element.textContent || '');
      return { status: 'done', detail: 'テキストを抽出しました', text };
    }
    default:
      return { status: 'error', detail: `未対応の操作: ${step.op}` };
  }
}

function setFieldValue(element, value) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function applySelection(element, selection) {
  if (!selection) return { status: 'error', detail: 'selection がありません' };
  if (selection.kind === 'toggle') {
    if (element instanceof HTMLInputElement) {
      element.checked = Boolean(selection.checked);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      element.setAttribute('aria-checked', String(Boolean(selection.checked)));
      element.click();
    }
    return { status: 'done', detail: `トグルを${selection.checked ? '有効' : '無効'}にしました` };
  }
  if (element instanceof HTMLSelectElement) {
    const option = [...element.options].find(
      (candidate) => safeText(candidate.label || candidate.textContent) === selection.label
    );
    if (!option)
      return { status: 'not_found', detail: `選択肢「${selection.label}」が見つかりません` };
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { status: 'done', detail: `「${selection.label}」を選択しました` };
  }
  return { status: 'error', detail: 'option 選択は select 要素のみ対応します' };
}

function isExtractionGesture(event) {
  return extractionMode || Boolean(event.altKey || event.getModifierState?.('Alt'));
}

function isConditionalGesture() {
  return conditionalMode;
}

function interceptExtractionGesture(event) {
  if (!recordingEnabled) return;
  if (isConditionalGesture()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    lastConditionalPointer = { element: extractionElement(event.target), at: Date.now() };
    recordConditionalClick(event.target);
    return;
  }
  if (!isExtractionGesture(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  lastExtractionPointer = { element: extractionElement(event.target), at: Date.now() };
  recordExtraction(event.target);
}

// Capture before the browser turns an Alt/Option click into link navigation or
// download behavior. The click listener below remains as a fallback for pages
// that do not dispatch pointer events (and for keyboard-assisted test harnesses).
document.addEventListener('pointerdown', interceptExtractionGesture, true);
document.addEventListener(
  'click',
  (event) => {
    if (!recordingEnabled) return;
    if (isConditionalGesture()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = extractionElement(event.target);
      const duplicate =
        lastConditionalPointer &&
        lastConditionalPointer.element === element &&
        Date.now() - lastConditionalPointer.at < 1000;
      lastConditionalPointer = null;
      if (!duplicate) recordConditionalClick(event.target);
      return;
    }
    if (isExtractionGesture(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = extractionElement(event.target);
      const duplicate =
        lastExtractionPointer &&
        lastExtractionPointer.element === element &&
        Date.now() - lastExtractionPointer.at < 1000;
      lastExtractionPointer = null;
      if (!duplicate) recordExtraction(event.target);
      return;
    }
    const control = interactiveControl(event.target);
    if (isToggle(control)) {
      return;
    }
    if (isCustomToggle(control)) {
      queueMicrotask(() => recordCustomToggle(control));
      return;
    }
    if (control instanceof HTMLSelectElement) return;
    const target = describeTarget(event.target);
    if (!target) return;
    record({
      op: 'click_ref',
      summary: `${target.name || target.role} を選択`,
      target,
    });
  },
  true
);

function recordExtraction(candidate) {
  const element = extractionElement(candidate);
  if (!element) return;
  if (!snapshotHash) {
    void observePage().then(() => recordExtraction(candidate));
    return;
  }
  const role = roleOf(element);
  const name = accessibleName(element);
  const domPath = structuralPath(element);
  if (!domPath || domPath.length > 600) return;
  const label = safeText(name || element.innerText || role)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  const target = {
    ref: semanticRef(element, role, name),
    role,
    name: name || role,
    snapshot_hash: snapshotHash,
    dom_path: domPath,
  };
  flashExtractionTarget(element);
  record(
    {
      op: 'extract_text_ref',
      summary: `「${label || role}」のテキストを抽出`,
      target,
    },
    `extract:${domPath}`
  );
}

function recordConditionalClick(candidate) {
  const target = describeTarget(candidate);
  if (!target) return;
  const label = safeText(target.name || target.role)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  const element = extractionElement(candidate);
  if (element) flashConditionalTarget(element);
  record(
    {
      op: 'click_if_present',
      summary: `「${label || target.role}」が表示されていればクリック`,
      target,
    },
    `conditional-click:${target.dom_path || target.ref}`
  );
}

function extractionElement(candidate) {
  if (!(candidate instanceof Element)) return null;
  let element = candidate;
  while (element && !(element instanceof HTMLElement)) element = element.parentElement;
  return element instanceof HTMLElement ? element : null;
}

// Brief visual confirmation that Alt+click registered the extraction region.
function flashExtractionTarget(element) {
  const previous = element.style.outline;
  element.style.outline = '3px solid #dc7b34';
  setTimeout(() => {
    element.style.outline = previous;
  }, 800);
}

function flashConditionalTarget(element) {
  const previous = element.style.outline;
  element.style.outline = '3px solid #3b82f6';
  setTimeout(() => {
    element.style.outline = previous;
  }, 800);
}

document.addEventListener('input', handleFieldEvent, true);
document.addEventListener('change', handleFieldEvent, true);

function handleFieldEvent(event) {
  if (!recordingEnabled) return;
  const element = event.target;
  const isFormControl =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;
  const isEditable = element instanceof HTMLElement && element.isContentEditable;
  if (!isFormControl && !isEditable) return;
  if (isFormControl && isToggle(element)) {
    recordSelection(element);
    return;
  }
  const target = describeTarget(element);
  if (!target) return;
  if (isFormControl && isSensitiveInput(element)) {
    record(
      {
        op: 'sensitive_input_omitted',
        summary: `${target.name || '秘密入力'} は記録から除外しました`,
        target,
      },
      `sensitive:${target.ref}`
    );
    return;
  }
  if (element instanceof HTMLSelectElement) {
    const option = element.selectedOptions[0];
    const label = safeText(option?.label || option?.textContent || '選択項目');
    record(
      {
        op: 'select_ref',
        summary: `${target.name || target.role} を「${label}」に設定`,
        target,
        selection: { kind: 'option', label },
      },
      `select:${target.ref}:${label}`
    );
    return;
  }
  record(
    {
      op: 'fill_ref',
      summary: `${target.name || target.role} を入力（値は保存しない）`,
      target,
      variable: {
        name: variableName(element, target),
        classification: 'user_input',
      },
    },
    `fill:${target.ref}`
  );
}

document.addEventListener(
  'submit',
  (event) => {
    if (!recordingEnabled) return;
    const target = describeTarget(event.target);
    if (!target) return;
    record({
      op: 'submit_form',
      summary: `${target.name || 'フォーム'} を送信`,
      target,
    });
  },
  true
);

async function observePage() {
  snapshotHash = await sha256(
    JSON.stringify({
      origin: location.origin,
      path: location.pathname,
      title: document.title,
      elements: interactiveElements().map((element) => ({
        role: roleOf(element),
        name: accessibleName(element),
      })),
    })
  );
  return {
    url: location.href,
    title: document.title,
    origin: location.origin,
    elementCount: interactiveElements().length,
    snapshotHash,
  };
}

function interactiveElements() {
  return [
    ...document.querySelectorAll(
      'a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'
    ),
  ].filter((element) => element instanceof HTMLElement && isVisible(element));
}

function describeTarget(candidate) {
  if (!(candidate instanceof Element)) return null;
  const element = candidate.closest(
    'a, button, input, textarea, select, form, [role], [contenteditable="true"]'
  );
  if (!(element instanceof HTMLElement) || !isVisible(element)) return null;
  const role = roleOf(element);
  const name = accessibleName(element);
  if (!snapshotHash) return null;
  const target = {
    ref: semanticRef(element, role, name),
    role,
    name: name || role,
    snapshot_hash: snapshotHash,
  };
  // Structural anchor: lets replay fall back to "the element in the same slot"
  // when the accessible name is volatile (news headlines, timestamps, counters).
  const domPath = structuralPath(element);
  if (domPath && domPath.length <= 600) target.dom_path = domPath;
  return target;
}

// Shortest structural CSS path from a stable ancestor (nearest sane id, else
// body) using :nth-of-type steps. Content-independent by construction.
function structuralPath(element) {
  const parts = [];
  let node = element;
  while (node instanceof Element && parts.length < 14) {
    if (node !== element && node.id && safeStructuralId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      parts.unshift(tag);
      break;
    }
    let selector = tag;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(selector);
    node = parent;
  }
  return parts.join(' > ');
}

function safeStructuralId(value) {
  return (
    /^[A-Za-z][\w-]*$/.test(value) && !/\d{12,}/.test(value) && !/(?:\+?\d[\d -]{8,}\d)/.test(value)
  );
}

function roleOf(element) {
  if (element.getAttribute('role')) return element.getAttribute('role');
  if (element instanceof HTMLElement && element.isContentEditable) return 'textbox';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLAnchorElement) return 'link';
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLInputElement) {
    if (['checkbox', 'radio'].includes(element.type)) return element.type;
    if (['submit', 'button', 'reset'].includes(element.type)) return 'button';
    return 'textbox';
  }
  if (element instanceof HTMLFormElement) return 'form';
  return element.tagName.toLowerCase();
}

function accessibleName(element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return safeText(ariaLabel);
  const labelledby = element.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => element.ownerDocument?.getElementById(id)?.textContent || '')
      .filter(Boolean)
      .join(' ');
    if (text) return safeText(text);
  }
  // Editable fields (incl. contenteditable) must never derive their name from
  // their own editable content — that would leak the value the user typed.
  if (isEditableField(element)) {
    const label =
      element.labels?.[0]?.textContent ||
      element.getAttribute('name') ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title');
    return safeText(label || '');
  }
  // Only leaf controls (buttons, links, options…) may take their name from their
  // own text. Containers like <form> or [role=region] would otherwise pull the
  // entire visible subtree — page body, other people's data — into the name.
  if (isLeafControl(element)) {
    return safeText(element.innerText || element.textContent || '');
  }
  return safeText(element.getAttribute('name') || element.getAttribute('title') || '');
}

function isLeafControl(element) {
  const role = element.getAttribute('role');
  if (role)
    return ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(
      role
    );
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLInputElement ||
    element.tagName === 'SUMMARY'
  );
}

function isEditableField(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function safeText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\d[ -]?){13,16}\b/g, '[redacted-card]')
    .replace(/(?:\+?\d{1,3}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{2,4}[-\s]?\d{3,4}\b/g, '[redacted-phone]')
    .replace(/〒?\s?\d{3}-\d{4}\b/g, '[redacted-postal]')
    .replace(/\b\d{12,}\b/g, '[redacted-number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Popup sentinel (armed during Pattern B execution)
// ---------------------------------------------------------------------------

function armPopupSentinel() {
  if (sentinelObserver) return;
  sentinelObserver = new MutationObserver((mutations) => {
    if (!executionSentinelActive) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!isModalNode(node)) continue;
        const heading = node.querySelector?.('[role="heading"], h1, h2');
        const title = safeText(
          node.getAttribute?.('aria-label') || heading?.textContent || node.tagName || ''
        );
        const reason = isMfaNode(node) ? 'mfa' : 'new_popup';
        chrome.runtime
          .sendMessage({ type: 'bridge:execution-interrupted', reason, detail: title })
          .catch(() => undefined);
        return;
      }
    }
  });
  sentinelObserver.observe(document.body, { childList: true, subtree: true });
}

function disarmPopupSentinel() {
  sentinelObserver?.disconnect();
  sentinelObserver = null;
}

function isModalNode(el) {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || '';
  return (
    tag === 'dialog' ||
    role === 'dialog' ||
    role === 'alertdialog' ||
    el.getAttribute('aria-modal') === 'true'
  );
}

function isMfaNode(el) {
  if (!(el instanceof HTMLElement)) return false;
  return /mfa|otp|二段階|authenticat|ワンタイム|passkey|パスキー|webauthn|生体認証/i.test(
    el.textContent || ''
  );
}

function semanticRef(element, role, name) {
  const siblings = interactiveElements().filter(
    (candidate) => roleOf(candidate) === role && accessibleName(candidate) === name
  );
  const index = Math.max(0, siblings.indexOf(element)) + 1;
  return `@${tokenFor(role)}_${shortHash(name)}_${index}`;
}

function tokenFor(value) {
  const token = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || 'element';
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function variableName(element, target) {
  const raw = element.getAttribute('name') || element.id || target.name || 'input';
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
  return /^[a-z]/.test(normalized) ? normalized || 'input' : `input_${normalized || 'value'}`;
}

function isSensitiveInput(element) {
  const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
  const hint =
    `${element.getAttribute('name') || ''} ${element.id || ''} ${element.getAttribute('autocomplete') || ''}`.toLowerCase();
  return (
    ['password', 'hidden'].includes(type) ||
    /password|passcode|otp|one-time|token|secret|credit|card|cc-/.test(hint)
  );
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return (
    style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
  );
}

function interactiveControl(candidate) {
  if (!(candidate instanceof Element)) return null;
  const control = candidate.closest(
    'input, textarea, select, [role="checkbox"], [role="radio"], [role="switch"]'
  );
  return control instanceof HTMLElement ? control : null;
}

function isToggle(element) {
  return element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
}

function isCustomToggle(element) {
  return (
    element instanceof HTMLElement &&
    ['checkbox', 'radio', 'switch'].includes(element.getAttribute('role') || '')
  );
}

function recordSelection(element) {
  const target = describeTarget(element);
  if (!target) return;
  const checked = Boolean(element.checked);
  const label = checked ? '有効' : '無効';
  record(
    {
      op: 'select_ref',
      summary: `${target.name || target.role} を${label}に設定`,
      target,
      selection: { kind: 'toggle', checked },
    },
    `toggle:${target.ref}:${checked}`
  );
}

function recordCustomToggle(element) {
  const target = describeTarget(element);
  if (!target) return;
  const checked = element.getAttribute('aria-checked') === 'true';
  record(
    {
      op: 'select_ref',
      summary: `${target.name || target.role} を${checked ? '有効' : '無効'}に設定`,
      target,
      selection: { kind: 'toggle', checked },
    },
    `toggle:${target.ref}:${checked}`
  );
}

function record(event, dedupeKey) {
  if (dedupeKey) {
    if (recordedFieldStates.has(dedupeKey)) return;
    recordedFieldStates.add(dedupeKey);
  }
  chrome.runtime.sendMessage({ type: 'bridge:record-event', event }).catch(() => undefined);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
