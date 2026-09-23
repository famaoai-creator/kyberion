import {
  asArray,
  asRecord,
  isNewerIso,
  maxIso,
  requireStringParam,
  MAX_PAGES,
  type PageWalkResult,
  type SourceWalker,
  type SourceWalkerInput,
  type SyncSourceItem,
} from './source-walker.js';

export function extractConfluenceCursor(nextLink: unknown): string {
  if (typeof nextLink !== 'string' || nextLink.trim() === '') return '';
  const match = /[?&]cursor=([^&]+)/.exec(nextLink);
  return match ? decodeURIComponent(match[1]) : '';
}

export class ConfluenceSourceWalker implements SourceWalker {
  readonly systemId = 'confluence';

  async walk(input: SourceWalkerInput): Promise<PageWalkResult> {
    requireStringParam(input.source_params, 'domain', 'confluence');
    const items: SyncSourceItem[] = [];
    let highWater = '';
    let cursor = '';
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        throw new Error(`ingest:sync_source — confluence pagination exceeded ${MAX_PAGES} pages`);
      }
      const domain = requireStringParam(input.source_params, 'domain', 'confluence');
      const page = asRecord(
        await input.transport(
          'confluence',
          'get_pages',
          {
            domain,
            query: {
              limit: input.pageLimit,
              ...(cursor ? { cursor } : {}),
            },
          },
          input.auth
        ),
        'confluence get_pages response'
      );
      pages += 1;
      const results = asArray(page.results, 'confluence get_pages results');
      for (const raw of results) {
        const entry = asRecord(raw, 'confluence page entry');
        const version =
          entry.version && typeof entry.version === 'object'
            ? (entry.version as Record<string, unknown>)
            : {};
        const modifiedAt = typeof version.createdAt === 'string' ? version.createdAt : undefined;
        if (modifiedAt && !isNewerIso(modifiedAt, input.watermark)) continue;
        const id = String(entry.id ?? '');
        items.push({
          source_id: id,
          ...(version.number !== undefined ? { source_version: String(version.number) } : {}),
          content_ref: `confluence:page:${id}`,
          ...(modifiedAt ? { modified_at: modifiedAt } : {}),
        });
        highWater = maxIso(highWater, modifiedAt);
        if (items.length >= input.maxItems) {
          return { items, highWater, truncated: true, pages };
        }
      }
      const links =
        page._links && typeof page._links === 'object'
          ? (page._links as Record<string, unknown>)
          : {};
      const nextCursor = extractConfluenceCursor(links.next);
      if (!nextCursor) return { items, highWater, truncated: false, pages };
      if (nextCursor === cursor) {
        throw new Error(
          'ingest:sync_source — confluence pagination did not progress (fail-closed)'
        );
      }
      cursor = nextCursor;
    }
  }
}
