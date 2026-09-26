/**
 * meeting-digest-format.ts — pure, deterministic rendering for the
 * ingest:meeting_digest op (no I/O, no clock, no model calls).
 *
 * The reasoning backend only ever produces a STRUCTURED summary
 * (MeetingDigestSummary); the fixed markdown shape — frontmatter key order,
 * section order, 「なし」 for empty sections, the review table — is owned by
 * this module so the output format cannot drift with the model.
 *
 * Tenant-specific values (title prefix, tags, target directory, source ids)
 * are never constants here: they arrive from the tenant's confidential job
 * config through the op.
 */

export interface MeetingDigestIncident {
  headline: string;
  details: string[];
}

export interface MeetingDigestReview {
  category: string;
  ticket: string;
  subject: string;
  result: string;
}

/** Structured output requested from the reasoning backend. */
export interface MeetingDigestSummary {
  /** ≤3 bullets. */
  gist: string[];
  /** One line for the index table. */
  one_line: string;
  incidents: MeetingDigestIncident[];
  reviews: MeetingDigestReview[];
  new_topics: string[];
  ongoing_topics: string[];
  decisions: string[];
  actions: string[];
  committee_candidates: string[];
}

export type MeetingDigestSummaryStatus = 'final' | 'provisional';

export interface MeetingDigestFrontmatter {
  title: string;
  tags: string[];
  last_updated: string;
  tenant_slug: string;
  meeting_date: string;
  source_system: string;
  source_page_id: string;
  source_title: string;
  source_url: string;
  source_version: string;
  source_last_modified: string;
  summary_status: MeetingDigestSummaryStatus;
}

export const NONE_JA = 'なし';
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Summary validation (model output is untrusted-derived: validate, never trust)
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`ingest:meeting_digest — ${message}`);
}

/** Collapse to one line and drop a leading markdown bullet the model may add. */
export function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/^\s*(?:[-*・]\s+)/, '')
    .trim();
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`summary.${field} must be an array`);
  return value
    .map(oneLine)
    .filter((entry) => entry.length > 0 && entry !== NONE_JA && entry !== `- ${NONE_JA}`);
}

