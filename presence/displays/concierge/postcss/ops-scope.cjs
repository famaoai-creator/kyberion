/**
 * Scope the operations console stylesheets (`src/app/ops/**`,
 * `src/components/ops/**`, the former Chronos surface) to the `.kb-ops`
 * content frame, so loading `/ops` never restyles the rest of Concierge —
 * including after a client-side navigation away from `/ops`, when Next keeps
 * the stylesheet in the document.
 *
 * Rules:
 *   - `:root` / `html` / `body` / `:host` become the frame itself;
 *   - document-state prefixes (`:root[data-theme=…]`, `[data-theme=…]`,
 *     `[data-kds-style=…]`) stay on the document and scope the frame below;
 *   - every other selector gets the frame as its ancestor.
 * The frame is wrapped in `:where()`, so specificity — and therefore the
 * cascade between Tailwind utilities and the console rules — is unchanged.
 * Other stylesheets pass through untouched.
 */
const SCOPE = ':where(.kb-ops)';
const SCOPED_PATH = /[\\/]src[\\/](app|components)[\\/]ops[\\/]/;
const ROOT_COMPOUND =
  /^(:root|html|body|:host)(?![\w-])((?:\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))*)/;
const DOCUMENT_STATE = /^(\[data-(?:theme|kds-style)[^\]]*\](?:\[[^\]]*\])*)/;

function scopeSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.startsWith(SCOPE)) return trimmed;
  const root = trimmed.match(ROOT_COMPOUND);
  if (root) {
    const rest = trimmed.slice(root[0].length);
    const state = root[2] ? ':root' + root[2] + ' ' : '';
    return state + SCOPE + rest;
  }
  const documentState = trimmed.match(DOCUMENT_STATE);
  if (documentState) {
    return documentState[1] + ' ' + SCOPE + trimmed.slice(documentState[1].length);
  }
  return SCOPE + ' ' + trimmed;
}

function insideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return true;
  }
  return false;
}

const opsScope = () => ({
  postcssPlugin: 'kyberion-ops-scope',
  Once(root) {
    const file = root.source && root.source.input && root.source.input.file;
    if (!file || !SCOPED_PATH.test(file)) return;
    root.walkRules((rule) => {
      if (insideKeyframes(rule)) return;
      rule.selectors = rule.selectors.map(scopeSelector);
    });
  },
});
opsScope.postcss = true;
opsScope.scopeSelector = scopeSelector;

module.exports = opsScope;
