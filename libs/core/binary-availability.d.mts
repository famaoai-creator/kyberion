export interface BinaryAvailabilityOptions {
  platform?: string;
  pathValue?: string;
  pathDelimiter?: string;
  pathExt?: string;
  exists: (path: string) => boolean;
}

export function createBinaryAvailability(
  options: BinaryAvailabilityOptions
): (binary: string) => boolean;
