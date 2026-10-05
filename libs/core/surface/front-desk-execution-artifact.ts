/** Scoped artifact placement is domain behavior, separate from the intake contract. */
import { STORAGE_FLOOR_ROOTS, storagePartitionSegments } from '../storage-layout.js';
import {
  parseFrontDeskExecutionBinding,
  isFrontDeskExecutionPublicViewer,
  type FrontDeskExecutionBinding,
  type FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';

export function frontDeskExecutionArtifactPath(
  binding: FrontDeskExecutionBinding,
  mapping: FrontDeskExecutionMapping
): string {
  if (
    !parseFrontDeskExecutionBinding(binding) ||
    !isFrontDeskExecutionPublicViewer(mapping.viewer) ||
    mapping.viewer.tenantSlugs === 'all' ||
    mapping.viewer.tenantSlugs.length !== 1
  )
    throw new Error('front_desk_scope_invalid');
  const tier = 'public';
  return [
    STORAGE_FLOOR_ROOTS.artifact,
    ...storagePartitionSegments({ kind: 'tier', tier, tenant: mapping.viewer.tenantSlugs[0] }),
    'report',
    'front-desk',
    binding.conversation_key,
    binding.request_id + '-r' + binding.revision + '.json',
  ].join('/');
}

/** Same server-owned partition, with only validated immutable parent identity substituted. */
export function frontDeskExecutionParentArtifactPath(
  binding: FrontDeskExecutionBinding,
  mapping: FrontDeskExecutionMapping
): string | undefined {
  if (!binding.parent_request_id) return undefined;
  const path = frontDeskExecutionArtifactPath(binding, mapping);
  return (
    path.slice(0, path.lastIndexOf('/') + 1) +
    binding.parent_request_id +
    '-r' +
    binding.parent_revision +
    '.json'
  );
}
