/**
 * memory vcs-host provider — an in-process forge for hermetic tests and dry
 * runs. Never registered by default and never in the governed default chain;
 * tests register it explicitly (`registerVcsHostProvider`) or pass its id.
 */

import type { PrCheckEntry, PrListEntry } from './github.js';
import {
  MEMORY_VCS_HOST_ID,
  VcsHostError,
  type VcsHostProvider,
  type VcsPrCreateInput,
  type VcsPrMergeInput,
  type VcsPullRequestSnapshot,
  type VcsRepositoryRef,
  type VcsRepositoryVisibility,
} from './vcs-host.js';

export interface MemoryVcsHostState {
  repository: VcsRepositoryRef;
  defaultBranch: string;
  visibility: VcsRepositoryVisibility;
  /** Remote branch → commit sha. */
  branches: Record<string, string>;
  pulls: Array<
    VcsPullRequestSnapshot & {
      author?: string;
      checks?: PrCheckEntry[];
      /** Additional gh `--json` fields served by `prFields` (files, mergedAt, …). */
      fields?: Record<string, unknown>;
    }
  >;
  queued: number[];
  /** `githubApiGet` responses keyed by path under `repos/{slug}/`; absent → not_found. */
  api: Record<string, unknown>;
  authenticated: boolean;
}

export interface MemoryVcsHostProvider extends VcsHostProvider {
  readonly state: MemoryVcsHostState;
  readonly created: VcsPrCreateInput[];
  readonly merges: VcsPrMergeInput[];
  /** Mutate state the next time `prView`/`commitSha` is read (simulate a race). */
  onRead(hook: () => void): void;
}

export function createMemoryVcsHostProvider(
  initial: Partial<MemoryVcsHostState> & { id?: string } = {}
): MemoryVcsHostProvider {
  const state: MemoryVcsHostState = {
    repository: initial.repository ?? {
      slug: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      host: 'github.com',
    },
    defaultBranch: initial.defaultBranch ?? 'main',
    visibility: initial.visibility ?? 'private',
    branches: { ...(initial.branches ?? {}) },
    pulls: [...(initial.pulls ?? [])],
    queued: [...(initial.queued ?? [])],
    api: { ...(initial.api ?? {}) },
    authenticated: initial.authenticated ?? true,
  };
  const created: VcsPrCreateInput[] = [];
  const merges: VcsPrMergeInput[] = [];
  const hooks: Array<() => void> = [];
  const fire = () => hooks.splice(0).forEach((hook) => hook());
  const find = (ref: string) => {
    const number = /^\d+$/.test(ref) ? Number(ref) : Number(ref.match(/\/pull\/(\d+)$/)?.[1]);
    const pull = state.pulls.find((p) =>
      Number.isInteger(number) ? p.number === number : p.headRefName === ref
    );
    if (!pull) throw new VcsHostError('not_found', `no pull request ${ref}`);
    return pull;
  };
  const snapshotOf = ({
    author: _a,
    checks: _c,
    fields: _f,
    ...pull
  }: MemoryVcsHostState['pulls'][number]) => ({ ...pull }) as VcsPullRequestSnapshot;

  return {
    id: initial.id ?? MEMORY_VCS_HOST_ID,
    state,
    created,
    merges,
    onRead(hook) {
      hooks.push(hook);
    },
    isAvailable: () => true,
    async authStatus() {
      return { ok: state.authenticated };
    },
    async repository() {
      return { ...state.repository };
    },
    async defaultBranch() {
      return state.defaultBranch;
    },
    async visibility() {
      return state.visibility;
    },
    async commitSha(_ctx, _repo, ref) {
      fire();
      const sha = state.branches[ref];
      if (!sha) throw new VcsHostError('not_found', `no branch ${ref}`);
      return sha;
    },
    async prView(_ctx, _repo, ref) {
      fire();
      return snapshotOf(find(ref));
    },
    async prFields(_ctx, _repo, ref, fields) {
      fire();
      const pull = find(ref);
      const all: Record<string, unknown> = {
        ...snapshotOf(pull),
        author: { login: pull.author ?? '' },
        ...(pull.fields ?? {}),
      };
      return Object.fromEntries(fields.map((field) => [field, all[field] ?? null]));
    },
    async githubApiGet(_ctx, _repo, path) {
      if (!(path in state.api)) throw new VcsHostError('not_found', `no fixture for ${path}`);
      return structuredClone(state.api[path]);
    },
    async prList(_ctx, _repo, filter): Promise<PrListEntry[]> {
      return state.pulls
        .filter((p) => filter.state === 'all' || p.state === filter.state.toUpperCase())
        .filter((p) => !filter.head || p.headRefName === filter.head)
        .slice(0, filter.limit)
        .map((p) => ({
          number: p.number,
          title: p.title,
          headRefOid: p.headRefOid,
          headRefName: p.headRefName,
          isDraft: p.isDraft,
          author: { login: p.author },
          state: p.state,
        }));
    },
    async prChecks(_ctx, _repo, ref) {
      return [...(find(ref).checks ?? [])];
    },
    async prQueued(_ctx, _repo, number) {
      return state.queued.includes(number);
    },
    async prCreate(_ctx, repo, input) {
      created.push({ ...input });
      const number = Math.max(0, ...state.pulls.map((p) => p.number)) + 1;
      const url = `${repo.url}/pull/${number}`;
      state.pulls.push({
        number,
        url,
        headRefOid: state.branches[input.head] ?? '',
        baseRefOid: state.branches[input.base] ?? '',
        headRefName: input.head,
        baseRefName: input.base,
        state: 'OPEN',
        title: input.title,
        isDraft: input.draft,
      });
      return { number, url };
    },
    async prMerge(_ctx, _repo, input) {
      const pull = find(String(input.number));
      if (pull.headRefOid !== input.expectedHeadSha)
        throw new VcsHostError('stale_head', 'head moved');
      merges.push({ ...input });
      pull.state = 'MERGED';
      return { number: input.number, merged: true };
    },
  };
}
