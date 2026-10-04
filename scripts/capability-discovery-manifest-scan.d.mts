export interface ScannedActuatorManifest {
  actuator_id?: string;
  version?: string;
  description?: string;
  capabilities?: unknown[];
}

export interface ManifestScanIo {
  assertSafePath(path: string, options: { allowMissingLeaf?: boolean; rootDir: string }): string;
  exists(path: string): boolean;
  readdir(path: string): string[];
  lstat(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
}

export function scanActuatorManifests<TManifest extends ScannedActuatorManifest>(options: {
  rootDir: string;
  actuatorsDir: string;
  io: ManifestScanIo;
  loadManifest(path: string): TManifest;
}): {
  actuators: Array<{ item: string; manifest: TManifest }>;
  errors: string[];
};
