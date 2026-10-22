/**
 * DOM adapter — the only seam between the renderer and a real document.
 *
 * The renderer never touches `document` directly. In the browser it gets the
 * adapter below; in tests it gets a fake that records a plain object tree.
 * No adapter exposes `innerHTML`: text always goes through text nodes, so a
 * producer can never inject markup through props.
 */

export interface DomAdapter<N> {
  create(tag: string, className?: string): N;
  setText(node: N, text: string): void;
  setAttribute(node: N, name: string, value: string): void;
  append(parent: N, child: N): void;
  clear(node: N): void;
  on(node: N, event: 'click' | 'submit' | 'change', handler: (event: unknown) => void): void;
}

/** Adapter over a real `Document`. */
export function createBrowserAdapter(doc: Document): DomAdapter<HTMLElement> {
  return {
    create(tag, className) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    },
    setText(node, text) {
      node.textContent = text;
    },
    setAttribute(node, name, value) {
      node.setAttribute(name, value);
    },
    append(parent, child) {
      parent.appendChild(child);
    },
    clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    on(node, event, handler) {
      node.addEventListener(event, handler);
    },
  };
}

/** Node shape recorded by the fake adapter (tests, snapshots, SSR-ish dumps). */
export interface FakeNode {
  tag: string;
  className: string;
  text: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  handlers: Record<string, Array<(event: unknown) => void>>;
}

/** Adapter that builds `FakeNode` trees; `fire(node, event)` runs handlers. */
export function createFakeAdapter(): DomAdapter<FakeNode> & {
  fire(node: FakeNode, event: string, payload?: unknown): void;
  textOf(node: FakeNode): string;
  find(node: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | null;
} {
  const textOf = (node: FakeNode): string =>
    [node.text, ...node.children.map(textOf)].filter(Boolean).join(' ');
  const find = (node: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | null => {
    if (predicate(node)) return node;
    for (const child of node.children) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  };
  return {
    create(tag, className) {
      return {
        tag,
        className: className ?? '',
        text: '',
        attributes: {},
        children: [],
        handlers: {},
      };
    },
    setText(node, text) {
      node.text = text;
    },
    setAttribute(node, name, value) {
      node.attributes[name] = value;
    },
    append(parent, child) {
      parent.children.push(child);
    },
    clear(node) {
      node.children = [];
      node.text = '';
    },
    on(node, event, handler) {
      (node.handlers[event] ??= []).push(handler);
    },
    fire(node, event, payload = { preventDefault() {} }) {
      for (const handler of node.handlers[event] ?? []) handler(payload);
    },
    textOf,
    find,
  };
}
