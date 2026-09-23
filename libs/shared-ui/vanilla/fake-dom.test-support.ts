// Minimal DOM for mounting React components with `react-dom/client` in tests
// (UI-01c interaction tests). The workspace jsdom cannot load (see
// `vanilla/mini-dom.test-support.ts`), and `renderToStaticMarkup` runs no
// handlers, so this implements just what react-dom's commit phase and event
// system touch: node tree ops, attributes, a style object, listeners with
// capture/bubble dispatch, focus, and a tiny `querySelector`.
//
// `installFakeDom()` must run BEFORE `react-dom/client` is imported (it
// probes `window.document` at module load), so tests import it dynamically.

type Listener = { fn: (event: FakeEvent) => void; capture: boolean };

export interface FakeEvent {
  type: string;
  target: FakeNode;
  currentTarget: FakeNode | null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  timeStamp: number;
  isTrusted: boolean;
  eventPhase: number;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  [key: string]: unknown;
}

export class FakeNode {
  // `'on<event>' in node` feature probes (react-dom's isEventSupported).
  oninput: unknown = null;
  onchange: unknown = null;
  onclick: unknown = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  private listeners = new Map<string, Listener[]>();
  constructor(
    public readonly nodeType: number,
    public readonly nodeName: string,
    public ownerDocument: FakeDocument | null
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null);
  }
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild<T extends FakeNode>(node: T): T {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    node.parentNode = null;
    return node;
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(this.ownerDocument, String(value)));
  }
  addEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    options?: boolean | { capture?: boolean }
  ): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture))
    );
  }
  /** @internal */
  invoke(event: FakeEvent, capture: boolean): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (listener.capture !== capture) continue;
      event.currentTarget = this;
      listener.fn(event);
    }
  }
}

export class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public data: string
  ) {
    super(3, '#text', doc);
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(value: string) {
    this.data = String(value);
  }
}

export class FakeComment extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public data: string
  ) {
    super(8, '#comment', doc);
  }
  override get textContent(): string {
    return '';
  }
}

class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this[name] = value;
  }
  removeProperty(name: string): void {
    delete this[name];
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly localName: string;
  private attrs = new Map<string, string>();
  style = new FakeStyle();
  constructor(
    doc: FakeDocument | null,
    tag: string,
    public readonly namespaceURI: string = 'http://www.w3.org/1999/xhtml'
  ) {
    const html = namespaceURI === 'http://www.w3.org/1999/xhtml';
    super(1, html ? tag.toUpperCase() : tag, doc);
    this.tagName = html ? tag.toUpperCase() : tag;
    this.localName = tag.toLowerCase();
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', String(value));
  }
  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string): void {
    this.attrs.delete(name);
  }
  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }
  // Reflected attributes react-dom reads/writes as properties.
  get type(): string {
    return this.attrs.get('type') ?? (this.localName === 'input' ? 'text' : '');
  }
  set type(value: string) {
    this.attrs.set('type', String(value));
  }
  get name(): string {
    return this.attrs.get('name') ?? '';
  }
  set name(value: string) {
    this.attrs.set('name', String(value));
  }
  get disabled(): boolean {
    return this.attrs.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(value: string) {
    this.attrs.set('id', String(value));
  }
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument && this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = null;
  }
  /** Compound selectors joined by descendant (space) combinators, comma-separated. */
  querySelectorAll(selector: string): FakeElement[] {
    const alternatives = selector
      .split(',')
      .map((s) => s.trim().split(/\s+/).filter(Boolean).map(parseCompound));
    const out: FakeElement[] = [];
    const matchesChain = (el: FakeElement, chain: Compound[]): boolean => {
      if (!matches(el, chain[chain.length - 1])) return false;
      let index = chain.length - 2;
      for (let node = el.parentNode; node && node !== this && index >= 0; node = node.parentNode) {
        if (node instanceof FakeElement && matches(node, chain[index])) index -= 1;
      }
      return index < 0;
    };
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (alternatives.some((chain) => matchesChain(child, chain))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface Compound {
  tag?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
  notAttrs: string[];
}

function parseCompound(source: string): Compound {
  const compound: Compound = { classes: [], attrs: [], notAttrs: [] };
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|:not\(\[([\w-]+)\]\)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(source))) {
    if (match.index !== consumed) break;
    consumed = re.lastIndex;
    if (match[1]) compound.tag = match[1].toUpperCase();
    else if (match[2]) compound.classes.push(match[2]);
    else if (match[3]) compound.notAttrs.push(match[3]);
    else compound.attrs.push({ name: match[4], value: match[5] });
  }
  if (consumed !== source.length) throw new Error(`fake-dom: unsupported selector ${source}`);
  return compound;
}

