import path from 'node:path';

/** One traversal contract for compiled and build-free discovery. */
export function scanActuatorManifests({ rootDir, actuatorsDir, io, loadManifest }) {
  const actuators = [];
  const errors = [];
  let safeActuatorsDir;
  try {
    safeActuatorsDir = io.assertSafePath(actuatorsDir, {
      allowMissingLeaf: true,
      rootDir,
    });
  } catch (error) {
    return {
      actuators,
      errors: ['unsafe actuator directory ' + actuatorsDir + ': ' + (error?.message || error)],
    };
  }

  if (!io.exists(safeActuatorsDir)) {
    return { actuators, errors: ['missing ' + actuatorsDir] };
  }

  for (const item of io.readdir(safeActuatorsDir).sort()) {
    const directory = path.join(safeActuatorsDir, item);
    let safeDirectory;
    let directoryStat;
    try {
      safeDirectory = io.assertSafePath(directory, { rootDir });
      directoryStat = io.lstat(safeDirectory);
    } catch {
      continue;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;

    let manifestPath;
    try {
      manifestPath = io.assertSafePath(path.join(safeDirectory, 'manifest.json'), { rootDir });
    } catch {
      continue;
    }
    const manifestStat = io.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;

    try {
      actuators.push({ item, manifest: loadManifest(manifestPath) });
    } catch (error) {
      errors.push('Failed to parse manifest for ' + item + ': ' + (error?.message || error));
    }
  }

  actuators.sort((left, right) =>
    String(left.manifest.actuator_id || left.item).localeCompare(
      String(right.manifest.actuator_id || right.item)
    )
  );
  return { actuators, errors };
}
