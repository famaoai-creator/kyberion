import { runExternalOperation } from '@agent/core/governance/external-operation';
import { wrapAdapterEffects } from '@agent/core/governance/adapter-effect-proxy';
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationSubmission,
} from './types.js';

const governedVideoMethods = new WeakSet<object>();
export function governVideoProvider<T extends VideoGenerationProvider>(provider: T): T {
  const originalSubmit = provider.submit;
  if (governedVideoMethods.has(originalSubmit)) return provider;
  const submit = (request: VideoGenerationRequest) => {
    const params = structuredClone(request);
    return runExternalOperation<VideoGenerationSubmission>(
      {
        operationId: `media:video:${provider.provider}:submit`,
        effect: { provider: provider.provider, params },
        requiresApproval: true,
        delegable: false,
      },
      () => originalSubmit.call(provider, params),
      (receipt) =>
        typeof receipt.provider_job_id === 'string' &&
        receipt.provider_job_id.trim() &&
        ['submitted', 'running', 'succeeded'].includes(receipt.status)
          ? 'succeeded'
          : 'unknown'
    );
  };
  governedVideoMethods.add(submit);
  return wrapAdapterEffects(provider, (property, original, target) => {
    if (property === 'submit') return submit;
    if (property !== 'cancel') return undefined;
    return (providerJobId: string) =>
      runExternalOperation(
        {
          operationId: `media:video:${provider.provider}:cancel`,
          effect: { provider: provider.provider, params: { provider_job_id: providerJobId } },
          requiresApproval: true,
          delegable: false,
        },
        async () => Reflect.apply(original, target, [providerJobId]),
        () => 'succeeded'
      );
  });
}
