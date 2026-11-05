import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Inbox approval link boundary.
 *
 * A link to one approval card in あなた待ち (`/inbox`) is built only by
 * `presence/displays/concierge/src/lib/inbox-links.ts` (`inboxHrefForApproval`),
 * so the `?request=` landing contract (`inboxLandingHash`) has one producer
 * and every value is URL-encoded. Concatenating `'/inbox?…request='` or the
 * `#decide-approval-<id>` anchor at a call site is a violation; the card
 * itself (`app/inbox/needs-you-card.tsx`) owns the anchor.
 */

const rootDir = process.cwd();
const CONCIERGE_SRC = 'presence/displays/concierge/src';

/** file → why it may build the link itself. */
const ALLOWLIST: Record<string, string> = {
  [`${CONCIERGE_SRC}/lib/inbox-links.ts`]: 'the one producer of approval deep links',
  [`${CONCIERGE_SRC}/app/inbox/needs-you-card.tsx`]:
    'owns the card anchor and resolves ?request= into it',
};

const VIOLATIONS: Array<{ name: string; re: RegExp }> = [
  { name: "'/inbox?…request=' literal", re: /['"`]\/inbox\?[^'"`\n]*request=/ },
  { name: 'decide-approval anchor', re: /['"`]#?decide-approval-/ },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('inbox approval link boundary', () => {
  it('builds approval deep links only through inbox-links', () => {
    const found: string[] = [];
    for (const absolute of getAllFiles(path.join(rootDir, CONCIERGE_SRC))) {
      const file = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (!/\.(ts|tsx)$/.test(file) || /\.test\.(ts|tsx)$/.test(file) || ALLOWLIST[file]) continue;
      const src = stripComments(safeReadFile(absolute, { encoding: 'utf8' }) as string);
      for (const { name, re } of VIOLATIONS) if (re.test(src)) found.push(`${file} (${name})`);
    }
    expect(
      found,
      `approval deep link built outside inbox-links — a second producer drifts from the ?request= landing contract | next: use inboxHrefForApproval() from lib/inbox-links (or add the file to ALLOWLIST with a reason) | evidence: ${found.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (file) => !safeExistsSync(path.join(rootDir, file))
    );
    expect(
      stale,
      `stale inbox link allowlist entry — the file no longer exists | next: remove it from ALLOWLIST | evidence: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
