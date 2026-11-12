import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import {
  APPROVAL_DOMAIN_PREFIXES,
  APPROVAL_DOMAINS,
  APPROVAL_SURFACES,
  approvalChannelResolution,
} from '@agent/core/foundation/approval-domains';
import { SURFACE_ASYNC_CHANNELS } from '@agent/core/surface/channel-surface-types';

/**
 * Approval channel boundary — the gate that closes the free-form channel
 * vocabulary (P2, twin of the authorization-registry boundary test).
 *
 * `createApprovalRequest` accepts `channel` (routing/surface label) and
 * `storageChannel` (store partition). Both are syntax-checked only, so
 * subsystems coin names freely. Every value used at a production call site
 * must resolve to a declared domain or surface in
 * `libs/core/foundation/approval-domains.ts`:
 *
 *   - literal values     `channel: 'inbox'`                → declared
 *   - local constants    `channel: FOO_CHANNEL`            → const resolves to a declared value
 *   - imported constants `channel: VIDEO_APPROVAL_CHANNEL` → resolved via imports/re-exports
 *   - template families  `channel: `pipeline-execution-${slug}`` → declared prefix
 *   - dynamic values     `channel: params.channel`         → must be allowlisted below
 *
 * The whole repository is scanned (minus build/test/vendor dirs) so a call
 * site in an unlisted root cannot slip the gate. Comments and string bodies
 * are masked before call detection and argument-region slicing, so a
 * `createApprovalRequest(` inside a comment or an unbalanced `)` inside a
 * string cannot desynchronize the scan. Test files are exempt.
 */

const codeFileRe = /\.(ts|tsx|mts|cts)$/;
const testFileRe = /(\.test\.|\.spec\.|__tests__|\.live\.test\.)/;

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function isSkippableDir(relPath: string): boolean {
  return (
    relPath.includes('/node_modules/') ||
    relPath.startsWith('node_modules/') ||
    relPath.includes('/dist/') ||
    relPath.includes('/.worktrees/') ||
    relPath.startsWith('.worktrees/') ||
    relPath.includes('/retired/') ||
    relPath.includes('/.git/') ||
    relPath.startsWith('tests/') ||
    relPath.startsWith('active/') ||
    relPath.startsWith('knowledge/')
  );
}

function readSource(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

// --- tokenizer-lite -------------------------------------------------------
// Produces a same-length mask: comments, string bodies and template bodies
// are blanked to spaces; real code is preserved. Used to detect call sites,
// to find the balanced end of each argument region, and to verify that a
// `channel` keyword found in raw text actually sits in code (not inside a
// comment or a string literal).

type Frame =
  | { type: 'code' | 'brace' | 'expr' }
  | { type: 'line' | 'block' }
  | { type: 'string'; quote: string }
  | { type: 'tpl' };

function maskNonCode(src: string): string {
  const out = src.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  const stack: Frame[] = [{ type: 'code' }];
  const top = () => stack[stack.length - 1]!;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const n = src[i + 1];
    const frame = top();
    if (frame.type === 'line') {
      if (c === '\n') stack.pop();
      else blank(i);
      continue;
    }
    if (frame.type === 'block') {
      blank(i);
      if (c === '*' && n === '/') {
        blank(i + 1);
        i += 1;
        stack.pop();
      }
      continue;
    }
    if (frame.type === 'string') {
      blank(i);
      if (c === '\\') {
        blank(i + 1);
        i += 1;
      } else if (c === frame.quote) stack.pop();
      continue;
    }
    if (frame.type === 'tpl') {
      blank(i);
      if (c === '\\') {
        blank(i + 1);
        i += 1;
      } else if (c === '`') stack.pop();
      else if (c === '$' && n === '{') {
        blank(i + 1);
        i += 1;
        stack.push({ type: 'expr' });
      }
      continue;
    }
    // code / brace / expr — real code stays visible
    if (c === '/' && n === '/') {
      blank(i);
      blank(i + 1);
      i += 1;
      stack.push({ type: 'line' });
      continue;
    }
    if (c === '/' && n === '*') {
      blank(i);
      blank(i + 1);
      i += 1;
      stack.push({ type: 'block' });
      continue;
    }
    if (c === "'" || c === '"') {
      blank(i);
      stack.push({ type: 'string', quote: c });
      continue;
    }
    if (c === '`') {
      blank(i);
      stack.push({ type: 'tpl' });
      continue;
    }
    if (c === '{') stack.push({ type: 'brace' });
    else if (c === '}' && (frame.type === 'brace' || frame.type === 'expr')) stack.pop();
  }
  return out.join('');
}