function matches(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  const classes = el.className.split(/\s+/);
  if (!c.classes.every((name) => classes.includes(name))) return false;
  if (
    !c.attrs.every((a) =>
      a.value === undefined ? el.hasAttribute(a.name) : el.getAttribute(a.name) === a.value
    )
  )
    return false;
  // `:not([disabled])` — React reflects `disabled` as the DOM property.
  return c.notAttrs.every(
    (name) => !el.hasAttribute(name) && !(el as unknown as Record<string, unknown>)[name]
  );
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: unknown = null;
  constructor() {
    super(9, '#document', null);
    this.ownerDocument = null;
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElementNS(ns: string, tag: string): FakeElement {
    return new FakeElement(this, tag, ns);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(this, String(text));
  }
  createComment(text: string): FakeComment {
    return new FakeComment(this, String(text));
  }
}

/**
 * Dispatch an event like the browser does: capture from the document down to
 * the target, then bubble back up (react-dom listens on the root container).
 */
export function fireEvent(
  target: FakeNode,
  type: string,
  init: Record<string, unknown> = {}
): FakeEvent {
  let stopped = false;
  const event: FakeEvent = {
    type,
    target,
    currentTarget: null,
    bubbles: init.bubbles !== false,
    cancelable: true,
    defaultPrevented: false,
    timeStamp: Date.now(),
    isTrusted: true,
    eventPhase: 0,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    stopImmediatePropagation() {
      stopped = true;
    },
    ...init,
  };
  const path: FakeNode[] = [];
  for (let node: FakeNode | null = target; node; node = node.parentNode) path.push(node);
  for (const node of [...path].reverse()) {
    if (stopped) break;
    event.eventPhase = node === target ? 2 : 1;
    node.invoke(event, true);
  }
  for (const node of path) {
    if (stopped) break;
    if (node !== target && !event.bubbles) break;
    event.eventPhase = node === target ? 2 : 3;
    node.invoke(event, false);
  }
  return event;
}

/** Every attribute value and text node under `node` (what could leak into markup). */
export function serializeFake(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  const parts: string[] = [node.nodeName];
  if (node instanceof FakeElement)
    for (const name of node.getAttributeNames()) parts.push(`${name}=${node.getAttribute(name)}`);
  for (const child of node.childNodes) parts.push(serializeFake(child));
  return parts.join('|');
}

/** Install `window` / `document` globals; returns the document and a restore function. */
export function installFakeDom(extraWindow: Record<string, unknown> = {}) {
  const document = new FakeDocument();
  class HTMLIFrameElement {}
  const windowListeners = new FakeNode(0, '#window', null);
  const win: Record<string, unknown> = {
    document,
    HTMLIFrameElement,
    event: undefined,
    location: { href: 'http://localhost/', protocol: 'http:' },
    addEventListener: windowListeners.addEventListener.bind(windowListeners),
    removeEventListener: windowListeners.removeEventListener.bind(windowListeners),
    getSelection: () => null,
    ...extraWindow,
  };
  document.defaultView = win;
  const g = globalThis as Record<string, unknown>;
  const previous = { window: g.window, document: g.document, act: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = win;
  g.document = document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    document,
    window: win,
    windowEvents: windowListeners,
    restore() {
      g.window = previous.window;
      g.document = previous.document;
      g.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}
