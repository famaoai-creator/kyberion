let recordingEnabled = false;
let snapshotHash = null;
const recordedFieldStates = new Set();

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
    if (recordingEnabled) {
      recordedFieldStates.clear();
      observePage();
    }
    sendResponse({ ok: true });
  }
});

document.addEventListener('click', (event) => {
  if (!recordingEnabled) return;
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
}, true);

document.addEventListener('input', handleFieldEvent, true);
document.addEventListener('change', handleFieldEvent, true);

function handleFieldEvent(event) {
  if (!recordingEnabled) return;
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
  if (isToggle(element)) {
    recordSelection(element);
    return;
  }
  const target = describeTarget(element);
  if (!target) return;
  if (isSensitiveInput(element)) {
    record({
      op: 'sensitive_input_omitted',
      summary: `${target.name || '秘密入力'} は記録から除外しました`,
      target,
    }, `sensitive:${target.ref}`);
    return;
  }
  if (element instanceof HTMLSelectElement) {
    const option = element.selectedOptions[0];
    const label = safeText(option?.label || option?.textContent || '選択項目');
    record({
      op: 'select_ref',
      summary: `${target.name || target.role} を「${label}」に設定`,
      target,
      selection: { kind: 'option', label },
    }, `select:${target.ref}:${label}`);
    return;
  }
  record({
    op: 'fill_ref',
    summary: `${target.name || target.role} を入力（値は保存しない）`,
    target,
    variable: {
      name: variableName(element, target),
      classification: 'user_input',
    },
  }, `fill:${target.ref}`);
}

document.addEventListener('submit', (event) => {
  if (!recordingEnabled) return;
  const target = describeTarget(event.target);
  if (!target) return;
  record({
    op: 'submit_form',
    summary: `${target.name || 'フォーム'} を送信`,
    target,
  });
}, true);

async function observePage() {
  snapshotHash = await sha256(JSON.stringify({
    origin: location.origin,
    path: location.pathname,
    title: document.title,
    elements: interactiveElements().map((element) => ({ role: roleOf(element), name: accessibleName(element) })),
  }));
  return {
    url: location.href,
    title: document.title,
    origin: location.origin,
    elementCount: interactiveElements().length,
    snapshotHash,
  };
}

function interactiveElements() {
  return [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]')]
    .filter((element) => element instanceof HTMLElement && isVisible(element));
}

function describeTarget(candidate) {
  if (!(candidate instanceof Element)) return null;
  const element = candidate.closest('a, button, input, textarea, select, form, [role], [contenteditable="true"]');
  if (!(element instanceof HTMLElement) || !isVisible(element)) return null;
  const role = roleOf(element);
  const name = accessibleName(element);
  if (!snapshotHash) return null;
  return {
    ref: semanticRef(element, role, name),
    role,
    name: name || role,
    snapshot_hash: snapshotHash,
  };
}

function roleOf(element) {
  if (element.getAttribute('role')) return element.getAttribute('role');
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
  const aria = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby');
  if (aria) return safeText(aria);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const label = element.labels?.[0]?.textContent || element.getAttribute('name') || element.getAttribute('placeholder');
    return safeText(label || '');
  }
  return safeText(element.innerText || element.textContent || '');
}

function safeText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{12,}\b/g, '[redacted-number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function semanticRef(element, role, name) {
  const siblings = interactiveElements().filter((candidate) => roleOf(candidate) === role && accessibleName(candidate) === name);
  const index = Math.max(0, siblings.indexOf(element)) + 1;
  return `@${tokenFor(role)}_${shortHash(name)}_${index}`;
}

function tokenFor(value) {
  const token = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
  const hint = `${element.getAttribute('name') || ''} ${element.id || ''} ${element.getAttribute('autocomplete') || ''}`.toLowerCase();
  return ['password', 'hidden'].includes(type)
    || /password|passcode|otp|one-time|token|secret|credit|card|cc-/.test(hint);
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
}

function interactiveControl(candidate) {
  if (!(candidate instanceof Element)) return null;
  const control = candidate.closest('input, textarea, select, [role="checkbox"], [role="radio"], [role="switch"]');
  return control instanceof HTMLElement ? control : null;
}

function isToggle(element) {
  return element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
}

function isCustomToggle(element) {
  return element instanceof HTMLElement && ['checkbox', 'radio', 'switch'].includes(element.getAttribute('role') || '');
}

function recordSelection(element) {
  const target = describeTarget(element);
  if (!target) return;
  const checked = Boolean(element.checked);
  const label = checked ? '有効' : '無効';
  record({
    op: 'select_ref',
    summary: `${target.name || target.role} を${label}に設定`,
    target,
    selection: { kind: 'toggle', checked },
  }, `toggle:${target.ref}:${checked}`);
}

function recordCustomToggle(element) {
  const target = describeTarget(element);
  if (!target) return;
  const checked = element.getAttribute('aria-checked') === 'true';
  record({
    op: 'select_ref',
    summary: `${target.name || target.role} を${checked ? '有効' : '無効'}に設定`,
    target,
    selection: { kind: 'toggle', checked },
  }, `toggle:${target.ref}:${checked}`);
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
