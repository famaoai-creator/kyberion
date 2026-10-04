import { posix, win32 } from 'node:path';

/**
 * Create a PATH-backed binary probe. Filesystem access is injected so callers
 * can keep their own governed I/O boundary while sharing platform semantics.
 */
export function createBinaryAvailability({
  platform = process.platform,
  pathValue = process.env.PATH ?? '',
  pathDelimiter = platform === 'win32' ? ';' : ':',
  pathExt = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM',
  exists,
}) {
  if (typeof exists !== 'function') throw new TypeError('exists must be a function');

  const directories = pathValue.split(pathDelimiter).filter(Boolean);
  const extensions = platform === 'win32' ? pathExt.toLowerCase().split(';') : [''];
  const joinPath = platform === 'win32' ? win32.join : posix.join;
  const cache = new Map();

  return (binary) => {
    const cached = cache.get(binary);
    if (cached !== undefined) return cached;

    const lower = binary.toLowerCase();
    const variants =
      platform === 'win32' && extensions.some((extension) => lower.endsWith(extension))
        ? [binary]
        : extensions.map((extension) => binary + extension);
    const present = directories.some((directory) =>
      variants.some((name) => {
        try {
          return exists(joinPath(directory, name));
        } catch {
          return false;
        }
      })
    );
    cache.set(binary, present);
    return present;
  };
}
