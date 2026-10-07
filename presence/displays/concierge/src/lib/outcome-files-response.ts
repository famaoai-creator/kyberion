/** Client-safe download wire contract. Only the server's exact same-origin route is trusted. */
export const OUTCOME_FILE_PAGE_SIZE = 10;
export const OUTCOME_FILE_LIMIT = 1024;
export type OutcomeFile =
  | {
      index: number;
      name: string;
      status: 'available';
      id: string;
      bytes: number;
      download_url: string;
    }
  | { index: number; name?: string; status: 'unavailable' | 'too_large' };
export interface OutcomeFilesPage {
  entry_id: string;
  total: number;
  offset: number;
  files: OutcomeFile[];
  next_cursor?: string;
}
export function outcomeDownloadUrl(entryId: string, fileId: string): string {
  return '/api/outcomes/' + encodeURIComponent(entryId) + '/files/' + fileId;
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function parseOutcomeFilesResponse(
  value: unknown,
  entryId: string
): OutcomeFilesPage | undefined {
  if (!record(value) || value.ok !== true || !record(value.files)) return undefined;
  const page = value.files;
  if (
    page.entry_id !== entryId ||
    !integer(page.total) ||
    page.total > OUTCOME_FILE_LIMIT ||
    !integer(page.offset) ||
    page.offset > page.total ||
    !Array.isArray(page.files) ||
    page.files.length > OUTCOME_FILE_PAGE_SIZE ||
    page.offset + page.files.length > page.total ||
    (page.next_cursor !== undefined &&
      (typeof page.next_cursor !== 'string' ||
        !/^[1-9][0-9]{0,3}\.[a-f0-9]{64}$/.test(page.next_cursor)))
  )
    return undefined;
  const files: OutcomeFile[] = [];
  for (const [position, candidate] of page.files.entries()) {
    if (
      !record(candidate) ||
      candidate.index !== page.offset + position ||
      (candidate.name !== undefined &&
        (typeof candidate.name !== 'string' ||
          !candidate.name ||
          candidate.name.length > 240 ||
          /[\\/\x00-\x1f\x7f]/.test(candidate.name)))
    )
      return undefined;
    if (candidate.status === 'available') {
      if (
        typeof candidate.name !== 'string' ||
        typeof candidate.id !== 'string' ||
        !/^[a-f0-9]{128}$/.test(candidate.id) ||
        !integer(candidate.bytes) ||
        candidate.bytes > 16 * 1024 * 1024 ||
        candidate.download_url !== outcomeDownloadUrl(entryId, candidate.id)
      )
        return undefined;
      files.push({
        index: candidate.index as number,
        name: candidate.name,
        status: 'available',
        id: candidate.id,
        bytes: candidate.bytes,
        download_url: candidate.download_url as string,
      });
    } else if (candidate.status === 'unavailable' || candidate.status === 'too_large') {
      if (candidate.id !== undefined || candidate.download_url !== undefined) return undefined;
      files.push({
        index: candidate.index as number,
        status: candidate.status,
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      });
    } else return undefined;
  }
  const hasMore = page.offset + files.length < page.total;
  if (hasMore !== (page.next_cursor !== undefined) || (hasMore && files.length === 0))
    return undefined;
  return {
    entry_id: entryId,
    total: page.total,
    offset: page.offset,
    files,
    ...(typeof page.next_cursor === 'string' ? { next_cursor: page.next_cursor } : {}),
  };
}