/** `const|let|var X = 'lit'` / exported / template values visible in a file. */
function constValues(content: string): Map<string, string> {
  const table = new Map<string, string>();
  const litRe = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g;
  for (const match of content.matchAll(litRe)) table.set(match[1]!, match[2]!);
  const tplRe = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g;
  for (const match of content.matchAll(tplRe)) table.set(match[1]!, `\`${match[2]}\``);
  // Bare reassignments of a declared variable (`storageChannel = `tpl``)
  const bareRe = /^\s*([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/gm;
  for (const match of content.matchAll(bareRe)) table.set(match[1]!, `\`${match[2]}\``);
  return table;
}

/** Import specifier → repo-relative .ts path (relative `./x(.js)`, or the @agent/core package). */
function specifierToPath(fileRel: string, specifier: string): string | undefined {
  const asTs = (spec: string) =>
    /\.(ts|mts|cts)$/.test(spec) ? spec : `${spec.replace(/\.js$/, '')}.ts`;
  if (specifier.startsWith('.')) {
    return normalize(path.join(path.dirname(fileRel), asTs(specifier)));
  }
  // Joined so the package-boundary collector (a raw source-text regex for
  // '@agent/core' specifiers) doesn't count this comparison helper itself.
  const corePkg = '@agent' + '/core';
  if (specifier.startsWith(`${corePkg}/`)) {
    return normalize(`libs/core/${asTs(specifier.slice(corePkg.length + 1))}`);
  }
  if (specifier === corePkg) return 'libs/core/index.ts';
  return undefined;
}

/** Identifier → value resolution through the file's own consts and its imports/re-exports. */
function resolveIdentifier(fileRel: string, ident: string, seen: Set<string>): string | undefined {
  let content: string;
  try {
    content = readSource(fileRel);
  } catch {
    return undefined;
  }
  const local = constValues(content);
  if (local.has(ident)) return local.get(ident);
  const fromClauses = [
    ...content.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g),
    ...content.matchAll(/export\s*\{([^}]+)\}\s*from\s*'([^']+)'/g),
  ];
  for (const match of fromClauses) {
    const names = match[1]!
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim()
      )
      .filter(Boolean);
    if (!names.includes(ident)) continue;
    const importedRel = specifierToPath(fileRel, match[2]!);
    if (!importedRel || seen.has(importedRel)) continue;
    seen.add(importedRel);
    const resolved = resolveIdentifier(importedRel, ident, seen);
    if (resolved !== undefined) return resolved;
  }
  // `export * from './x'` — wildcard re-export: try every clause for the ident.
  for (const match of content.matchAll(/export\s*\*\s*from\s*'([^']+)'/g)) {
    const importedRel = specifierToPath(fileRel, match[1]!);
    if (!importedRel || seen.has(importedRel)) continue;
    seen.add(importedRel);
    const resolved = resolveIdentifier(importedRel, ident, seen);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

interface ChannelUse {
  file: string;
  kind: 'literal' | 'template' | 'expr';
  raw: string;
  resolved?: string;
}

/**
 * Dynamic channel expressions the static gate cannot evaluate — shrink-only:
 * every entry needs a comment pointing at why the value is runtime-derived,
 * and the gate fails on entries that no longer match a live call site.
 */
const dynamicChannelAllowlist: Readonly<Record<string, readonly string[]>> = {
  // Runtime pass-throughs: the wrapper forwards a caller-chosen channel; the
  // caller's own literal is gated at its call site (or measured at runtime).
  'libs/actuators/approval-actuator/src/approval-actuator-helpers.ts': [
    'params.channel',
    'params.storageChannel',
  ],
  'libs/actuators/approval-actuator/src/approval-ops.ts': ['channel'],
  'libs/core/pipeline/accepted-pipeline-bindings.ts': ['channel'],
  'libs/core/governance/approval-decision-routing.ts': ['deliveredVia'],
  'libs/core/governance/approval-gate.ts': ['channel'],
  'libs/core/governance/held-effect-request.ts': ['spec.channel', 'spec.storageChannel'],
  'libs/core/integrations/slack-approval-ui.ts': ['params.channel'],
  'libs/core/harnessing/lifecycle-hook-engine.ts': ['surface.channel', 'surface.storageChannel'],
  'libs/core/mesh/peer-runtime-recovery.ts': ['approvalChannel'],
  'libs/core/plugin/plugin-managed-install.ts': ['params.channel'],
  'libs/core/secret/secret-introduction.ts': ['channel'],
  'libs/core/surface/surface-approval-ui.ts': ['params.channel', 'params.surface'],
  'libs/core/surface/surface-mission-steering.ts': ['channel', 'params.key.surface'],
  'libs/core/workforce/background-review-patch.ts': ['input.approvalChannel.trim'],
  'scripts/pipeline-execution-part-execution.ts': ['suspended.storage_channel'],
};

