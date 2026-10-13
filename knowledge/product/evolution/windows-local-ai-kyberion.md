---
title: Local AI and Windows features in Kyberion
kind: operator-guide
scope: repository
authority: product
tags: [windows, local-llm, ollama, accessibility, browser, voice]
importance: 7
author: Kyberion
last_updated: 2026-10-14
role_affinity: [operator, ecosystem_architect]
applies_to: [windows, local-llm]
status: active
---

# Local AI and Windows features in Kyberion

A local model can propose and summarize while Kyberion actuators enforce origin, operation, approval, and data-scope rules.

## Choose a local-model path

- **Reasoning backend** handles coding, task planning, and browser `llm_assist`. Configure `KYBERION_REASONING_BACKEND=ollama`, `KYBERION_OLLAMA_URL`, and `KYBERION_OLLAMA_MODEL`.
- **Windows local-assist bridge** handles short Windows-focused prompts. Configure `KYBERION_WINDOWS_AI_ENDPOINT` and `KYBERION_WINDOWS_AI_MODEL` for Foundry Local or another OpenAI-compatible endpoint, including Ollama. It is separate from the reasoning route.

PowerShell session example:

```powershell
$env:KYBERION_REASONING_BACKEND = 'ollama'
$env:KYBERION_OLLAMA_URL = 'http://127.0.0.1:11434'
$env:KYBERION_OLLAMA_MODEL = 'qwen3.8:27b-q4_K_M'
$env:KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:11434'
$env:KYBERION_WINDOWS_AI_MODEL = 'gemma4:e4b'

pnpm reasoning:config doctor --json
```

Keep Ollama on loopback for same-machine use, choose a model explicitly for each task, and compare it with your real workload.

## Use Windows features through Kyberion

The Windows adapter uses Windows UI Automation (UIA) for window/control inspection, Chrome tab enumeration, app launch, window focus/state changes, and accessibility-grounded interaction. The shared OS seam also exposes keyboard and mouse input, clipboard access, graceful app close, and screen-capture backends. The baseline probes Windows observation sources individually.

- Start with read-only observation: active app/window, Chrome tabs, focused control, or a screen capture.
- Use a browser task session with `llm_assist` for exploration. Restrict `allowed_origins`, review page evidence and proposed actions, then replay an accepted candidate. Promote repeated deterministic steps to a pipeline; keep fresh model judgments in the task session.
- Prefer UIA app identity and window title over coordinates when the target is exposed. Use screen coordinates when visual grounding is needed.
- `toggleDictation` sends Windows voice typing's `Win+H` shortcut. Availability depends on Windows settings and focus.
- Windows toast notifications require `KYBERION_WINDOWS_AUMID`; without it, the adapter falls back to a best-effort message notification.

See [browser exploration task sessions](../orchestration/browser-exploration-task-session.md), [Windows local model evaluation](windows-local-model-evaluation.md), the [Japanese operator guide](windows-local-ai-kyberion.ja.md), and [computer interaction capabilities](../../../CAPABILITIES_GUIDE.md).

## Verified model results

This host has 64 GiB unified memory; Ollama uses the Radeon GPU path. Earlier Qwen 3.8 27B Q4 and Ornith 9B samples produced valid code/document responses and browser tool proposals. In a Chrome test, Qwen 3.8 27B Q4 navigated to Microsoft Learn and extracted text, but its next model turn exceeded the 90-second limit; the task session paused with partial evidence. Gemma 4 E4B completed a separate read-only Microsoft Learn task: it opened the page, returned its visible title, replayed the candidate in a fresh session, and completed the task session. A separate Windows local-assist response from Gemma included unsupported Windows API claims. Treat model advice as a draft and check it against the capability catalog and Microsoft documentation.

A generated tool call alone does not prove browser success. Check the trace, task-session result, and replay result. If a model proposes an unsupported action, preserve the partial evidence and review it.

References: [Windows AI overview](https://learn.microsoft.com/en-us/windows/ai/overview), [Foundry Local](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/what-is-foundry-local), [UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview), and [Ollama for Windows](https://docs.ollama.com/windows).
