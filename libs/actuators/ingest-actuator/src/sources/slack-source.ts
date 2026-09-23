import {
  asArray,
  asRecord,
  requireStringParam,
  MAX_PAGES,
  type PageWalkResult,
  type SourceWalker,
  type SourceWalkerInput,
  type SyncSourceItem,
} from './source-walker.js';

function slackTsToIso(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) return undefined;
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

export class SlackSourceWalker implements SourceWalker {
  readonly systemId = 'slack';

  async walk(input: SourceWalkerInput): Promise<PageWalkResult> {
    const channel = requireStringParam(input.source_params, 'channel', 'slack');
    const items: SyncSourceItem[] = [];
    let highWaterTs = '';
    let cursor = '';
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        throw new Error(`ingest:sync_source — slack pagination exceeded ${MAX_PAGES} pages`);
      }
      const page = asRecord(
        await input.transport(
          'slack',
          'conversations_history',
          {
            query: {
              channel,
              limit: input.pageLimit,
              ...(input.watermark ? { oldest: input.watermark } : {}),
              ...(cursor ? { cursor } : {}),
            },
          },
          input.auth
        ),
        'slack conversations_history response'
      );
      pages += 1;
      if (page.ok === false) {
        throw new Error(
          `ingest:sync_source — slack conversations_history returned ok:false (${String(page.error ?? 'unknown error')})`
        );
      }
      const messages = asArray(page.messages, 'slack conversations_history messages');
      for (const raw of messages) {
        const message = asRecord(raw, 'slack message');
        const ts = String(message.ts ?? '');
        if (!ts) continue;
        const iso = slackTsToIso(ts);
        items.push({
          source_id: `${channel}:${ts}`,
          source_version: ts,
          content_ref: `slack:${channel}:${ts}`,
          ...(iso ? { modified_at: iso } : {}),
        });
        if (!highWaterTs || Number.parseFloat(ts) > Number.parseFloat(highWaterTs)) {
          highWaterTs = ts;
        }
        if (items.length >= input.maxItems) {
          return { items, highWater: highWaterTs, truncated: true, pages };
        }
      }
      const meta =
        page.response_metadata && typeof page.response_metadata === 'object'
          ? (page.response_metadata as Record<string, unknown>)
          : {};
      const nextCursor = typeof meta.next_cursor === 'string' ? meta.next_cursor : '';
      if (!nextCursor) return { items, highWater: highWaterTs, truncated: false, pages };
      if (nextCursor === cursor) {
        throw new Error('ingest:sync_source — slack pagination did not progress (fail-closed)');
      }
      cursor = nextCursor;
    }
  }
}
