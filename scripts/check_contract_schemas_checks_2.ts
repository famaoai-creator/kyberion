import { type ContractCheck } from './check_contract_schemas_shared.js';

export function createContractSchemaChecksPart2(): ContractCheck[] {
  return [
    {
      id: 'process-action',
      schemaPath: 'knowledge/product/schemas/process-action.schema.json',
      validPayloads: [
        {
          action: 'spawn',
          params: {
            resourceId: 'proc-schema-1',
            ownerId: 'mission-controller',
            ownerType: 'mission',
            kind: 'worker',
            command: 'node',
            args: ['--version'],
          },
        },
        {
          action: 'status',
          params: {
            resourceId: 'proc-schema-1',
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'terminal-action',
      schemaPath: 'knowledge/product/schemas/terminal-action.schema.json',
      validPayloads: [
        {
          action: 'spawn',
          params: {
            shell: '/bin/zsh',
          },
        },
        {
          action: 'resize',
          params: {
            sessionId: 'pty-1',
            cols: 120,
            rows: 40,
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'vision-action',
      schemaPath: 'knowledge/product/schemas/vision-action.schema.json',
      validPayloads: [
        {
          action: 'inspect_image',
          params: {
            path: 'active/shared/tmp/example.png',
          },
        },
        {
          action: 'pipeline',
          steps: [
            {
              action: 'ocr_image',
              params: {
                path: 'active/shared/tmp/example.png',
                language: 'eng',
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'wisdom-action',
      schemaPath: 'knowledge/product/schemas/wisdom-action.schema.json',
      validPayloads: [
        {
          action: 'knowledge_search',
          params: {
            query: 'voice generation',
          },
        },
        {
          action: 'knowledge_import',
          params: {
            source_path: 'knowledge/public/tmp/import.json',
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'voice-action',
      schemaPath: 'knowledge/product/schemas/voice-action.schema.json',
      validPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-1',
          text: 'hello world',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 200,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
        {
          action: 'register_voice_profile',
          request_id: 'reg-schema-1',
          profile: {
            profile_id: 'user-ja-voice',
            display_name: 'User JA',
            tier: 'personal',
            languages: ['ja'],
            default_engine_id: 'open_voice_clone',
          },
          samples: [
            { sample_id: 's1', path: 'Downloads/sample-1.wav', language: 'ja' },
            { sample_id: 's2', path: 'Downloads/sample-2.wav', language: 'ja' },
          ],
        },
        {
          action: 'pipeline',
          steps: [
            {
              action: 'generate_voice',
              request_id: 'req-schema-1',
              text: 'hello world',
              profile_ref: {
                profile_id: 'operator-ja-default',
              },
              engine: {
                engine_id: 'local_say',
              },
              rendering: {
                language: 'ja',
                chunking: {
                  max_chunk_chars: 200,
                  crossfade_ms: 50,
                  preserve_paralinguistic_tags: true,
                },
              },
              delivery: {
                mode: 'artifact',
                format: 'wav',
                emit_progress_packets: true,
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'voice-generation-adf',
      schemaPath: 'knowledge/product/schemas/voice-generation-adf.schema.json',
      validPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-1',
          text: 'hello world',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 200,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-invalid-1',
          text: '',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 50,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
      ],
    },
    {
      id: 'music-generation-adf',
      schemaPath: 'knowledge/product/schemas/music-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'music-generation-adf',
          version: '1.0.0',
          intent: 'anniversary_song',
          style: {
            genre: 'country',
            mood: ['warm', 'hopeful'],
            vocal: {
              presence: true,
              gender: 'female',
              language: 'ja',
            },
          },
          composition: {
            duration_sec: 180,
            bpm: 84,
            key: 'D major',
            structure: ['verse', 'chorus'],
          },
          lyrics: {
            mode: 'provided',
            text: '[Verse]\nありがとう',
          },
          arrangement: {
            instruments: ['acoustic_guitar', 'harmonica'],
            mix_traits: ['intimate'],
          },
          output: {
            format: 'mp3',
            filename_prefix: 'anniversary-song',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'music-generation-adf',
          version: '1.0.0',
          style: {
            genre: 'country',
            vocal: {
              presence: true,
            },
          },
          lyrics: {
            mode: 'provided',
          },
          output: {
            format: 'mp3',
          },
        },
      ],
    },
    {
      id: 'media-generation-action',
      schemaPath: 'knowledge/product/schemas/media-generation-action.schema.json',
      validPayloads: [
        {
          action: 'generate_image',
          params: {
            workflow_path: 'active/shared/tmp/image-workflow.json',
          },
        },
        {
          action: 'submit_generation',
          params: {
            action: 'generate_music',
            params: {
              music_adf: {
                kind: 'music-generation-adf',
                version: '1.0.0',
              },
            },
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'image-generation-adf',
      schemaPath: 'knowledge/product/schemas/image-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'image-generation-adf',
          version: '1.0.0',
          intent: 'country_cover',
          prompt: 'country road at golden hour',
          negative_prompt: 'blurry',
          canvas: { width: 1024, height: 1024 },
          output: { format: 'png', filename_prefix: 'country-cover' },
        },
      ],
      invalidPayloads: [
        {
          kind: 'image-generation-adf',
          version: '1.0.0',
          prompt: 'country road at golden hour',
          canvas: { width: 32, height: 32 },
          output: { format: 'png' },
        },
      ],
    },
    {
      id: 'video-generation-adf',
      schemaPath: 'knowledge/product/schemas/video-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'video-generation-adf',
          version: '1.0.0',
          prompt: 'cinematic driving shot',
          composition: { duration_sec: 5, fps: 24 },
          engine: {
            provider: 'comfyui',
            workflow_template: 'embedded',
            base_workflow: {
              '1': {
                class_type: 'TextNode',
                inputs: { text: '{{prompt}}', fps: '{{fps}}', duration: '{{duration_sec}}' },
              },
            },
          },
          output: { format: 'mp4', filename_prefix: 'drive-shot' },
        },
      ],
      invalidPayloads: [
        {
          kind: 'video-generation-adf',
          version: '1.0.0',
          prompt: 'cinematic driving shot',
          composition: { duration_sec: 0 },
          engine: {
            provider: 'comfyui',
            workflow_template: 'embedded',
          },
          output: { format: 'mp4' },
        },
      ],
    },
    {
      id: 'computer-action',
      schemaPath: 'knowledge/product/schemas/computer-action.schema.json',
      validPayloads: [
        {
          actions: [
            {
              type: 'click',
              x: 100,
              y: 200,
              button: 'left',
              target: 'browser',
            },
            {
              type: 'voice_output',
              text: 'hello',
              target: 'os',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          actions: [
            {
              type: 'unsupported',
            },
          ],
        },
      ],
    },
    {
      id: 'a2a-envelope',
      schemaPath: 'knowledge/product/schemas/a2a-envelope.schema.json',
      validPayloads: [
        {
          a2a_version: '1.0',
          header: {
            msg_id: 'MSG-schema-1',
            sender: 'sender-x',
            receiver: 'agent-y',
            performative: 'request',
          },
          payload: {
            text: 'hello',
          },
        },
      ],
      invalidPayloads: [
        {
          a2a_version: '2.0',
          header: {
            msg_id: 'MSG-schema-1',
            sender: 'sender-x',
            performative: 'request',
          },
          payload: {},
        },
      ],
    },
    {
      id: 'mesh-peer-registration',
      schemaPath: 'knowledge/product/schemas/mesh-peer-registration.schema.json',
      validPayloads: [
        {
          kind: 'mesh-peer-registration',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          endpoint_ref: 'mesh://peer-a1.local',
          key_ref: 'vault://mesh/peer-a1/key',
          status: 'enrolled',
          registered_at: '2026-06-24T00:00:00.000Z',
          allowed_request_kinds: ['review.request'],
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-peer-registration',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          endpoint_ref: 'mesh://peer-a1.local',
          status: 'enrolled',
          registered_at: '2026-06-24T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'mesh-peer-presence',
      schemaPath: 'knowledge/product/schemas/mesh-peer-presence.schema.json',
      validPayloads: [
        {
          kind: 'mesh-peer-presence',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          heartbeat_at: '2026-06-24T00:00:00.000Z',
          expires_at: '2026-06-24T00:05:00.000Z',
          health: 'healthy',
          capacity: { accepting_new_work: true, available_slots: 1, max_inflight: 2 },
          receive_modes: ['request'],
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-peer-presence',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          heartbeat_at: '2026-06-24T00:00:00.000Z',
          health: 'healthy',
        },
      ],
    },
    {
      id: 'mesh-capability-advertisement',
      schemaPath: 'knowledge/product/schemas/mesh-capability-advertisement.schema.json',
      validPayloads: [
        {
          kind: 'mesh-capability-advertisement',
          capability_id: 'document.review',
          version: '1',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          roles: ['reviewer'],
          request_kinds: ['review.request'],
          visibility: 'tenant',
          approval_policy: {
            requires_explicit_acceptance: true,
            requires_local_validation: true,
            requires_policy_check: true,
          },
          advertised_at: '2026-06-24T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-capability-advertisement',
          capability_id: 'document.review',
          version: '1',
          peer_id: 'peer-a1',
          tenant_id: 'tenant-acme',
          roles: ['reviewer'],
          request_kinds: ['mission.start'],
          visibility: 'tenant',
          approval_policy: { requires_explicit_acceptance: true },
          advertised_at: '2026-06-24T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'mesh-request',
      schemaPath: 'knowledge/product/schemas/mesh-request.schema.json',
      validPayloads: [
        {
          kind: 'mesh-request',
          request_id: 'meshreq-1',
          tenant_scope: { tenant_id: 'tenant-acme', scope: 'same_tenant' },
          sender_peer_id: 'peer-sender',
          created_at: '2026-06-24T00:00:00.000Z',
          ttl_ms: 60000,
          idempotency_key: 'idem-1',
          correlation_id: 'corr-1',
          request_kind: 'review.request',
          target: { selector: { kind: 'peer', peer_id: 'peer-a1' } },
          payload: {
            classification: 'confidential',
            reference: {
              artifact_ref: 'artifact://tenant-acme/brief',
              integrity_hash: 'sha256:abc',
              storage_class: 'artifact_store',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-request',
          request_id: 'meshreq-1',
          tenant_scope: { tenant_id: 'tenant-acme', scope: 'same_tenant' },
          sender_peer_id: 'peer-sender',
          created_at: '2026-06-24T00:00:00.000Z',
          ttl_ms: 60000,
          idempotency_key: 'idem-1',
          correlation_id: 'corr-1',
          request_kind: 'mission.start',
          target: { selector: { kind: 'broadcast' } },
          payload: {
            classification: 'personal',
            reference: {
              artifact_ref: 'artifact://tenant-acme/brief',
              integrity_hash: 'sha256:abc',
              storage_class: 'artifact_store',
            },
          },
        },
      ],
    },
    {
      id: 'mesh-delivery-record',
      schemaPath: 'knowledge/product/schemas/mesh-delivery-record.schema.json',
      validPayloads: [
        {
          kind: 'mesh-delivery-record',
          delivery_id: 'delivery-1',
          message_id: 'msg-1',
          request_id: 'meshreq-1',
          tenant_scope: { tenant_id: 'tenant-acme', scope: 'same_tenant' },
          request_kind: 'review.request',
          target: { selector: { kind: 'peer', peer_id: 'peer-a1' } },
          payload: {
            classification: 'public',
            reference: {
              artifact_ref: 'artifact://tenant-acme/brief',
              integrity_hash: 'sha256:abc',
              storage_class: 'artifact_store',
            },
          },
          attempt_count: 0,
          status: 'queued',
          route: {
            selector: { kind: 'peer', peer_id: 'peer-a1' },
            decision: 'direct',
            policy_version: '1.0.0',
          },
          created_at: '2026-06-24T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-delivery-record',
          delivery_id: 'delivery-1',
          message_id: 'msg-1',
          request_id: 'meshreq-1',
          tenant_scope: { tenant_id: 'tenant-acme', scope: 'same_tenant' },
          request_kind: 'review.request',
          attempt_count: 0,
          status: 'queued',
        },
      ],
    },
    {
      id: 'mesh-topic-subscription',
      schemaPath: 'knowledge/product/schemas/mesh-topic-subscription.schema.json',
      validPayloads: [
        {
          kind: 'mesh-topic-subscription',
          subscription_id: 'sub-1',
          tenant_id: 'tenant-acme',
          topic: 'release.review',
          peer_id: 'peer-a1',
          filters: { request_kinds: ['notification.publish'], payload_classifications: ['public'] },
          expires_at: '2026-06-24T01:00:00.000Z',
          policy_version: '1.0.0',
        },
      ],
      invalidPayloads: [
        {
          kind: 'mesh-topic-subscription',
          subscription_id: 'sub-1',
          tenant_id: 'tenant-acme',
          topic: 'release.review',
          peer_id: 'peer-a1',
          filters: { request_kinds: ['mission.start'], payload_classifications: ['personal'] },
          policy_version: '1.0.0',
        },
      ],
    },
    {
      id: 'bridge-request',
      schemaPath: 'knowledge/product/schemas/bridge-request.schema.json',
      validPayloads: [
        {
          intent: 'request_marketing_material',
          context: {
            channel: 'slack',
          },
          params: {
            language: 'ja',
          },
        },
      ],
      invalidPayloads: [
        {
          context: {},
        },
      ],
    },
    {
      id: 'mission-contract',
      schemaPath: 'knowledge/product/schemas/mission-contract.schema.json',
      validPayloads: [
        {
          mission_id: 'msn-schema-1',
          tier: 'confidential',
          skill: 'design',
          action: 'extract_design_spec',
          role: 'mission_controller',
          static_params: {
            project_name: 'Schema Project',
          },
          safety_gate: {
            risk_level: 3,
            require_sudo: false,
            approved_by_sovereign: true,
          },
        },
      ],
      invalidPayloads: [
        {
          mission_id: 'Invalid Space',
          tier: 'confidential',
          skill: 'design',
        },
      ],
    },
    {
      id: 'mission-state',
      schemaPath: 'knowledge/product/schemas/mission-state.schema.json',
      validPayloads: [
        {
          mission_id: 'MSN-STATE-001',
          mission_type: 'development',
          tenant_slug: 'acme-corp',
          tier: 'confidential',
          status: 'planned',
          execution_mode: 'local',
          priority: 3,
          assigned_persona: 'Ecosystem Architect',
          confidence_score: 1,
          git: {
            branch: 'main',
            start_commit: 'abc123',
            latest_commit: 'abc123',
            checkpoints: [],
          },
          cross_tenant_brokerage: {
            source_tenants: ['acme-corp', 'beta-co'],
            purpose: 'Portfolio-level consolidated analysis',
            approved_by: 'governance-board',
            approved_at: '2026-05-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
          history: [
            {
              ts: '2026-05-01T00:00:00.000Z',
              event: 'CREATE',
              note: 'Mission created.',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          mission_id: 'MSN-STATE-INVALID',
          tier: 'confidential',
          status: 'planned',
          execution_mode: 'local',
          priority: 3,
          assigned_persona: 'Ecosystem Architect',
          confidence_score: 1,
          git: {
            branch: 'main',
            start_commit: 'abc123',
            latest_commit: 'abc123',
            checkpoints: [],
          },
          cross_tenant_brokerage: {
            source_tenants: ['acme-corp'],
            purpose: 'Missing approval and expiry fields',
          },
          history: [
            {
              ts: '2026-05-01T00:00:00.000Z',
              event: 'CREATE',
              note: 'Mission created.',
            },
          ],
        },
      ],
    },
    {
      id: 'mission-context-pack',
      schemaPath: 'knowledge/product/schemas/mission-context-pack.schema.json',
      validPayloads: [
        {
          context_pack_id: 'CPK-MSN-CONTEXT-PACK-001-IMPLEMENTER-ABC12345',
          version: '1',
          generated_at: new Date('2026-06-05T00:00:00.000Z').toISOString(),
          summary:
            'mission=MSN-CONTEXT-PACK-001 / role=implementer / recipient=agent / project=PRJ-CONTEXT-PACK-001 / work_item=WIT-CONTEXT-PACK-001',
          scope: {
            tier: 'public',
            mission_id: 'MSN-CONTEXT-PACK-001',
            tenant_slug: 'acme',
            project_id: 'PRJ-CONTEXT-PACK-001',
            track_id: 'TRK-CONTEXT-PACK-001',
            task_session_id: 'TSK-CONTEXT-PACK-001',
            work_item_id: 'WIT-CONTEXT-PACK-001',
          },
          security_scope: {
            tenant_id: 'acme',
            project_id: 'PRJ-CONTEXT-PACK-001',
            mission_id: 'MSN-CONTEXT-PACK-001',
            participant_id: 'implementation-architect',
            read_tiers: ['public'],
            write_tier: 'public',
            purpose: 'implementer',
            external_egress: 'allow',
          },
          recipient: {
            kind: 'agent',
            team_role: 'implementer',
            agent_id: 'implementation-architect',
            authority_role: 'implementation-architect',
          },
          mission: {
            mission_id: 'MSN-CONTEXT-PACK-001',
            mission_type: 'product_development',
            tier: 'public',
            status: 'active',
            assigned_persona: 'worker',
            tenant_id: 'acme',
            tenant_slug: 'acme',
            vision_ref: 'vision://context-pack',
            execution_mode: 'delegated',
            priority: 3,
            confidence_score: 1,
          },
          project: {
            project_id: 'PRJ-CONTEXT-PACK-001',
            name: 'Context Pack Project',
            summary: 'A project used to validate scoped mission context injection.',
            status: 'active',
            tier: 'public',
          },
          track: {
            track_id: 'TRK-CONTEXT-PACK-001',
            project_id: 'PRJ-CONTEXT-PACK-001',
            name: 'Context Pack Track',
            summary: 'Tracks context injection work.',
            status: 'active',
            track_type: 'delivery',
            lifecycle_model: 'sdlc',
            tier: 'public',
          },
          task_session: {
            session_id: 'TSK-CONTEXT-PACK-001',
            surface: 'presence',
            task_type: 'analysis',
            status: 'executing',
            mode: 'delegated',
            goal: {
              summary: 'Validate mission context packing',
              success_condition: 'pack can be rendered and saved',
            },
            updated_at: new Date('2026-06-05T00:00:00.000Z').toISOString(),
          },
          work_item: {
            item_id: 'WIT-CONTEXT-PACK-001',
            title: 'Implement context pack injection',
            description:
              'Build the scoped mission context pack and use it in the work item dispatch prompt.',
            status: 'ready',
            priority: 'high',
            source: 'local',
            source_ref: 'mission:MSN-CONTEXT-PACK-001:task-1',
            project_id: 'PRJ-CONTEXT-PACK-001',
            assignee_peer_id: 'implementation-architect',
            labels: ['mission:MSN-CONTEXT-PACK-001', 'team_role:implementer'],
            dependencies: [],
          },
          knowledge_hints: [
            {
              path: 'knowledge/product/architecture/context-precedence-protocol.md',
              title: 'Context Precedence Protocol',
              excerpt: 'Kyberion reads context in tiers.',
              tags: ['context', 'tier'],
            },
          ],
          sources: [
            {
              kind: 'mission_state',
              ref: 'mission:MSN-CONTEXT-PACK-001',
            },
          ],
          redactions: ['full Kyberion knowledge corpus'],
          delivery: {
            mode: 'prompt',
            summary: 'Role-scoped mission context pack.',
          },
        },
      ],
      invalidPayloads: [
        {
          context_pack_id: 'CPK-invalid',
          version: '1',
          generated_at: new Date('2026-06-05T00:00:00.000Z').toISOString(),
          summary: 'missing scope',
          recipient: { kind: 'agent' },
          mission: {
            mission_id: 'MSN-CTX',
            tier: 'public',
            status: 'active',
            assigned_persona: 'worker',
          },
          sources: [],
          redactions: [],
          delivery: { mode: 'prompt', summary: 'invalid' },
        },
      ],
    },
    {
      id: 'design-spec',
      schemaPath: 'knowledge/product/schemas/design-spec.schema.json',
      validPayloads: [
        {
          version: 'v1',
          project_name: 'Schema Project',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          components: [
            {
              id: 'COMP-SCHEMA',
              name: 'Core Service',
              responsibility: 'Handles business logic',
              requirements_refs: ['FR-1'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          components: [],
        },
      ],
    },
    {
      id: 'task-plan',
      schemaPath: 'knowledge/product/schemas/task-plan.schema.json',
      validPayloads: [
        {
          version: 'v1',
          project_name: 'Schema Project',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          tasks: [
            {
              task_id: 'T-IMPL-1',
              title: 'Implement core',
              summary: 'core module',
              priority: 'must',
              estimate: 'M',
              test_criteria: ['core tests pass'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          tasks: [],
        },
      ],
    },
    {
      id: 'generation-schedule',
      schemaPath: 'knowledge/product/schemas/generation-schedule.schema.json',
      validPayloads: [
        {
          kind: 'generation-schedule',
          schedule_id: 'monthly',
          enabled: true,
          trigger: { type: 'cron', cron: '0 7 1 * *', timezone: 'Asia/Tokyo' },
          job_template: { action: 'generate_music', params: {} },
          execution_policy: { concurrency: 'skip_if_running' },
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'generation-schedule',
          schedule_id: 'monthly',
          enabled: true,
          trigger: { type: 'cron' },
          execution_policy: { concurrency: 'skip_if_running' },
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'generation-job',
      schemaPath: 'knowledge/product/schemas/generation-job.schema.json',
      validPayloads: [
        {
          kind: 'generation-job',
          job_id: 'genjob-schema-1',
          action: 'generate_music',
          status: 'submitted',
          request: {
            target_path: 'active/shared/exports/anniversary-song.mp3',
          },
          created_at: '2026-03-22T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'generation-job',
          job_id: 'genjob-schema-1',
          action: 'generate_music',
          status: 'submitted',
          request: {},
        },
      ],
    },
    {
      id: 'test-case-adf',
      schemaPath: 'knowledge/product/schemas/test-case-adf.schema.json',
      validPayloads: [
        {
          kind: 'test-case-adf',
          app_id: 'sample-app',
          cases: [
            {
              case_id: 'TC-1',
              title: 'Happy path',
              objective: 'Verify FR-1',
              steps: ['do x'],
              expected: ['outcome y'],
              automation_backend: 'browser',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'test-case-adf',
          app_id: '',
          cases: [],
        },
      ],
    },
    {
      id: 'document-brief',
      schemaPath: 'knowledge/product/schemas/document-brief.schema.json',
      validPayloads: [
        {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          document_profile: 'summary-report',
          render_target: 'docx',
          locale: 'en-US',
          payload: {
            title: 'Quarterly Reliability Review',
            summary: 'Reliability and incident posture improved across the quarter.',
            sections: [
              {
                heading: 'Incident Themes',
                body: ['Three recurring failure modes were reduced after remediation.'],
                bullets: ['Gateway timeout handling improved', 'Retry policy standardized'],
              },
            ],
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          render_target: 'docx',
          payload: {},
        },
      ],
    },
    {
      id: 'proposal-brief',
      schemaPath: 'knowledge/product/schemas/proposal-brief.schema.json',
      validPayloads: [
        {
          kind: 'proposal-brief',
          title: 'Kyberion Platform Proposal',
          client: 'Aster Bank',
          objective: 'Deliver a governed proposal deck',
          document_profile: 'executive-proposal',
          layout_template_id: 'executive-neutral',
          render_target: 'pptx',
          locale: 'en-US',
          audience: ['executive', 'ops'],
          story: {
            core_message: 'Kyberion makes governed execution visible and repeatable.',
            chapters: ['Context', 'Value', 'Delivery'],
            tone: 'confident',
            closing_cta: 'Approve the rollout',
          },
          evidence: [
            { title: 'Governed outputs', point: 'Artifacts are traceable and reproducible.' },
          ],
          required_sections: ['Summary', 'Evidence'],
        },
      ],
      invalidPayloads: [
        {
          kind: 'proposal-brief',
          title: 'Kyberion Platform Proposal',
          client: 'Aster Bank',
          objective: 'Deliver a governed proposal deck',
          audience: ['executive', 'ops'],
        },
      ],
    },
  ];
}