export function validateMeetingDigestSummary(raw: unknown): MeetingDigestSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('summary must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const incidentsRaw = record.incidents ?? [];
  if (!Array.isArray(incidentsRaw)) fail('summary.incidents must be an array');
  const incidents: MeetingDigestIncident[] = incidentsRaw
    .map((entry) => {
      if (typeof entry === 'string') return { headline: oneLine(entry), details: [] };
      if (!entry || typeof entry !== 'object') fail('summary.incidents[] must be objects');
      const item = entry as Record<string, unknown>;
      return {
        headline: oneLine(item.headline),
        details: stringList(item.details, 'incidents[].details'),
      };
    })
    .filter((entry) => entry.headline.length > 0 && entry.headline !== NONE_JA);
  const reviewsRaw = record.reviews ?? [];
  if (!Array.isArray(reviewsRaw)) fail('summary.reviews must be an array');
  const reviews: MeetingDigestReview[] = reviewsRaw.map((entry) => {
    if (!entry || typeof entry !== 'object') fail('summary.reviews[] must be objects');
    const item = entry as Record<string, unknown>;
    return {
      category: oneLine(item.category),
      ticket: oneLine(item.ticket),
      subject: oneLine(item.subject),
      result: oneLine(item.result),
    };
  });
  const gist = stringList(record.gist, 'gist').slice(0, 3);
  if (gist.length === 0) fail('summary.gist must contain at least one bullet');
  const firstLine = oneLine(record.one_line) || gist[0];
  return {
    gist,
    one_line: firstLine,
    incidents,
    reviews: reviews.filter((r) => r.category || r.ticket || r.subject || r.result),
    new_topics: stringList(record.new_topics, 'new_topics'),
    ongoing_topics: stringList(record.ongoing_topics, 'ongoing_topics'),
    decisions: stringList(record.decisions, 'decisions'),
    actions: stringList(record.actions, 'actions'),
    committee_candidates: stringList(record.committee_candidates, 'committee_candidates'),
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Japanese weekday for a YYYY-MM-DD calendar date (timezone-free). */
export function weekdayJa(date: string): string {
  if (!DATE_RE.test(date)) fail(`invalid meeting date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * Meeting date from a page title such as `2026/9/24(木)：...`. Returns null
 * when the title carries no parseable, real calendar date.
 */
export function parseMeetingDateFromTitle(title: string): string | null {
  const match = /(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})/.exec(String(title || ''));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Calendar date (YYYY-MM-DD) of an instant in a fixed UTC offset (JST default). */
export function calendarDateAt(ms: number, offsetMinutes = 9 * 60): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(value) ? value : JSON.stringify(value);
}

/** Fixed key order — must match the hand-written backfill files. */
export function renderDigestFrontmatter(fm: MeetingDigestFrontmatter): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(fm.title)}`,
    `tags: [${fm.tags.map(yamlScalar).join(', ')}]`,
    `last_updated: ${fm.last_updated}`,
    `tenant_slug: ${yamlScalar(fm.tenant_slug)}`,
    `meeting_date: ${fm.meeting_date}`,
    `source_system: ${yamlScalar(fm.source_system)}`,
    `source_page_id: ${JSON.stringify(fm.source_page_id)}`,
    `source_title: ${JSON.stringify(fm.source_title)}`,
    `source_url: ${fm.source_url}`,
    `source_version: ${yamlScalar(fm.source_version)}`,
    `source_last_modified: ${fm.source_last_modified}`,
    `summary_status: ${fm.summary_status}`,
    '---',
  ];
  return lines.join('\n');
}

export interface ParsedMarkdownDoc {
  frontmatter: Record<string, string>;
  /** Raw `---…---` block, or null when the document has none. */
  frontmatter_block: string | null;
  body: string;
}

/** Minimal flat `key: value` frontmatter reader (quoted scalars unquoted). */
export function parseMarkdownDoc(markdown: string): ParsedMarkdownDoc {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, frontmatter_block: null, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, frontmatter_block: null, body: text };
  const closeEnd = text.indexOf('\n', end + 4);
  const block = text.slice(0, closeEnd < 0 ? text.length : closeEnd);
  const body = closeEnd < 0 ? '' : text.slice(closeEnd + 1);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split('\n').slice(1, -1)) {
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    frontmatter[match[1]] = value;
  }
  return { frontmatter, frontmatter_block: block, body };
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function tableCell(value: string): string {
  return oneLine(value).replace(/\|/g, '｜') || '記載なし';
}

function bulletSection(heading: string, items: string[]): string {
  const lines = items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${NONE_JA}`];
  return `## ${heading}\n${lines.join('\n')}`;
}

/** Blockquote under the H1 of a provisional digest (matches the backfill files). */
export const PROVISIONAL_NOTE = '> 暫定版。ページは編集中のため内容が変わる可能性がある。';
/** Suffix of a provisional digest's one-line index entry. */
export const PROVISIONAL_SUFFIX = '（暫定版）';

/** Drop the provisional blockquote(s) directly under the H1 (finalize without re-summarizing). */
export function stripProvisionalNote(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const h1 = lines.findIndex((line) => /^#\s/.test(line));
  if (h1 < 0) return body;
  let i = h1 + 1;
  while (i < lines.length && (lines[i].trim() === '' || /^>\s*.*暫定版/.test(lines[i]))) i += 1;
  const removed = lines.slice(h1 + 1, i).some((line) => /^>\s*.*暫定版/.test(line));
  if (!removed) return body;
  return [...lines.slice(0, h1 + 1), '', ...lines.slice(i)].join('\n');
}

export function renderDigestBody(
  summary: MeetingDigestSummary,
  options: { title_prefix: string; meeting_date: string; provisional?: boolean }
): string {
  const title = `# ${options.title_prefix} ${options.meeting_date}(${weekdayJa(options.meeting_date)})`;
  const heading = options.provisional ? `${title}\n\n${PROVISIONAL_NOTE}` : title;
  const incidents =
    summary.incidents.length > 0
      ? summary.incidents
          .map((incident) =>
            [`- ${incident.headline}`, ...incident.details.map((d) => `  - ${d}`)].join('\n')
          )
          .join('\n')
      : `- ${NONE_JA}`;
  const reviews =
    summary.reviews.length > 0
      ? [
          '| 区分 | チケット | 件名 | 結果 |',
          '| --- | --- | --- | --- |',
          ...summary.reviews.map(
            (r) =>
              `| ${tableCell(r.category)} | ${tableCell(r.ticket)} | ${tableCell(r.subject)} | ${tableCell(r.result)} |`
          ),
        ].join('\n')
      : `- ${NONE_JA}`;
  return [
    heading,
    bulletSection('要旨', summary.gist.slice(0, 3)),
    `## 新規インシデント\n${incidents}`,
    `## 申請審査\n${reviews}`,
    bulletSection('新規検討事項', summary.new_topics),
    bulletSection('継続検討事項', summary.ongoing_topics),
    bulletSection('決定事項', summary.decisions),
    bulletSection('アクション', summary.actions),
    bulletSection('委員会(月次)への上程候補', summary.committee_candidates),
  ].join('\n\n');
}

/**
 * Card layout ingest:commit understands: `${frontmatter}\n\n${body}\n` lets
 * the PII scrub and the SA-03 untrusted wrap act on the BODY only.
 */
export function composeCard(frontmatterBlock: string, body: string): string {
  return `${frontmatterBlock}\n\n${body.replace(/^\n+/, '').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Index README (## 継続中の論点 / ## 索引)
// ---------------------------------------------------------------------------

export interface MeetingIndexRow {
  date: string;
  one_line: string;
  incidents: string;
  /** Markdown for the file cell; derived from existing rows when omitted. */
  file?: string;
}

export const OPEN_ISSUES_HEADING = '継続中の論点';
export const INDEX_HEADING = '索引';
const INDEX_HEADER = '| 日付 | 要旨(一行) | インシデント | ファイル |';
const INDEX_SEPARATOR = '| --- | --- | --- | --- |';

export function incidentCell(summary: MeetingDigestSummary): string {
  if (summary.incidents.length === 0) return NONE_JA;
  const first = summary.incidents[0].headline;
  const short = first.length > 40 ? `${first.slice(0, 40)}…` : first;
  return summary.incidents.length > 1 ? `${short} ほか${summary.incidents.length - 1}件` : short;
}

interface Section {
  heading: string | null;
  lines: string[];
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [{ heading: null, lines: [] }];
  for (const line of body.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && !line.startsWith('###')) {
      sections.push({ heading: match[1], lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** One row of the 継続中の論点 table. */
export interface OpenIssue {
  topic: string;
  first_seen: string;
  latest: string;
}

const OPEN_ISSUES_HEADER = '| 論点 | 初出 | 最新状況 |';
const OPEN_ISSUES_SEPARATOR = '| --- | --- | --- |';

/** Rows of the 継続中の論点 table (bullet lists are read as topic-only rows). */
export function readOpenIssues(readme: string | null): OpenIssue[] {
  if (!readme) return [];
  const section = splitSections(parseMarkdownDoc(readme).body).find(
    (s) => s.heading === OPEN_ISSUES_HEADING
  );
  if (!section) return [];
  const issues: OpenIssue[] = [];
  for (const line of section.lines) {
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line);
      if (cells.length < 3 || /^:?-{3,}/.test(cells[0]) || cells[0] === '論点') continue;
      issues.push({ topic: cells[0], first_seen: cells[1], latest: cells.slice(2).join(' | ') });
    } else if (/^[-*]\s+/.test(line)) {
      const topic = oneLine(line);
      if (topic && topic !== NONE_JA) issues.push({ topic, first_seen: '', latest: '' });
    }
  }
  return issues;
}

/** Dates present in the 索引 table. */
export function readIndexDates(readme: string | null): string[] {
  if (!readme) return [];
  const section = splitSections(parseMarkdownDoc(readme).body).find(
    (s) => s.heading === INDEX_HEADING
  );
  if (!section) return [];
  return section.lines
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => splitRow(line)[0])
    .filter((cell) => DATE_RE.test(cell));
}

function deriveFileCell(date: string, existing: Map<string, string[]>): string {
  const own = existing.get(date);
  if (own && own[3]) return own[3];
  for (const [otherDate, cells] of existing) {
    if (cells[3] && cells[3].includes(otherDate)) return cells[3].split(otherDate).join(date);
  }
  return `[${date}.md](./${date}.md)`;
}

export interface UpdateIndexOptions {
  title_prefix: string;
  tags: string[];
  last_updated: string;
  rows: MeetingIndexRow[];
  /** Replaces the 継続中の論点 table when given; otherwise it is preserved. */
  open_issues?: OpenIssue[];
  /** Date the regenerated 継続中の論点 is as of (rewrites a `YYYY-MM-DD 時点` lead). */
  open_issues_as_of?: string;
  /** Rows whose provisional marker is dropped (finalized digests). */
  finalize_dates?: string[];
}

/**
 * Upsert index rows (newest first) and optionally regenerate 継続中の論点,
 * preserving every other line of an existing README.
 */
export function updateIndexReadme(existing: string | null, options: UpdateIndexOptions): string {
  const skeleton = [
    renderSimpleFrontmatter({
      title: `${options.title_prefix} 索引`,
      tags: options.tags,
      last_updated: options.last_updated,
    }),
    '',
    `# ${options.title_prefix} 索引`,
    '',
    `## ${OPEN_ISSUES_HEADING}`,
    `- ${NONE_JA}`,
    '',
    `## ${INDEX_HEADING}`,
    INDEX_HEADER,
    INDEX_SEPARATOR,
    '',
  ].join('\n');
  const source = existing && existing.trim() ? existing.replace(/\r\n/g, '\n') : skeleton;
  const doc = parseMarkdownDoc(source);
  const sections = splitSections(doc.body);

  // 継続中の論点
  let openSection = sections.find((s) => s.heading === OPEN_ISSUES_HEADING);
  if (!openSection) {
    openSection = { heading: OPEN_ISSUES_HEADING, lines: [`- ${NONE_JA}`, ''] };
    const indexPos = sections.findIndex((s) => s.heading === INDEX_HEADING);
    sections.splice(indexPos >= 0 ? indexPos : sections.length, 0, openSection);
  }
  if (options.open_issues) {
    const rows = options.open_issues
      .map((issue) => ({
        topic: oneLine(issue.topic),
        first_seen: oneLine(issue.first_seen),
        latest: oneLine(issue.latest),
      }))
      .filter((issue) => issue.topic && issue.topic !== NONE_JA);
    const prose = openSection.lines
      .filter(
        (line) =>
          line.trim() !== '' &&
          !line.trim().startsWith('|') &&
          !/^\s*[-*]\s+/.test(line) &&
          !/^\s{2,}\S/.test(line)
      )
      .map((line) =>
        options.open_issues_as_of
          ? line.replace(/^\d{4}-\d{2}-\d{2}(?=\s*時点)/, options.open_issues_as_of)
          : line
      );
    openSection.lines = [
      '',
      ...(prose.length > 0 ? [...prose, ''] : []),
      ...(rows.length > 0
        ? [
            OPEN_ISSUES_HEADER,
            OPEN_ISSUES_SEPARATOR,
            ...rows.map(
              (r) =>
                `| ${tableCell(r.topic)} | ${r.first_seen ? tableCell(r.first_seen) : '—'} | ${tableCell(r.latest)} |`
            ),
          ]
        : [`- ${NONE_JA}`]),
      '',
    ];
  }

  // 索引
  let indexSection = sections.find((s) => s.heading === INDEX_HEADING);
  if (!indexSection) {
    indexSection = { heading: INDEX_HEADING, lines: [INDEX_HEADER, INDEX_SEPARATOR, ''] };
    sections.push(indexSection);
  }
  const tableStart = indexSection.lines.findIndex((line) => line.trim().startsWith('|'));
  const before = tableStart >= 0 ? indexSection.lines.slice(0, tableStart) : [];
  let tableEnd = tableStart;
  if (tableStart >= 0) {
    while (
      tableEnd < indexSection.lines.length &&
      indexSection.lines[tableEnd].trim().startsWith('|')
    ) {
      tableEnd += 1;
    }
  }
  const tableLines = tableStart >= 0 ? indexSection.lines.slice(tableStart, tableEnd) : [];
  const after = tableStart >= 0 ? indexSection.lines.slice(tableEnd) : indexSection.lines;
  const header =
    tableLines[0] && !DATE_RE.test(splitRow(tableLines[0])[0]) ? tableLines[0] : INDEX_HEADER;
  const separator =
    tableLines[1] && /^\|?\s*:?-{3,}/.test(tableLines[1].trim()) ? tableLines[1] : INDEX_SEPARATOR;
  const rows = new Map<string, string[]>();
  const passthrough: string[] = [];
  for (const line of tableLines.slice(tableLines[0] === header ? 2 : 0)) {
    const cells = splitRow(line);
    if (DATE_RE.test(cells[0])) rows.set(cells[0], cells);
    else if (line !== header && line !== separator) passthrough.push(line);
  }
  for (const date of options.finalize_dates ?? []) {
    const cells = rows.get(date);
    if (cells && cells[1]) cells[1] = cells[1].split(PROVISIONAL_SUFFIX).join('').trim();
  }
  for (const row of options.rows) {
    const file = row.file ?? deriveFileCell(row.date, rows);
    rows.set(row.date, [row.date, tableCell(row.one_line), tableCell(row.incidents), file]);
  }
  const sortedRows = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([, cells]) => `| ${cells.join(' | ')} |`);
  const trailing = after.length > 0 ? after : [''];
  indexSection.lines = [
    ...before,
    header,
    separator,
    ...passthrough,
    ...sortedRows,
    ...(trailing[0]?.trim() === '' ? trailing : ['', ...trailing]),
  ];

  const body = sections
    .map((s) =>
      s.heading === null ? s.lines.join('\n') : [`## ${s.heading}`, ...s.lines].join('\n')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');

  let frontmatterBlock = doc.frontmatter_block;
  if (frontmatterBlock) {
    frontmatterBlock = /\nlast_updated:.*(?=\n)/.test(frontmatterBlock)
      ? frontmatterBlock.replace(
          /\nlast_updated:.*(?=\n)/,
          `\nlast_updated: ${options.last_updated}`
        )
      : frontmatterBlock.replace(/\n---$/, `\nlast_updated: ${options.last_updated}\n---`);
    return composeCard(frontmatterBlock, body);
  }
  return `${body.replace(/^\n+/, '')}\n`;
}

function renderSimpleFrontmatter(fm: {
  title: string;
  tags: string[];
  last_updated: string;
}): string {
  return [
    '---',
    `title: ${JSON.stringify(fm.title)}`,
    `tags: [${fm.tags.map(yamlScalar).join(', ')}]`,
    `last_updated: ${fm.last_updated}`,
    '---',
  ].join('\n');
}
