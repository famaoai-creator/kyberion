/**
 * local-git vcs backend — the governed default.
 *
 * The runner is the governed `safeExecResult` boundary itself: argv hygiene,
 * cwd-scope assertions and external-operation approval all live one layer up
 * in `libs/core/vcs/git.ts`, so selecting `local-git` reproduces the exact
 * pre-seam behaviour byte-for-byte. Importing this module installs
 * `local-git` on the vcs-backend seam.
 */

import { safeExecResult } from '../secure-io.js';
import { LOCAL_GIT_BACKEND_ID, registerVcsBackend, type VcsBackend } from './vcs-backend.js';

export const localGitBackend: VcsBackend = {
  id: LOCAL_GIT_BACKEND_ID,
  run: safeExecResult,
};

registerVcsBackend(localGitBackend, {
  provenance: 'builtin',
  source: 'libs/core/vcs/local-git-backend.ts',
});
