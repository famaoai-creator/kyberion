---
title: Windows local model smoke evaluation on Ryzen AI Max+
kind: reference
scope: repository
authority: empirical
tags: [windows, local-models, ollama, qwen, coding, browser, documents]
importance: 7
author: Kyberion
last_updated: 2026-10-13
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [windows, ollama, local-llm]
status: active
---

# Windows local model smoke evaluation

## Host and runtime

Observed on Windows 11 Pro 10.0.26200 with an AMD Ryzen AI Max+ 395, Radeon 8060S, and 64 GiB RAM. Ollama 0.40.3 served the requests from localhost. The process listing showed 100% GPU use, a 32768-token active context, and the llama.cpp runner. Model metadata advertised 262144 context; use the observed runtime context when planning actual workloads.

## Installed model tags

The local Ollama tag inventory contained four tags and three distinct digests:

| Tag                | Digest                                                           | Parameters / quantization |                 Size | Tested                |
| ------------------ | ---------------------------------------------------------------- | ------------------------- | -------------------: | --------------------- |
| qwen3.8:27b-q4_K_M | 25b843619e944cd0ae6069f94ff4e5e26a16e109ccbc0a66a0f05979ed70098e | 27.3B, Q4_K_M             | 17,741,872,132 bytes | Yes                   |
| qwen3.8:27b        | aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813 | 27.3B, Q4_K_M             | 17,741,872,154 bytes | No                    |
| ornith:latest      | a75697c145891910e312c95e4a9fc1ccb8653e5ef543b23b0403a4665b82fd91 | 9.0B, Q4_K_M              |  5,629,110,568 bytes | Yes                   |
| ornith:9b          | a75697c145891910e312c95e4a9fc1ccb8653e5ef543b23b0403a4665b82fd91 | 9.0B, Q4_K_M              |  5,629,110,568 bytes | Same digest as latest |

Do not treat qwen3.8:27b and qwen3.8:27b-q4_K_M as aliases: they have different digests. The evidence below only covers qwen3.8:27b-q4_K_M.

## Matched smoke prompts

Each task/model pair was sampled once with temperature 0; code and document cases requested JSON and capped output at 256 tokens. Thinking was disabled.

| Task                    | Qwen 3.8 27B Q4_K_M                                                   | Ornith 9B Q4_K_M                                   |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| TypeScript add function | Valid JSON, 30 tokens, 22.519 s                                       | Valid JSON, 30 tokens, 7.445 s                     |
| Browser tool intent     | Selected open_browser_url for https://example.com; 29 tokens, 3.351 s | Same tool and URL; 29 tokens, 1.241 s              |
| Japanese short document | Valid JSON heading and summary; 72 tokens, 6.010 s                    | Valid JSON heading and summary; 66 tokens, 2.025 s |

Kyberion generateWithTools also returned report_test_result with status ok for both models. This confirms tool-call generation only. No browser was launched and no browser actuator was executed. These single samples do not establish a quality ranking or stable throughput.

An initial Qwen document attempt with thinking enabled reached the token limit and returned no visible content. Retrying with thinking disabled and JSON response mode succeeded.

## Kyberion route observation

The configured subagent route selected Ollama Qwen and reported ready. Its route policy had toolsEnabled false and an empty allowedTools list, although backend capability metadata reported tool calling. Model capability and route authorization are separate; enabling tool access requires an explicit route policy change.

## Runtime discovery

Ollama was available and used for the evaluation. vllm, llama-server, and llama-cli were not found on PATH. This PATH lookup does not establish that those runtimes are absent from other installation locations.

## Evidence

Detailed host inventory, model metadata, and matched smoke measurements are recorded in mission MSN-WINDOWS-LLM-EVAL-20261013. The measurements were transcribed from local Windows system details, Ollama /api/tags and process listing, direct chat responses, Kyberion tool-call generation, and reasoning configuration doctor/explain output.