/** The API definition file itself is not a call site. */
const definitionFile = 'libs/core/governance/approval-request-create.ts';
/** Type-annotation identifiers that look like expressions (`channel: string`). */
const typeWords = new Set(['string', 'number', 'boolean', 'unknown']);

/** Aliased imports: `import { createApprovalRequest as car }` renames the callee. */
function callNamePattern(masked: string): RegExp {
  const names = new Set<string>(['createApprovalRequest']);
  for (const match of masked.matchAll(/createApprovalRequest\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!);
  }
  return new RegExp(`\\b(?:${[...names].join('|')})\\s*\\(`, 'g');
}

function collectChannelUses(
  fileRel: string,
  content: string,
  masked: string,
  hitAllowlist: Set<string>
): ChannelUse[] {
  const uses: ChannelUse[] = [];
  for (const call of masked.matchAll(callNamePattern(masked))) {
    const openParen = call.index! + call[0].length - 1;
    // Balanced-depth region over the mask — parens inside comments/strings
    // were blanked, so depth counts real syntax only.
    let depth = 0;
    let close = masked.length;
    for (let i = openParen; i < masked.length; i += 1) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const region = content.slice(openParen + 1, close);
    const maskRegion = masked.slice(openParen + 1, close);
    // The `channel`/`storageChannel` keyword must sit in code — a keyword
    // inside a comment or string body is blank in the mask.
    const keywordIsCode = (index: number, keyword: string) =>
      maskRegion.slice(index, index + keyword.length) === keyword;
    // `channel: 'lit'` / `storageChannel: 'lit'` inside the call args
    for (const match of region.matchAll(/(?<![\w$.])(storageChannel|channel)\s*:\s*'([^']+)'/g)) {
      if (!keywordIsCode(match.index!, match[1]!)) continue;
      uses.push({ file: fileRel, kind: 'literal', raw: match[2]! });
    }
    // `channel: `tpl`` — static prefix must hit a declared prefix family
    for (const match of region.matchAll(/(?<![\w$.])(storageChannel|channel)\s*:\s*`([^`]*)`/g)) {
      if (!keywordIsCode(match.index!, match[1]!)) continue;
      uses.push({ file: fileRel, kind: 'template', raw: `\`${match[2]}\`` });
    }
    // `channel: IDENT` — resolve local/imported consts; else allowlisted dynamic expr
    for (const match of maskRegion.matchAll(
      /(?<![\w$.])(?:storageChannel|channel)\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g
    )) {
      const expr = match[1]!;
      if (expr === 'undefined' || typeWords.has(expr)) continue;
      const head = expr.split('.')[0]!;
      const resolved = resolveIdentifier(fileRel, head, new Set([fileRel]));
      if (resolved === undefined && (dynamicChannelAllowlist[fileRel] ?? []).includes(expr)) {
        hitAllowlist.add(`${fileRel}::${expr}`);
      }
      uses.push({ file: fileRel, kind: 'expr', raw: expr, resolved });
    }
    // shorthand `{ channel, }` / `{ storageChannel }` — same-file const lookup
    for (const match of maskRegion.matchAll(/[{,]\s*(storageChannel|channel)\s*[,}\n]/g)) {
      const ident = match[1]!;
      const resolved = resolveIdentifier(fileRel, ident, new Set([fileRel]));
      if (resolved === undefined && (dynamicChannelAllowlist[fileRel] ?? []).includes(ident)) {
        hitAllowlist.add(`${fileRel}::${ident}`);
      }
      uses.push({ file: fileRel, kind: 'expr', raw: ident, resolved });
    }
  }
  return uses;
}

function isDeclaredValue(raw: string): boolean {
  if (raw.startsWith('`')) {
    // Template: the static part before the first ${ must already contain a
    // declared prefix — a shorter static could grow into anything.
    const staticPrefix = raw.slice(1, -1).split('${')[0]!;
    return Object.keys(APPROVAL_DOMAIN_PREFIXES).some((prefix) => staticPrefix.startsWith(prefix));
  }
  return approvalChannelResolution(raw).declared;
}

