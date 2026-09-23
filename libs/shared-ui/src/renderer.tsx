'use client';

import { Fragment, type ReactNode } from 'react';
import type {
  KbAction,
  KyberionBaseComponentType,
  KyberionBasePropsByType,
} from '@agent/core/a2ui-catalog';
import { A2UIActionProvider, type A2UIActionHandler } from './actions.js';
import { resolveKbType } from './catalog.js';
import { Button, Disclosure } from './components/controls.js';
import { Metric, KeyValue, Table, List, Text } from './components/data.js';
import { Badge, Callout, EmptyState, Skeleton, StatusPill } from './components/feedback.js';
import { Grid, NextAction, Section, Stack } from './components/layout.js';
import { AppShell, NavRail, PageHeader, Tabs } from './components/shell.js';
import { KB_UI_MESSAGE_KEYS, KbI18nProvider, useKbI18n, type KbTranslate } from './i18n.js';

// Module-local: the package does not depend on @types/node, and bundlers
// replace `process.env.NODE_ENV` textually.
declare const process: { env: Record<string, string | undefined> };

/** One entry of an A2UI `updateComponents.components` list. */
export interface A2UIRendererComponent {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: readonly string[];
}

export interface A2UIFallbackRenderInput {
  id: string;
  type: string;
  props: Record<string, unknown>;
  /** Already-rendered child components, in `children` order. */
  children: ReactNode;
}

/** Renders a non-catalog type (e.g. chronos `display:*` / `kb-*`). */
export type A2UIFallbackRenderer = (input: A2UIFallbackRenderInput) => ReactNode;
export type A2UIFallbackRegistry = Readonly<Record<string, A2UIFallbackRenderer>>;

export interface A2UIRendererProps {
  components: readonly A2UIRendererComponent[];
  /** Render only this component's subtree. Default: every component no other component lists as a child. */
  rootId?: string;
  /** Renderers for types outside the `kyberion-base` catalog. Catalog types always win. */
  fallback?: A2UIFallbackRegistry;
  /** When given, wraps the tree in an `A2UIActionProvider`. */
  onAction?: A2UIActionHandler;
  /** Show a warning callout for unknown types. Default: on outside production builds. */
  showUnknown?: boolean;
  /**
   * Locale of `messages`. When `locale`, `messages` or `t` is given the tree
   * is wrapped in a `KbI18nProvider`; otherwise an enclosing provider (or the
   * generated English defaults) applies.
   */
  locale?: string;
  /** One locale's `ui:*` message bundle (`getUiMessageBundle(locale).messages`). */
  messages?: Readonly<Record<string, string>>;
  /** Custom lookup tried before `messages`. */
  t?: KbTranslate;
}

const MAX_DEPTH = 32;

