/**
 * Registers every seam calibration adapter for the `seam:select` CLI.
 * Each seam keeps its adapter next to its own code; add one import + call here.
 */

let registered = false;

export function registerSeamCalibrationAdapters(): void {
  if (registered) return;
  registered = true;
}