describe('Approval channel boundary', () => {
  it('every channel/storageChannel value at production createApprovalRequest call sites is declared', () => {
    const offenders: string[] = [];
    const unresolved: string[] = [];
    const hitAllowlist = new Set<string>();
    let callSites = 0;
    for (const filePath of getAllFiles(rootDir)) {
      if (!codeFileRe.test(filePath) || filePath.endsWith('.d.ts')) continue;
      const relPath = normalize(path.relative(rootDir, filePath));
      if (testFileRe.test(relPath) || isSkippableDir(relPath) || relPath === definitionFile)
        continue;
      const content = readSource(relPath);
      if (!content.includes('createApprovalRequest')) continue;
      const masked = maskNonCode(content);
      const uses = collectChannelUses(relPath, content, masked, hitAllowlist);
      callSites += uses.length > 0 ? 1 : 0;
      for (const use of uses) {
        if (use.kind === 'expr' && use.resolved === undefined) {
          if (!hitAllowlist.has(`${relPath}::${use.raw}`)) {
            unresolved.push(`${relPath}: ${use.raw}`);
          }
          continue;
        }
        const value = use.resolved ?? use.raw;
        if (!isDeclaredValue(value)) {
          offenders.push(`${relPath}: ${use.raw} → ${value}`);
        }
      }
    }
    // The gate is non-vacuous: call sites exist, and every allowlist entry
    // still corresponds to a real unresolved expression at a live call site.
    expect(callSites).toBeGreaterThan(10);
    const dangling: string[] = [];
    for (const [file, exprs] of Object.entries(dynamicChannelAllowlist)) {
      for (const expr of exprs) {
        if (!hitAllowlist.has(`${file}::${expr}`)) dangling.push(`${file}: ${expr}`);
      }
    }
    offenders.sort();
    unresolved.sort();
    dangling.sort();
    expect({ undeclared: offenders, unresolved, danglingAllowlist: dangling }).toEqual({
      undeclared: [],
      unresolved: [],
      danglingAllowlist: [],
    });
  }, 60_000);

  it('keeps every async delivery surface inside the declared approval surfaces', () => {
    for (const surface of SURFACE_ASYNC_CHANNELS) {
      expect(
        Object.hasOwn(APPROVAL_SURFACES, surface),
        `SurfaceAsyncChannel '${surface}' missing from APPROVAL_SURFACES`
      ).toBe(true);
    }
    // Both directions pinned: the internal-only superset is fixed too, so a
    // surface added to either side without the other fails the gate.
    const internalOnly = Object.keys(APPROVAL_SURFACES)
      .filter((s) => !(SURFACE_ASYNC_CHANNELS as readonly string[]).includes(s))
      .sort();
    expect(internalOnly).toEqual([
      'apple-shortcuts',
      'autonomy',
      'brief',
      'concierge',
      'config-mission',
      'inbox',
      'operator',
      'system',
    ]);
  });

  it('classifies the inventory correctly (fail-safe + prefix families + surface fallback)', () => {
    expect(approvalChannelResolution('terminal')).toEqual({
      id: 'terminal',
      kind: 'domain',
      declared: true,
      via: 'exact',
    });
    expect(approvalChannelResolution('pipeline-execution-acme')).toEqual({
      id: 'pipeline-execution-acme',
      kind: 'domain',
      declared: true,
      via: 'prefix',
    });
    // The bare prefix alone is not a member of the dynamic family.
    expect(approvalChannelResolution('pipeline-execution-')).toEqual({
      id: 'pipeline-execution-',
      kind: 'domain',
      declared: false,
      via: 'fail-safe',
    });
    expect(approvalChannelResolution('imessage')).toEqual({
      id: 'imessage',
      kind: 'surface',
      declared: true,
      via: 'exact',
    });
    expect(approvalChannelResolution('made-up-channel')).toEqual({
      id: 'made-up-channel',
      kind: 'domain',
      declared: false,
      via: 'fail-safe',
    });
    expect(approvalChannelResolution('INVALID VALUE!')).toEqual({
      id: 'invalid value!',
      kind: 'domain',
      declared: false,
      via: 'fail-safe',
    });
  });

  it('declares the verified production domain inventory', () => {
    const required = [
      'terminal',
      'autonomy',
      'external-operation',
      'grant-standing',
      'mission-scope',
      'mission-reconciliation',
      'mission-task-supersede',
      'pipeline-await-state',
      'tenant-activation',
      'tenant-provider-attestation',
      'custody-provider-attestation',
      'nhi-session-admission',
      'onboarding-authority',
      'project-trust',
      'plugin-install',
      'chronos',
      'concierge',
      'peer-recovery',
      'service-recording-review',
      'background-review',
      'video-production',
      'agent-runtime',
      'brief',
      'config-mission',
      'personal-workbench',
      'apple-shortcuts',
      'operator',
      'slack',
      'inbox',
      'computer',
      'pipeline-binding',
      'mcp-approval',
    ];
    for (const domain of required) {
      expect(Object.hasOwn(APPROVAL_DOMAINS, domain), `missing domain '${domain}'`).toBe(true);
    }
    expect(Object.keys(APPROVAL_DOMAIN_PREFIXES)).toEqual(['pipeline-execution-']);
  });
});
