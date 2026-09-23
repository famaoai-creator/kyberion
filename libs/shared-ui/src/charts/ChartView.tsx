'use client';

import { createElement, type ReactNode } from 'react';
import { KB_CHART_TYPES, isChartType, layoutChart, type KbVNode } from '../../vanilla/charts.js';
import { statusLabel as statusLabelVanilla } from '../../vanilla/kyberion-ui.js';
import { useKbI18n } from '../i18n.js';

/**
 * UI-01b: React side of the chart / visualisation types. Geometry lives in
 * `libs/shared-ui/vanilla/charts.js` (`layoutChart` → virtual node tree);
 * this file only maps that tree to React elements, so the React and vanilla
 * renderers emit the same SVG by construction (`parity.test.tsx`).
 */

export type KbChartType =
  | 'ui:bar-chart'
  | 'ui:line-chart'
  | 'ui:donut'
  | 'ui:sparkline'
  | 'ui:heatmap'
  | 'ui:meter'
  | 'ui:sequence'
  | 'ui:flow'
  | 'ui:stat-list';

export const KB_CHART_COMPONENT_TYPES = KB_CHART_TYPES as readonly KbChartType[];

export function isKbChartType(type: string): type is KbChartType {
  return isChartType(type);
}

/** DOM attribute name → React prop name. */
const REACT_ATTR: Readonly<Record<string, string>> = {
  class: 'className',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  tabindex: 'tabIndex',
  viewBox: 'viewBox',
  focusable: 'focusable',
};

function reactPropName(name: string): string {
  if (Object.prototype.hasOwnProperty.call(REACT_ATTR, name)) return REACT_ATTR[name];
  if (name.startsWith('data-') || name.startsWith('aria-') || !name.includes('-')) return name;
  // SVG presentation attributes: `text-anchor` → `textAnchor`, ...
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * `svgRoot` (vanilla/charts.js) sets `style` as a plain CSS-text string (a
 * DOM attribute); React only accepts a property→value object. Declarations
 * here are simple (`--custom-prop:value`), so a `;`/`:` split is enough —
 * this never needs to parse arbitrary author CSS.
 */
function styleStringToObject(css: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (prop && value) style[prop] = value;
  }
  return style;
}

/** Map a chart vnode tree to React elements. */
export function renderVNode(node: KbVNode | null, key?: number): ReactNode {
  if (!node) return null;
  if ('text' in node) return node.text;
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.attrs)) {
    props[reactPropName(name)] = name === 'style' ? styleStringToObject(value) : value;
  }
  const children = node.children.map((child, index) => renderVNode(child, index));
  return createElement(node.tag, props, ...(children.length ? [children] : []));
}

export interface KbChartProps {
  type: KbChartType;
  props: Record<string, unknown>;
}

/** Render one chart / visualisation catalog component. */
export function KbChart({ type, props }: KbChartProps) {
  const { t, locale } = useKbI18n();
  const tree = layoutChart(type, props, {
    t,
    locale,
    statusLabel: (status: string) => statusLabelVanilla(status, undefined, undefined, t),
  });
  return <>{renderVNode(tree)}</>;
}