function isProductionBuild(): boolean {
  try {
    return process.env.NODE_ENV === 'production';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function legacyAction(value: unknown): KbAction | undefined {
  if (typeof value === 'string' && value) return { id: value };
  if (isRecord(value) && typeof value.id === 'string') {
    return { id: value.id, payload: isRecord(value.payload) ? value.payload : undefined };
  }
  return undefined;
}

/**
 * Legacy protocol types (`text`, `button`, `card`, `container`) carry free-form
 * props; map the common historical keys onto the catalog props.
 */
function normalizeAliasProps(
  type: string,
  props: Record<string, unknown>
): Record<string, unknown> {
  switch (type) {
    case 'text':
      return {
        text: str(props.text, props.value, props.content, props.label) ?? '',
        variant: props.variant,
      };
    case 'button':
      return {
        label: str(props.label, props.text, props.value) ?? '',
        variant: props.variant,
        disabled: props.disabled === true,
        href: typeof props.href === 'string' ? props.href : undefined,
        action: legacyAction(props.action),
      };
    case 'card':
      return {
        title: str(props.title),
        description: str(props.description, props.subtitle),
        tone: props.tone,
      };
    case 'container':
      return {
        gap: props.gap,
        direction:
          props.direction === 'horizontal' || props.direction === 'row' ? 'horizontal' : undefined,
        align: props.align,
        wrap: props.wrap === true,
      };
    default:
      return props;
  }
}

function renderCatalog(
  type: KyberionBaseComponentType,
  rawProps: Record<string, unknown>,
  children: ReactNode,
  navChildren: ReactNode,
  mainChildren: ReactNode
): ReactNode {
  const p = rawProps as never;
  const props = <T extends KyberionBaseComponentType>(): KyberionBasePropsByType[T] => p;
  switch (type) {
    case 'ui:app-shell':
      return (
        <AppShell {...props<'ui:app-shell'>()} nav={navChildren}>
          {mainChildren}
        </AppShell>
      );
    case 'ui:page-header':
      return <PageHeader {...props<'ui:page-header'>()} />;
    case 'ui:nav-rail':
      return <NavRail {...props<'ui:nav-rail'>()} />;
    case 'ui:tabs':
      return <Tabs {...props<'ui:tabs'>()} />;
    case 'ui:stack':
      return <Stack {...props<'ui:stack'>()}>{children}</Stack>;
    case 'ui:grid':
      return <Grid {...props<'ui:grid'>()}>{children}</Grid>;
    case 'ui:section':
      return <Section {...props<'ui:section'>()}>{children}</Section>;
    case 'ui:next-action':
      return <NextAction {...props<'ui:next-action'>()} />;
    case 'ui:metric':
      return <Metric {...props<'ui:metric'>()} />;
    case 'ui:kv':
      return <KeyValue {...props<'ui:kv'>()} />;
    case 'ui:table':
      return <Table {...props<'ui:table'>()} />;
    case 'ui:list':
      return <List {...props<'ui:list'>()} />;
    case 'ui:text':
      return <Text {...props<'ui:text'>()} />;
    case 'ui:status-pill':
      return <StatusPill {...props<'ui:status-pill'>()} />;
    case 'ui:badge':
      return <Badge {...props<'ui:badge'>()} />;
    case 'ui:callout':
      return <Callout {...props<'ui:callout'>()}>{children}</Callout>;
    case 'ui:empty-state':
      return <EmptyState {...props<'ui:empty-state'>()} />;
    case 'ui:skeleton':
      return <Skeleton {...props<'ui:skeleton'>()} />;
    case 'ui:button':
      return <Button {...(p as { label: string })} />;
    case 'ui:disclosure':
      return <Disclosure {...props<'ui:disclosure'>()}>{children}</Disclosure>;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function UnknownComponent({ type }: { type: string }) {
  const { t } = useKbI18n();
  return (
    <div className="kb-callout" data-tone="warning" role="note" data-unknown-type={type}>
      <span className="kb-callout__icon" aria-hidden="true" />
      <div className="kb-callout__content">
        <p className="kb-callout__title">{t(KB_UI_MESSAGE_KEYS.unknownComponent, { type })}</p>
      </div>
    </div>
  );
}

/**
 * Render an A2UI `updateComponents` list with the `kyberion-base` catalog.
 * Children are resolved by id in `children` order; legacy aliases map onto
 * catalog types; other types go to `fallback`, else a dev-only warning.
 * Missing ids, cycles and trees deeper than 32 levels render nothing.
 */
export function A2UIRenderer({
  components,
  rootId,
  fallback,
  onAction,
  showUnknown,
  locale,
  messages,
  t,
}: A2UIRendererProps) {
  const list = Array.isArray(components)
    ? components.filter((c) => isRecord(c) && typeof c.id === 'string')
    : [];
  const byId = new Map<string, A2UIRendererComponent>();
  for (const component of list) if (!byId.has(component.id)) byId.set(component.id, component);
  const warnUnknown = showUnknown ?? !isProductionBuild();

  const renderNode = (id: string, ancestors: ReadonlySet<string>): ReactNode => {
    const component = byId.get(id);
    if (!component || ancestors.has(id) || ancestors.size >= MAX_DEPTH) return null;
    const path = new Set(ancestors).add(id);
    const childIds = Array.isArray(component.children)
      ? component.children.filter((child): child is string => typeof child === 'string')
      : [];
    const renderChildren = (ids: string[]) =>
      ids.map((childId, index) => (
        <Fragment key={`${childId}-${index}`}>{renderNode(childId, path)}</Fragment>
      ));
    const rawProps = isRecord(component.props) ? component.props : {};
    const type = String(component.type);
    const catalogType = resolveKbType(type);

    if (catalogType) {
      const props = catalogType === type ? rawProps : normalizeAliasProps(type, rawProps);
      if (catalogType === 'ui:app-shell') {
        const isNav = (childId: string) => {
          const child = byId.get(childId);
          return Boolean(child && resolveKbType(String(child.type)) === 'ui:nav-rail');
        };
        const nav = childIds.filter(isNav);
        const main = childIds.filter((childId) => !isNav(childId));
        return renderCatalog(
          catalogType,
          props,
          null,
          nav.length ? renderChildren(nav) : null,
          renderChildren(main)
        );
      }
      return renderCatalog(
        catalogType,
        props,
        childIds.length ? renderChildren(childIds) : null,
        null,
        null
      );
    }

    const custom =
      fallback && Object.prototype.hasOwnProperty.call(fallback, type) ? fallback[type] : undefined;
    if (custom) return custom({ id, type, props: rawProps, children: renderChildren(childIds) });
    return warnUnknown ? <UnknownComponent type={type} /> : null;
  };

  let roots: string[];
  if (rootId !== undefined) {
    roots = byId.has(rootId) ? [rootId] : [];
  } else {
    const referenced = new Set<string>();
    for (const component of list) {
      if (Array.isArray(component.children))
        for (const child of component.children) referenced.add(child);
    }
    roots = [...byId.keys()].filter((id) => !referenced.has(id));
  }

  const tree = roots.map((id) => <Fragment key={id}>{renderNode(id, new Set())}</Fragment>);
  const withActions = onAction ? (
    <A2UIActionProvider onAction={onAction}>{tree}</A2UIActionProvider>
  ) : (
    <>{tree}</>
  );
  return locale !== undefined || messages !== undefined || t !== undefined ? (
    <KbI18nProvider locale={locale} messages={messages} t={t}>
      {withActions}
    </KbI18nProvider>
  ) : (
    withActions
  );
}
