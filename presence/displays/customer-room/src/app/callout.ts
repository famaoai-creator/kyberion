/**
 * The kit's callout (`kyberion-ui.css` `.kb-callout`) is a flex ROW — an
 * optional `.kb-callout__icon` beside a `.kb-callout__content` COLUMN. Text,
 * lists and buttons appended straight into `.kb-callout` become side-by-side
 * flex items and, at phone width, squeeze into narrow vertical columns. Every
 * callout of the room is built here: callers append into `content`, never
 * into `box`.
 */
export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface Callout<K extends 'section' | 'div'> {
  box: HTMLElementTagNameMap[K];
  content: HTMLDivElement;
}

export function createCallout<K extends 'section' | 'div'>(
  doc: Pick<Document, 'createElement'>,
  tag: K,
  className: string,
  tone: CalloutTone
): Callout<K> {
  const box = doc.createElement(tag);
  box.className = `kb-callout ${className}`.trim();
  box.setAttribute('data-tone', tone);
  const content = doc.createElement('div');
  content.className = 'kb-callout__content';
  box.appendChild(content);
  return { box, content };
}
