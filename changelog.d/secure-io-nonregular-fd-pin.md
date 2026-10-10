---
category: Security
---

- **secure-io pins chmod and directory listings to the opened descriptor** — `safeChmodSync` now opens files and directories, re-checks the opened location and `fchmod`s it (other file types are refused), and `safeReaddir` lists the directory it actually opened and checked. A symlink flipped between the permission check and the operation can no longer change the mode of, or list, a `knowledge/personal/` file or directory.
- **No file creation through a dangling link; no hang on FIFOs** — appends create a missing file only with `O_CREAT|O_EXCL|O_NOFOLLOW` and remove it again if the check fails, so a dangling symlink can no longer plant empty files in a protected tree. In-place reads, range and tail reads and copies open non-blocking and refuse non-regular files, so a FIFO no longer hangs the caller.
- **Denial messages name only the caller's path** — secure-io no longer echoes the resolved location (or the tier-guard reason that embeds it) when it refuses access through a link.
