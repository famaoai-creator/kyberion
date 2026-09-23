import {
  asArray,
  asRecord,
  isNewerIso,
  maxIso,
  MAX_PAGES,
  type PageWalkResult,
  type SourceWalker,
  type SourceWalkerInput,
  type SyncSourceItem,
} from './source-walker.js';

export class GoogleDriveSourceWalker implements SourceWalker {
  readonly systemId = 'google_drive';

  async walk(input: SourceWalkerInput): Promise<PageWalkResult> {
    const folderId =
      typeof input.source_params.folder_id === 'string' ? input.source_params.folder_id : undefined;
    const items: SyncSourceItem[] = [];
    let highWater = '';
    let pageToken = '';
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        throw new Error(`ingest:sync_source — google_drive pagination exceeded ${MAX_PAGES} pages`);
      }
      const queryParts = ['trashed = false', "mimeType != 'application/vnd.google-apps.folder'"];
      if (folderId) {
        queryParts.push(`'${folderId}' in parents`);
      }
      const page = asRecord(
        await input.transport(
          'google_drive',
          'list_files',
          {
            pageSize: input.pageLimit,
            q: queryParts.join(' and '),
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, version)',
            ...(pageToken ? { pageToken } : {}),
          },
          input.auth
        ),
        'google_drive list_files response'
      );
      pages += 1;
      const files = asArray(page.files, 'google_drive list_files files');
      for (const raw of files) {
        const file = asRecord(raw, 'google_drive file');
        const modifiedAt = typeof file.modifiedTime === 'string' ? file.modifiedTime : undefined;
        if (modifiedAt && !isNewerIso(modifiedAt, input.watermark)) continue;
        const id = String(file.id ?? '');
        items.push({
          source_id: id,
          ...(file.version !== undefined ? { source_version: String(file.version) } : {}),
          content_ref: `google_drive:file:${id}`,
          ...(modifiedAt ? { modified_at: modifiedAt } : {}),
        });
        highWater = maxIso(highWater, modifiedAt);
        if (items.length >= input.maxItems) {
          return { items, highWater, truncated: true, pages };
        }
      }
      const nextToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
      if (!nextToken) return { items, highWater, truncated: false, pages };
      if (nextToken === pageToken) {
        throw new Error(
          'ingest:sync_source — google_drive pagination did not progress (fail-closed)'
        );
      }
      pageToken = nextToken;
    }
  }
}
