import type { InformationAssetCollector, CollectorSubject, CollectorCursor } from './provider.js';
import {
  CollectorFullSyncRequired,
  object,
  rows,
  text,
  optionalText,
  jsonObject,
} from './provider.js';

export const gmailHistoryCollector: InformationAssetCollector = {
  id: 'gmail.history',
  service_id: 'google-workspace',
  asset_types: ['customer.request'],
  actions: ['gmail_profile_get', 'gmail_messages_list', 'gmail_message_get', 'gmail_history_list'],
  async collect(location, cursor, call) {
    // Gmail does not apply search queries to history; refusing a query avoids silently broadening intake.
    if (location.selectors.query !== undefined)
      throw new Error('gmail_history_query_not_supported_use_label_id');
    const labelId = optionalText(location.selectors.label_id);
    const invoke = async (action: string, params: Record<string, unknown>) => {
      try {
        const response = object(await call(action, { params: { userId: 'me', ...params } }));
        if (response.error) {
          const failure = object(response.error);
          if (action === 'gmail_history_list' && failure.code === 404)
            throw new CollectorFullSyncRequired('gmail_history_expired_full_sync_required');
          throw new Error('collector_gmail_error_response');
        }
        return response;
      } catch (error) {
        const status =
          error && typeof error === 'object'
            ? ((error as { status?: unknown; statusCode?: unknown }).status ??
              (error as { statusCode?: unknown }).statusCode)
            : undefined;
        if (action === 'gmail_history_list' && (status === 404 || /\b404\b/.test(String(error))))
          throw new CollectorFullSyncRequired('gmail_history_expired_full_sync_required');
        throw error;
      }
    };
    let checkpoint = cursor.checkpoint;
    if (!checkpoint)
      checkpoint = text((await invoke('gmail_profile_get', {})).historyId, 'history_id');
    const initial = !cursor.checkpoint || cursor.phase === 'initial';
    const response = await invoke(initial ? 'gmail_messages_list' : 'gmail_history_list', {
      maxResults: 100,
      ...(initial
        ? labelId
          ? { labelIds: [labelId] }
          : {}
        : { startHistoryId: checkpoint, ...(labelId ? { labelId } : {}) }),
      ...(cursor.page_token ? { pageToken: cursor.page_token } : {}),
    });
    const subjects: CollectorSubject[] = [];
    const entries = initial
      ? rows(response.messages ?? []).map((message) => ({
          message,
          change: undefined as string | undefined,
          deleted: false,
        }))
      : rows(response.history ?? []).flatMap((history) => {
          const change = text(history.id, 'history_id');
          return ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'].flatMap(
            (kind) =>
              rows(history[kind] ?? []).map((entry) => ({
                message: object(entry.message),
                change: change + ':' + kind,
                deleted: kind === 'messagesDeleted',
              }))
          );
        });
    if (entries.length > 1000) throw new Error('collector_gmail_page_exceeded');
    for (const entry of entries) {
      const id = text(entry.message.id, 'message_id');
      const message = entry.deleted
        ? entry.message
        : await invoke('gmail_message_get', { id, format: 'full' });
      const historyId = entry.change ?? text(message.historyId, 'message_history_id');
      subjects.push({
        subject_id: id,
        change_id: historyId,
        event_type: entry.deleted ? 'message.deleted' : 'message.observed',
        source_url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(id),
        data: jsonObject({ ...message, deleted: entry.deleted }),
      });
    }
    const token = optionalText(response.nextPageToken);
    const next: CollectorCursor = token
      ? { checkpoint, page_token: token, phase: initial ? 'initial' : 'history' }
      : {
          checkpoint: initial ? checkpoint : text(response.historyId, 'history_id'),
          phase: 'history',
        };
    return { subjects, complete: !token, next };
  },
};

/** Snapshot pass for time-based follow-ups: mailbox history alone cannot emit an aging deadline. */
export const gmailFollowupCollector: InformationAssetCollector = {
  id: 'gmail.followups',
  service_id: 'google-workspace',
  asset_types: ['customer.request'],
  actions: ['gmail_messages_list', 'gmail_thread_get'],
  async collect(location, cursor, call, now = new Date()) {
    const threshold = location.selectors.reply_overdue_after_seconds ?? 172800;
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 60)
      throw new Error('collector_invalid_reply_overdue_seconds');
    const invoke = async (action: string, params: Record<string, unknown>) =>
      object(await call(action, { params: { userId: 'me', ...params } }));
    const response = await invoke('gmail_messages_list', {
      maxResults: 100,
      labelIds: ['SENT'],
      ...(typeof location.selectors.query === 'string' ? { q: location.selectors.query } : {}),
      ...(cursor.page_token ? { pageToken: cursor.page_token } : {}),
    });
    const messages = rows(response.messages ?? []);
    if (messages.length > 100) throw new Error('collector_gmail_page_exceeded');
    const subjects: CollectorSubject[] = [];
    const seenThreads = new Set<string>();
    for (const message of messages) {
      const threadId = text(message.threadId, 'thread_id');
      if (seenThreads.has(threadId)) continue;
      seenThreads.add(threadId);
      const thread = await invoke('gmail_thread_get', { id: threadId, format: 'full' });
      const threadMessages = rows(thread.messages);
      const ranked = threadMessages
        .map((item) => ({ item, at: Number(text(item.internalDate, 'internal_date')) }))
        .sort((a, b) => a.at - b.at);
      if (ranked.some((item) => !Number.isFinite(item.at)))
        throw new Error('collector_invalid_internal_date');
      const last = ranked.at(-1);
      if (!last) continue;
      const labels = last.item.labelIds;
      if (
        !Array.isArray(labels) ||
        !labels.includes('SENT') ||
        labels.includes('DRAFT') ||
        now.getTime() - last.at < threshold * 1000
      )
        continue;
      const id = text(last.item.id, 'message_id');
      const historyId = text(last.item.historyId, 'message_history_id');
      subjects.push({
        subject_id: id,
        change_id: historyId + ':overdue:' + threshold,
        event_type: 'message.overdue',
        occurred_at: new Date(last.at).toISOString(),
        source_url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(id),
        data: jsonObject({
          ...last.item,
          thread_id: threadId,
          reply_overdue: true,
          last_thread_message_id: id,
          reply_due_at: new Date(last.at + threshold * 1000).toISOString(),
        }),
      });
    }
    const token = optionalText(response.nextPageToken);
    return { subjects, complete: !token, next: token ? { page_token: token } : {} };
  },
};
