#!/usr/bin/env python3
"""NDJSON bridge for the official Antigravity Python SDK.

The TypeScript runtime deliberately does not import provider SDKs.  This
process owns the AGY-specific SDK lifecycle and reports only provider-neutral
response/metadata over stdin/stdout.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class NativeTrace:
    def __init__(self, types: Any) -> None:
        self.types = types
        self.subagent_calls: list[dict[str, str]] = []

    async def pre_tool(self, data: Any) -> Any:
        name = getattr(data, "name", "")
        if name == self.types.BuiltinTools.START_SUBAGENT.value:
            self.subagent_calls.append(self._ids(data))
            return self.types.HookResult(allow=True)
        # The parent is intentionally limited to delegation and completion.
        # Child tool calls pass through this host hook too, so include only the
        # union of the statically configured child surfaces here. The parent
        # model still cannot see these tools because CapabilitiesConfig exposes
        # only START_SUBAGENT and FINISH at the parent level.
        allowed = {
            self.types.BuiltinTools.START_SUBAGENT.value,
            self.types.BuiltinTools.FINISH.value,
            self.types.BuiltinTools.LIST_DIR.value,
            self.types.BuiltinTools.SEARCH_DIR.value,
            self.types.BuiltinTools.FIND_FILE.value,
            self.types.BuiltinTools.VIEW_FILE.value,
            self.types.BuiltinTools.CREATE_FILE.value,
            self.types.BuiltinTools.EDIT_FILE.value,
            self.types.BuiltinTools.RUN_COMMAND.value,
        }
        return self.types.HookResult(allow=name in allowed)

    async def post_tool(self, data: Any) -> None:
        if getattr(data, "name", "") == self.types.BuiltinTools.START_SUBAGENT.value:
            ids = self._ids(data)
            if ids not in self.subagent_calls:
                self.subagent_calls.append(ids)

    @staticmethod
    def _ids(data: Any) -> dict[str, str]:
        result: dict[str, str] = {}
        for key in ("cascade_id", "trajectory_id", "tool_call_id"):
            value = getattr(data, key, None)
            if value:
                result[key] = str(value)
        return result


_SDK_TYPES: Any = None
_ACTIVE_TRACE: NativeTrace | None = None
_REGISTERED_HOOKS: list[Any] = []


async def pre_tool_call(data: Any) -> Any:
    if _ACTIVE_TRACE is None or _SDK_TYPES is None:
        return _SDK_TYPES.HookResult(allow=False)
    return await _ACTIVE_TRACE.pre_tool(data)


async def post_tool_call(data: Any) -> None:
    if _ACTIVE_TRACE is not None:
        await _ACTIVE_TRACE.post_tool(data)


class SdkSession:
    def __init__(self, cwd: str) -> None:
        try:
            from google.antigravity import Agent, LocalAgentConfig, types
            from google.antigravity.hooks import hooks
        except Exception as exc:  # pragma: no cover - exercised by process smoke
            raise RuntimeError(
                "[SUBAGENT_UNAVAILABLE] google-antigravity is not installed; "
                "install it with `pip install google-antigravity`."
            ) from exc

        self.Agent = Agent
        self.LocalAgentConfig = LocalAgentConfig
        self.types = types
        self.hooks = hooks
        self.cwd = cwd
        self.agent: Any = None
        self.trace: NativeTrace | None = None

    def _subagents(self) -> list[Any]:
        t = self.types
        return [
            t.SubagentConfig(
                name="kyberion-implementer",
                description="Delegated implementation worker with scoped file and command access.",
                system_instructions=(
                    "You are Kyberion's delegated implementation worker. Work only within the "
                    "assigned task and return a concise evidence-based result."
                ),
                capabilities=t.SubagentCapabilities(
                    enabled_tools=[
                        t.BuiltinTools.LIST_DIR,
                        t.BuiltinTools.SEARCH_DIR,
                        t.BuiltinTools.FIND_FILE,
                        t.BuiltinTools.VIEW_FILE,
                        t.BuiltinTools.CREATE_FILE,
                        t.BuiltinTools.EDIT_FILE,
                        t.BuiltinTools.RUN_COMMAND,
                        t.BuiltinTools.FINISH,
                    ]
                ),
            ),
            t.SubagentConfig(
                name="kyberion-explorer",
                description="Read-only delegated investigator.",
                system_instructions=(
                    "You are a read-only Kyberion investigator. Never write files or execute commands."
                ),
                capabilities=t.SubagentCapabilities(enabled_tools=t.BuiltinTools.read_only()),
            ),
            t.SubagentConfig(
                name="kyberion-planner",
                description="No-tool delegated planning worker.",
                system_instructions=(
                    "You are a planning-only Kyberion worker. Do not call tools; return a plan in text."
                ),
                capabilities=t.SubagentCapabilities(enabled_tools=t.BuiltinTools.none()),
            ),
        ]

    async def __aenter__(self) -> "SdkSession":
        self.trace = NativeTrace(self.types)
        global _ACTIVE_TRACE, _SDK_TYPES, _REGISTERED_HOOKS
        _SDK_TYPES = self.types
        _ACTIVE_TRACE = self.trace
        if not _REGISTERED_HOOKS:
            _REGISTERED_HOOKS = [
                self.hooks.pre_tool_call_decide(pre_tool_call),
                self.hooks.post_tool_call(post_tool_call),
            ]
        config = self.LocalAgentConfig(
            workspaces=[self.cwd],
            api_key=os.environ.get("KYBERION_AGY_SDK_API_KEY"),
            subagents=self._subagents(),
            capabilities=self.types.CapabilitiesConfig(
                enable_subagents=True,
                enabled_tools=[
                    self.types.BuiltinTools.START_SUBAGENT,
                    self.types.BuiltinTools.FINISH,
                ],
            ),
            hooks=_REGISTERED_HOOKS,
        )
        self.agent = await self.Agent(config).__aenter__()
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self.agent is not None:
            await self.agent.__aexit__(*args)
            self.agent = None

    async def ask(self, prompt: str, profile: str, effort: str) -> dict[str, Any]:
        if self.agent is None or self.trace is None:
            raise RuntimeError("[SUBAGENT_UNAVAILABLE] AGY SDK session is not ready.")
        if profile not in {"implementer", "explorer", "planner"}:
            raise RuntimeError(f"[SUBAGENT_PROFILE_UNKNOWN] Unsupported AGY profile: {profile}")

        self.trace.subagent_calls.clear()
        delegated = (
            "Use the provider-native Antigravity SDK subagent exactly once. "
            f"Delegate to the static subagent named kyberion-{profile}. "
            "Do not solve the task in the parent session. Return the delegated result only.\n\n"
            f"{prompt}"
        )
        await self.agent.conversation.send(delegated)
        parent_text: str | None = None
        async for step in self.agent.conversation.receive_steps():
            if not getattr(step, "is_complete_response", False):
                continue
            cascade_id = str(getattr(step, "cascade_id", "") or "")
            trajectory_id = str(getattr(step, "trajectory_id", "") or "")
            if not cascade_id or trajectory_id == cascade_id:
                parent_text = str(getattr(step, "content", "") or "")

        if not self.trace.subagent_calls:
            raise RuntimeError(
                "[SUBAGENT_UNAVAILABLE] Antigravity SDK completed without a start_subagent event."
            )
        if parent_text is None:
            raise RuntimeError("[SUBAGENT_UNAVAILABLE] Antigravity SDK returned no parent response.")

        parent_id = str(getattr(self.agent.conversation, "conversation_id", "") or "") or None
        child_ids = sorted(
            {
                value
                for call in self.trace.subagent_calls
                for key in ("trajectory_id", "cascade_id")
                if (value := call.get(key))
            }
        )
        return {
            "text": parent_text,
            "stopReason": "completed",
            "metadata": {
                "nativeSubagent": {
                    "provider": "agy",
                    "mode": "antigravity-sdk",
                    "forked": True,
                    "parentThreadId": parent_id,
                    "threadId": child_ids[0] if child_ids else None,
                    "childThreadIds": child_ids,
                    "profile": profile,
                    "effort": effort,
                }
            },
        }


async def run() -> None:
    try:
        cwd = os.environ.get("KYBERION_AGY_SDK_CWD") or os.getcwd()
        session = SdkSession(cwd)
        await session.__aenter__()
    except Exception as exc:
        emit({"event": "error", "error": str(exc)})
        return

    emit({"event": "ready", "pid": os.getpid(), "sdk": "google-antigravity"})
    current: asyncio.Task[Any] | None = None

    async def handle(request: dict[str, Any]) -> None:
        nonlocal current
        request_id = request.get("id")
        try:
            if request.get("op") == "cancel":
                conversation = getattr(session.agent, "conversation", None)
                if conversation is not None:
                    await conversation.cancel()
                emit({"id": request_id, "ok": True, "cancelled": True})
                return
            if request.get("op") != "ask":
                raise RuntimeError(f"[SUBAGENT_UNAVAILABLE] Unknown bridge operation: {request.get('op')}")
            result = await session.ask(
                str(request.get("prompt", "")),
                str(request.get("profile", "explorer")),
                str(request.get("effort", "medium")),
            )
            emit({"id": request_id, "ok": True, **result})
        except asyncio.CancelledError:
            emit({"id": request_id, "ok": False, "error": "[SUBAGENT_UNAVAILABLE] AGY request cancelled."})
        except Exception as exc:
            emit({"id": request_id, "ok": False, "error": str(exc)})

    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                emit({"event": "error", "error": f"[SUBAGENT_UNAVAILABLE] Invalid bridge JSON: {exc}"})
                continue
            if request.get("op") == "ask":
                if current and not current.done():
                    emit({"id": request.get("id"), "ok": False, "error": "[SUBAGENT_UNAVAILABLE] AGY bridge is busy."})
                    continue
                current = asyncio.create_task(handle(request))
            else:
                await handle(request)
    finally:
        if current and not current.done():
            current.cancel()
            await current
        await session.__aexit__(None, None, None)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise
