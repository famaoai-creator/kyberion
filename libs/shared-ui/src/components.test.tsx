import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import {
  A2UIActionProvider,
  AppShell,
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  Grid,
  KeyValue,
  List,
  Metric,
  NavRail,
  NextAction,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  StatusPill,
  Table,
  Tabs,
  Text,
  safeHref,
} from './index.js';

const html = (element: ReactElement) => renderToStaticMarkup(element);

describe('kyberion-base React components emit the kyberion-ui.css class contract', () => {
  it('AppShell: root, density/role attrs, nav + main slots', () => {
    const out = html(
      <AppShell density="compact" theme="dark" role="chronos-mirror-v2" nav={<span>nav</span>}>
        <p>body</p>
      </AppShell>
    );
    expect(out).toMatch(
      /^<div class="kb-app-shell" data-density="compact" data-theme="dark" data-role="chronos-mirror-v2">/
    );
    expect(out).toContain('<div class="kb-app-shell__nav"><span>nav</span></div>');
    expect(out).toContain('<main class="kb-app-shell__main"><p>body</p></main>');
    // density/theme are set only when explicitly given (page-level wins otherwise).
    expect(html(<AppShell />)).not.toContain('data-density');
    expect(html(<AppShell density="comfortable" />)).toContain('data-density="comfortable"');
  });

  it('PageHeader: titles, role badge inside the title, actions', () => {
    const out = html(
      <PageHeader
        title="管制塔"
        subtitle="全体の状況"
        role_badge={{ label: '運用', role: 'chronos-mirror-v2' }}
        actions={[{ label: '更新', action: { id: 'refresh' } }]}
      />
    );
    expect(out).toMatch(/^<header class="kb-page-header">/);
    expect(out).toContain(
      '<div class="kb-page-header__titles"><h1 class="kb-page-header__title">管制塔<span class="kb-badge" data-role="chronos-mirror-v2">運用</span></h1>'
    );
    expect(out).toContain('<p class="kb-page-header__subtitle">全体の状況</p>');
    expect(out).toContain(
      '<div class="kb-page-header__actions"><button type="button" class="kb-btn kb-btn--secondary" data-action-id="refresh">更新</button></div>'
    );
  });

  it('NavRail: list, active item, hint, icon wrapper, footer', () => {
    const out = html(
      <NavRail
        label="メニュー"
        items={[
          {
            id: 'home',
            label: 'ホーム',
            hint: '今日のこと',
            href: '/',
            icon: 'home',
            active: true,
          },
          { id: 'x', label: '危険', href: 'javascript:alert(1)' },
        ]}
        footer_items={[{ id: 'help', label: 'ヘルプ', href: '/help' }]}
      />
    );
    expect(out).toMatch(
      /^<nav class="kb-nav-rail" aria-label="メニュー"><ul class="kb-nav-rail__list">/
    );
    expect(out).toContain(
      '<a href="/" class="kb-nav-rail__item" data-nav-id="home" aria-current="page" data-active="true"><span class="kb-nav-rail__icon" aria-hidden="true"><svg'
    );
    expect(out).toContain('<span class="kb-nav-rail__hint">今日のこと</span>');
    expect(out).toContain(
      '<div class="kb-nav-rail__footer"><ul class="kb-nav-rail__list"><li><a href="/help" class="kb-nav-rail__item" data-nav-id="help">'
    );
    expect(out).not.toContain('javascript:');
    // Unsafe href: a non-navigating span, never an `<a>` without a target.
    expect(out).toContain('<span class="kb-nav-rail__item" data-nav-id="x">');
  });

  it('Tabs: button tablist with aria-selected and counts; link bar with aria-current', () => {
    const buttons = html(
      <Tabs
        items={[
          { id: 'a', label: 'A', count: 3 },
          { id: 'b', label: 'B' },
        ]}
        active="a"
        overflow="menu"
      />
    );
    expect(buttons).toMatch(/^<div class="kb-tabs" data-overflow="menu" role="tablist">/);
    expect(buttons).toContain(
      '<button type="button" role="tab" class="kb-tabs__tab" data-tab-id="a" aria-selected="true">A<span class="kb-tabs__count">3</span></button>'
    );
    expect(buttons).toContain('aria-selected="false">B</button>');

    const links = html(
      <Tabs
        items={[
          { id: 'a', label: 'A', href: '/a' },
          { id: 'b', label: 'B', href: '/b' },
        ]}
        active="b"
      />
    );
    expect(links).toMatch(/^<nav class="kb-tabs" data-overflow="wrap">/);
    expect(links).toContain(
      '<a href="/b" class="kb-tabs__tab" data-tab-id="b" aria-current="page">B</a>'
    );
  });

  it('Stack and Grid: layout data attributes, invalid values dropped', () => {
    expect(
      html(
        <Stack gap="sm" direction="horizontal" align="center" wrap>
          <i />
        </Stack>
      )
    ).toBe(
      '<div class="kb-stack" data-gap="sm" data-direction="horizontal" data-align="center" data-wrap="true"><i></i></div>'
    );
    expect(html(<Grid gap="lg" columns={3} min_column_width="sm" />)).toBe(
      '<div class="kb-grid" data-gap="lg" data-columns="3" data-min-column-width="sm"></div>'
    );
    expect(html(<Grid columns={9} gap={'huge' as never} />)).toBe('<div class="kb-grid"></div>');
  });

  it('Section: header with heading block, actions and tone', () => {
    const out = html(
      <Section
        title="承認"
        description="判断が必要なもの"
        tone="warning"
        actions={[{ label: '全部見る', href: '/decide' }]}
      >
        <p>x</p>
      </Section>
    );
    expect(out).toMatch(
      /^<section class="kb-section" data-tone="warning"><header class="kb-section__header">/
    );
    expect(out).toContain(
      '<div class="kb-section__heading"><h2 class="kb-section__title">承認</h2><p class="kb-section__description">判断が必要なもの</p></div>'
    );
    expect(out).toContain(
      '<div class="kb-section__actions"><a href="/decide" class="kb-btn kb-btn--secondary">全部見る</a></div>'
    );
    expect(out).toContain('</header><p>x</p></section>');
    expect(html(<Section />)).toBe('<section class="kb-section"></section>');
  });

  it('NextAction: body, primary defaults to primary variant, loading hides actions', () => {
    const out = html(
      <NextAction
        eyebrow="次の一手"
        title="承認を 2 件確認する"
        reason="期限が今日です"
        primary={{ label: '確認する', href: '/decide' }}
        secondary={{ label: 'あとで', action: { id: 'later' } }}
      />
    );
    expect(out).toMatch(
      /^<section class="kb-next-action" data-state="ready"><div class="kb-next-action__body">/
    );
    expect(out).toContain(
      '<p class="kb-next-action__eyebrow">次の一手</p><h2 class="kb-next-action__title">承認を 2 件確認する</h2><p class="kb-next-action__reason">期限が今日です</p>'
    );
    expect(out).toContain(
      '<div class="kb-next-action__actions"><a href="/decide" class="kb-btn kb-btn--primary">確認する</a><button type="button" class="kb-btn kb-btn--secondary" data-action-id="later">あとで</button></div>'
    );

    const loading = html(
      <NextAction title="読み込み中" state="loading" primary={{ label: 'x', href: '/' }} />
    );
    expect(loading).toContain('data-state="loading" aria-busy="true"');
    expect(loading).not.toContain('kb-next-action__actions');
  });

  it('Metric: label/value/unit/delta/description with tone and trend', () => {
    const out = html(
      <Metric
        label="進行中"
        value={12}
        unit="件"
        delta="+3"
        trend="up"
        tone="success"
        description="先週比"
      />
    );
    expect(out).toMatch(/^<div class="kb-metric" data-tone="success" data-trend="up">/);
    expect(out).toContain(
      '<span class="kb-metric__label">進行中</span><span class="kb-metric__value">12<span class="kb-metric__unit">件</span></span>'
    );
    expect(out).toMatch(
      /<span class="kb-metric__delta"><svg[^>]*aria-hidden="true"[^>]*>.*<\/svg>\+3<\/span>/
    );
    expect(out).toContain('<span class="kb-metric__description">先週比</span>');
  });

  it('KeyValue: dl of label/value pairs with mono flag and formatted scalars', () => {
    expect(
      html(
        <KeyValue
          items={[
            { label: 'ID', value: 'MSN-1', mono: true },
            { label: '公開', value: false },
          ]}
        />
      )
    ).toBe(
      '<dl class="kb-kv"><dt class="kb-kv__label">ID</dt><dd class="kb-kv__value" data-mono="true">MSN-1</dd><dt class="kb-kv__label">公開</dt><dd class="kb-kv__value">いいえ</dd></dl>'
    );
  });

  it('Table: wrap, caption, aligned/mono cells, safe row hrefs only, empty row', () => {
    const out = html(
      <Table
        caption="ミッション"
        columns={[
          { key: 'id', label: 'ID', mono: true, width: '12rem' },
          { key: 'n', label: '件数', align: 'end', width: 'calc(1px);background:red' },
        ]}
        rows={[
          { id: 'A', n: 1, link: '/m/A' },
          { id: 'B', n: null, link: 'javascript:alert(1)' },
        ]}
        row_href_key="link"
      />
    );
    expect(out).toMatch(
      /^<div class="kb-table-wrap"><table class="kb-table"><caption>ミッション<\/caption>/
    );
    expect(out).toContain(
      '<th scope="col" style="width:12rem">ID</th><th scope="col" data-align="end">件数</th>'
    );
    expect(out).toContain(
      '<tr data-href="/m/A" tabindex="0"><td data-mono="true">A</td><td data-align="end">1</td></tr>'
    );
    expect(out).toContain('<tr><td data-mono="true">B</td><td data-align="end">—</td></tr>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('background');

    expect(html(<Table columns={[{ key: 'a', label: 'A' }]} rows={[]} empty="なし" />)).toContain(
      '<tbody><tr><td class="kb-table__empty" colSpan="1">なし</td></tr></tbody>'
    );
  });

  it('List: items, linked titles, meta, status pill, timeline variant', () => {
    const out = html(
      <List
        variant="timeline"
        items={[
          { title: '起票', meta: '09:00', href: '/m/1', status: 'completed' },
          { title: '危険', href: 'data:text/html,x' },
        ]}
      />
    );
    expect(out).toMatch(
      /^<ul class="kb-list" data-variant="timeline"><li class="kb-list__item" data-status="completed"><div class="kb-list__body">/
    );
    expect(out).toContain(
      '<a href="/m/1" class="kb-list__title">起票</a><span class="kb-list__meta">09:00</span></div><span class="kb-status-pill" data-status="completed">'
    );
    expect(out).toContain('<span class="kb-list__title">危険</span>');
    expect(out).not.toContain('data:text');
    expect(html(<List items={[]} />)).toBe('<ul class="kb-list" data-variant="plain"></ul>');
  });

  it('Text: variant modifier class', () => {
    expect(html(<Text text="補足" variant="caption" />)).toBe(
      '<p class="kb-text kb-text--caption">補足</p>'
    );
    expect(html(<Text text="本文" />)).toBe('<p class="kb-text kb-text--body">本文</p>');
  });

  it('StatusPill: status/domain attrs, aria-hidden icon, label span, Japanese default label, explicit label, domain wording', () => {
    expect(html(<StatusPill status="blocked" />)).toBe(
      '<span class="kb-status-pill" data-status="blocked"><span class="kb-status-pill__icon" aria-hidden="true"></span><span class="kb-status-pill__label">要対応</span></span>'
    );
    expect(html(<StatusPill status="blocked" domain="mission" />)).toContain(
      'data-domain="mission"><span class="kb-status-pill__icon" aria-hidden="true"></span><span class="kb-status-pill__label">停止中</span></span>'
    );
    expect(html(<StatusPill status="running" label="動作中" />)).toContain(
      '<span class="kb-status-pill__label">動作中</span>'
    );
    expect(html(<StatusPill status={'mystery' as never} />)).toContain(
      'data-status="mystery"><span class="kb-status-pill__icon"'
    );
  });

  it('Badge: tone and role attributes (unknown values dropped)', () => {
    expect(html(<Badge label="β" tone="accent" />)).toBe(
      '<span class="kb-badge" data-tone="accent">β</span>'
    );
    expect(html(<Badge label="秘書室" role="concierge" />)).toBe(
      '<span class="kb-badge" data-role="concierge">秘書室</span>'
    );
    expect(html(<Badge label="x" tone={'pink' as never} role={'evil' as never} />)).toBe(
      '<span class="kb-badge">x</span>'
    );
  });

  it('Callout: tone, aria-hidden icon, content/title/body/action', () => {
    const out = html(
      <Callout
        tone="danger"
        title="失敗しました"
        body="再実行してください"
        action={{ label: '再実行', action: { id: 'retry' } }}
      />
    );
    expect(out).toBe(
      '<div class="kb-callout" data-tone="danger" role="alert"><span class="kb-callout__icon" aria-hidden="true"></span><div class="kb-callout__content"><p class="kb-callout__title">失敗しました</p><p class="kb-callout__body">再実行してください</p><div class="kb-callout__action"><button type="button" class="kb-btn kb-btn--secondary" data-action-id="retry">再実行</button></div></div></div>'
    );
  });

  it('EmptyState: title/body/action (primary by default)', () => {
    expect(
      html(
        <EmptyState
          title="まだありません"
          body="最初の依頼をしてみましょう"
          action={{ label: '依頼する', href: '/ask' }}
        />
      )
    ).toBe(
      '<div class="kb-empty-state"><p class="kb-empty-state__title">まだありません</p><p class="kb-empty-state__body">最初の依頼をしてみましょう</p><div class="kb-empty-state__action"><a href="/ask" class="kb-btn kb-btn--primary">依頼する</a></div></div>'
    );
  });

  it('Skeleton: shape and clamped line count', () => {
    const out = html(<Skeleton shape="table" lines={2} />);
    expect(out).toBe(
      '<div class="kb-skeleton" data-shape="table" role="status" aria-busy="true" aria-label="読み込み中"><span class="kb-skeleton__line" aria-hidden="true"></span><span class="kb-skeleton__line" aria-hidden="true"></span></div>'
    );
    expect(html(<Skeleton lines={999} />).match(/kb-skeleton__line/g)).toHaveLength(12);
  });

  it('Button: variants, safe link, unsafe href dropped, disabled button', () => {
    expect(html(<Button label="開く" variant="primary" href="https://example.com/x" />)).toBe(
      '<a href="https://example.com/x" class="kb-btn kb-btn--primary">開く</a>'
    );
    const unsafe = html(<Button label="罠" href="javascript:alert(1)" />);
    expect(unsafe).toBe(
      '<a class="kb-btn kb-btn--secondary" aria-disabled="true" role="link" aria-label="罠">罠</a>'
    );
    expect(html(<Button label="削除" variant="danger" action={{ id: 'delete' }} disabled />)).toBe(
      '<button type="button" class="kb-btn kb-btn--danger" disabled="" data-action-id="delete">削除</button>'
    );
    expect(html(<Button label="x" variant={'neon' as never} action={{ id: 'a' }} />)).toContain(
      'kb-btn--secondary'
    );
  });

  it('Button: routes internal links through the provider link component', () => {
    const Link = ({
      href,
      className,
      children,
    }: {
      href: string;
      className?: string;
      children?: ReactNode;
    }) => (
      <a href={href} className={className} data-router="yes">
        {children}
      </a>
    );
    expect(
      html(
        <A2UIActionProvider linkComponent={Link}>
          <Button label="進捗" href="/progress" />
        </A2UIActionProvider>
      )
    ).toBe('<a href="/progress" class="kb-btn kb-btn--secondary" data-router="yes">進捗</a>');
  });

  it('Disclosure: details/summary/body and open flag', () => {
    expect(
      html(
        <Disclosure summary="開発者向け" open>
          <p>x</p>
        </Disclosure>
      )
    ).toBe(
      '<details class="kb-disclosure" open=""><summary>開発者向け</summary><div class="kb-disclosure__body"><p>x</p></div></details>'
    );
    expect(html(<Disclosure summary="s" />)).toBe(
      '<details class="kb-disclosure"><summary>s</summary><div class="kb-disclosure__body"></div></details>'
    );
  });
});

describe('safeHref', () => {
  it.each([
    ['/missions/1', '/missions/1'],
    ['./x', './x'],
    ['../x', '../x'],
    ['#top', '#top'],
    ['?tab=a', '?tab=a'],
    ['missions/1', 'missions/1'],
    ['https://example.com', 'https://example.com'],
    ['http://127.0.0.1:3050/', 'http://127.0.0.1:3050/'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
  ])('keeps %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:msgbox',
    'file:///etc/passwd',
    '//evil.example',
    '/\\evil.example',
    '',
    undefined,
    42,
  ])('drops %s', (input) => {
    expect(safeHref(input)).toBeUndefined();
  });
});
