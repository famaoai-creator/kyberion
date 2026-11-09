/**
 * Dependency-free reader. Execution shape a dot WorkItem requests. New items carry `requested_execution_shape`;
 * items created from a version-1 action carry the deprecated `requested_work_shape`,
 * read for one release.
 */
export function requestedExecutionShape(metadata: Record<string, unknown> | undefined): unknown {
  return metadata?.requested_execution_shape ?? metadata?.requested_work_shape;
}
