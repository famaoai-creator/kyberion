export interface SafeRepositoryPathOptions {
  allowMissingLeaf?: boolean;
  allowSymlinkLeaf?: boolean;
  rootDir?: string;
}

export function assertSafeRepositoryPath(
  filePath: string,
  options?: SafeRepositoryPathOptions
): string;
