import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

export const COMPUTE_ACTUATOR_CAPTURE_OPS = ['poll_status', 'collect_artifact'] as const;
export const COMPUTE_ACTUATOR_APPLY_OPS = ['submit_job', 'cancel_job'] as const;

export function describeOps(): ActuatorOpDescription[] {
  return [
    {
      op: 'submit_job',
      kind: 'apply' as PipelineStepType,
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          provider: { type: 'string', enum: ['local', 'colab'] },
          notebook_path: { type: 'string' },
          entrypoint: { type: 'string' },
          hardware: {
            type: 'object',
            properties: {
              accelerator: { type: 'string', enum: ['none', 'gpu', 'tpu'] },
              gpu_type: { type: 'string' },
              high_ram: { type: 'boolean' },
            },
          },
          params: { type: 'object' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      examples: [
        {
          job_id: 'job-fine-tune-001',
          provider: 'colab',
          notebook_path: 'notebooks/train_lora.ipynb',
          hardware: { accelerator: 'gpu', gpu_type: 'a100', high_ram: true },
        },
      ],
    },
    {
      op: 'poll_status',
      kind: 'capture' as PipelineStepType,
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          provider: { type: 'string', enum: ['local', 'colab'] },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      examples: [{ job_id: 'job-fine-tune-001', provider: 'colab' }],
    },
    {
      op: 'collect_artifact',
      kind: 'capture' as PipelineStepType,
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          target_path: { type: 'string' },
          artifact_names: { type: 'array', items: { type: 'string' } },
        },
        required: ['job_id', 'target_path'],
        additionalProperties: false,
      },
      examples: [
        { job_id: 'job-fine-tune-001', target_path: 'active/shared/artifacts/model_weights.bin' },
      ],
    },
    {
      op: 'cancel_job',
      kind: 'apply' as PipelineStepType,
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      examples: [{ job_id: 'job-fine-tune-001' }],
    },
  ];
}
