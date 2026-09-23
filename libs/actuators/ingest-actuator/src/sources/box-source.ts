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

export class BoxSourceWalker implements SourceWalker {
  readonly systemId = 'box';

  async walk(input: SourceWalkerInput): Promise<PageWalkResult> {
    const folderId = requireStringParam(input.source_params, 'folder_id', 'box');
    const items: SyncSourceItem[] = [];
    let highWater = '';
    let marker = '';
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        throw new Error(`ingest:sync_source — box pagination exceeded ${MAX_PAGES} pages`);
      }
      const page = asRecord(
        await input.transport(
          'box',
          'get_folder_items',
          {
            folder_id: folderId,
            query: {
              usemarker: true,
              limit: input.pageLimit,
              fields: 'id,type,name,etag,sha1,modified_at',
              ...(marker ? { marker } : {}),
            },
          },
          input.auth
        ),
        'box get_folder_items response'
      );
      pages += 1;
      const entries = asArray(page.entries, 'box get_folder_items entries');
      for (const raw of entries) {
        const entry = asRecord(raw, 'box folder entry');
        if (entry.type !== 'file') continue;
        const modifiedAt = typeof entry.modified_at === 'string' ? entry.modified_at : undefined;
        if (modifiedAt && !isNewerIso(modifiedAt, input.watermark)) continue;
        const id = String(entry.id ?? '');
        items.push({
          source_id: id,
          ...(entry.etag !== undefined ? { source_version: String(entry.etag) } : {}),
          content_ref: `box:file:${id}`,
          ...(modifiedAt ? { modified_at: modifiedAt } : {}),
        });
        highWater = maxIso(highWater, modifiedAt);
        if (items.length >= input.maxItems) {
          return { items, highWater, truncated: true, pages };
        }
      }
      const nextMarker = typeof page.next_marker === 'string' ? page.next_marker : '';
      if (!nextMarker) return { items, highWater, truncated: false, pages };
      if (nextMarker === marker) {
        throw new Error('ingest:sync_source — box pagination did not progress (fail-closed)');
      }
      marker = nextMarker;
    }
  }
}
