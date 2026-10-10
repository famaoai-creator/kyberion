---
category: Security
---

- **secure-io authorizes the file it actually opened** — reads, range and tail reads, appends, fsync, chmod, `safeStat` and `validateFileSize` now re-check the opened file's own location after `open` (from `/proc/self/fd` on Linux, otherwise by the inode at the re-derived canonical path), so a symlink flipped between the permission check and the open can no longer hand over a `knowledge/personal/` file. Range and tail reads open without following a final symlink. Cost: about +45 µs per read or stat; appends are unchanged.
- **Lock recovery reads only the record's own tomb** — when the lock record itself is refused as a hard link, `lock-utils` reads it through a `.stale-*` tomb only if that tomb is the same inode, checked before and after the read, so leftover tombs from older recoveries can no longer make a live lock look dead or block its release.
