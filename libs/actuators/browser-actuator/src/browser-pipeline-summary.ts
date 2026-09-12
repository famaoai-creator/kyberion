export interface BrowserPipelineRefSummary {
  ref: string;
  tag?: string | null;
  name?: string | null;
  text?: string | null;
  href?: string | null;
}

export interface BrowserPipelineSummary {
  url: string | null;
  title: string | null;
  element_count: number;
  refs: BrowserPipelineRefSummary[];
  screenshot: string | null;
  last_url: string | null;
  failure_bundle_path?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Flat operator-facing summary so callers need not dig through `context`. */
export function buildBrowserPipelineSummary(ctx: Record<string, unknown>): BrowserPipelineSummary {
  const tabs = Array.isArray(ctx.browser_tabs) ? ctx.browser_tabs : [];
  const activeTab =
    tabs.find((tab) => asRecord(tab)?.active === true) ||
    tabs.find((tab) => asRecord(tab)?.tab_id === ctx.active_tab_id) ||
    tabs[0];
  const active = asRecord(activeTab);
  const snapshot = asRecord(ctx.last_snapshot);
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const url =
    (typeof active?.url === 'string' && active.url) ||
    (typeof ctx.last_url === 'string' && ctx.last_url) ||
    (typeof snapshot?.url === 'string' && snapshot.url) ||
    null;
  const title =
    (typeof active?.title === 'string' && active.title) ||
    (typeof snapshot?.title === 'string' && snapshot.title) ||
    null;
  const refs = elements.slice(0, 40).map((element) => {
    const row = asRecord(element) || {};
    return {
      ref: String(row.ref || ''),
      tag: typeof row.tag === 'string' ? row.tag : null,
      name: typeof row.name === 'string' ? row.name : null,
      text: typeof row.text === 'string' ? row.text.slice(0, 80) : null,
      href: typeof row.href === 'string' ? row.href : null,
    };
  });
  return {
    url,
    title,
    element_count:
      typeof snapshot?.element_count === 'number' ? snapshot.element_count : elements.length,
    refs: refs.filter((row) => row.ref),
    screenshot: typeof ctx.last_screenshot === 'string' ? ctx.last_screenshot : null,
    last_url: typeof ctx.last_url === 'string' ? ctx.last_url : url,
    ...(typeof ctx.failure_bundle_path === 'string'
      ? { failure_bundle_path: ctx.failure_bundle_path }
      : {}),
  };
}

export function refMapFromSnapshot(snapshot: unknown): Record<string, string> {
  const record = asRecord(snapshot);
  const elements = Array.isArray(record?.elements) ? record.elements : [];
  const map: Record<string, string> = {};
  for (const element of elements) {
    const row = asRecord(element);
    if (!row) continue;
    if (typeof row.ref === 'string' && typeof row.selector === 'string') {
      map[row.ref] = row.selector;
    }
  }
  return map;
}
