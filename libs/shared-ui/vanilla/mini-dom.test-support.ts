// Minimal DOM for the vanilla renderer tests (UI-04).
//
// The workspace's jsdom cannot load (the root `undici` override is older than
// jsdom 29 needs) and no happy-dom is installed, so the renderer tests run
// against this small, deliberately strict stand-in. It implements only what
// `kyberion-ui.js` uses — and makes `innerHTML` / `outerHTML` /
// `insertAdjacentHTML` throw, so any HTML-string path fails the tests.
//
// Selector support (`query` / `queryAll`): compound simple selectors
// (`tag`, `.class`, `[attr]`, `[attr="value"]`) joined by descendant (space)
// or child (`>`) combinators; a leading `>` means "direct child of the root".

type Listener = (event: { type: string; key?: string }) => void;

export class MiniNode {
  parentNode: MiniElement | MiniFragment | null = null;
  constructor(public readonly nodeType: number) {}
}

export class MiniText extends MiniNode {
  constructor(public data: string) {
    super(3);
  }
  get textContent(): string {
    return this.data;
  }
}

class ChildHost extends MiniNode {
  childNodes: MiniNode[] = [];
  get children(): MiniElement[] {
    return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
  }
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  appendChild<T extends MiniNode>(node: T): T {
    if (node instanceof MiniFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this as unknown as MiniElement;
    this.childNodes.push(node);
    return node;
  }
  removeChild<T extends MiniNode>(node: T): T {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    node.parentNode = null;
    return node;
  }
  get textContent(): string {
    return this.childNodes
      .map((n) => (n as unknown as { textContent: string }).textContent)
      .join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value !== '') this.appendChild(new MiniText(String(value)));
  }
  query(selector: string): MiniElement | null {
    return this.queryAll(selector)[0] ?? null;
  }
  queryAll(selector: string): MiniElement[] {
    const steps = parseSelector(selector);
    const out: MiniElement[] = [];
    const walk = (host: ChildHost) => {
      for (const child of host.children) {
        if (matchesChain(child, steps, steps.length - 1, this)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

export class MiniFragment extends ChildHost {
  constructor() {
    super(11);
  }
}

export class MiniElement extends ChildHost {
  readonly tagName: string;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {};
  disabled = false;
  open = false;
  tabIndex = -1;

  constructor(
    tag: string,
    public readonly namespaceURI: string = 'http://www.w3.org/1999/xhtml'
  ) {
    super(1);
    this.tagName = namespaceURI === 'http://www.w3.org/1999/xhtml' ? tag.toUpperCase() : tag;
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', String(value));
  }
  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...extra });
  }
  click(): void {
    if (!this.disabled) this.dispatch('click');
  }
  set innerHTML(_value: string) {
    throw new Error('mini-dom: innerHTML is forbidden in the renderer');
  }
  set outerHTML(_value: string) {
    throw new Error('mini-dom: outerHTML is forbidden in the renderer');
  }
  insertAdjacentHTML(): void {
    throw new Error('mini-dom: insertAdjacentHTML is forbidden in the renderer');
  }
}

export class MiniDocument {
  createElement(tag: string): MiniElement {
    return new MiniElement(tag);
  }
  createElementNS(ns: string, tag: string): MiniElement {
    return new MiniElement(tag, ns);
  }
  createTextNode(text: string): MiniText {
    return new MiniText(String(text));
  }
  createDocumentFragment(): MiniFragment {
    return new MiniFragment();
  }
}

// ---------------------------------------------------------------- selectors --

interface Compound {
  tag?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
  combinator: ' ' | '>';
}

function parseSelector(selector: string): Compound[] {
  const tokens = selector
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/)
    .filter(Boolean);
  const steps: Compound[] = [];
  let combinator: ' ' | '>' = ' ';
  for (const token of tokens) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    const compound: Compound = { classes: [], attrs: [], combinator };
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = re.exec(token))) {
      if (match.index !== consumed) break;
      consumed = re.lastIndex;
      if (match[1]) compound.tag = match[1].toUpperCase();
      else if (match[2]) compound.classes.push(match[2]);
      else compound.attrs.push({ name: match[3], value: match[4] });
    }
    if (consumed !== token.length) throw new Error(`mini-dom: unsupported selector ${token}`);
    steps.push(compound);
    combinator = ' ';
  }
  if (tokens[0] === '>') steps[0].combinator = '>';
  return steps;
}

function matchesCompound(el: MiniElement, c: Compound): boolean {
  if (c.tag && el.tagName.toUpperCase() !== c.tag) return false;
  if (!c.classes.every((name) => el.classList.contains(name))) return false;
  return c.attrs.every((a) =>
    a.value === undefined ? el.hasAttribute(a.name) : el.getAttribute(a.name) === a.value
  );
}

function matchesChain(el: MiniElement, steps: Compound[], index: number, root: ChildHost): boolean {
  if (!matchesCompound(el, steps[index])) return false;
  const combinator = steps[index].combinator;
  if (index === 0) {
    return combinator === '>' ? el.parentNode === root : true;
  }
  let parent = el.parentNode;
  while (parent && parent !== root && parent instanceof MiniElement) {
    if (matchesChain(parent, steps, index - 1, root)) return true;
    if (combinator === '>') return false;
    parent = parent.parentNode;
  }
  return false;
}
