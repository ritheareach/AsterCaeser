"""subagent.py — fresh-context subagents for the spawn_subagent tool.

A subagent is a second, independent agent run: its own prompt, its own
context window, and its own (restricted) tool access. The parent agent
delegates a task via `spawn_subagent`; the subagent works autonomously —
calling tools, reading results, iterating — until it produces a final
answer or exhausts its round/token budget. The parent receives the final
answer plus a short trace of what the subagent did.

Safety:
  - Subagents run with a read-mostly default tool allowlist (no shell, no
    user prompts, no admin/settings tools).
  - `spawn_subagent` itself is excluded by default, so subagents cannot
    recurse unless the parent explicitly grants it.
  - The parent's workspace/project-file-access contextvars are inherited
    automatically by the inner tool executions.
"""

import asyncio
import json
import logging
from typing import Awaitable, Callable, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Tools a subagent may use without the parent explicitly granting them.
# Read-mostly + document/notes/memory work. Everything that can touch the
# host shell, the user, or admin state is excluded and requires an explicit
# `tools` allowlist from the caller.
DEFAULT_SUBAGENT_TOOLS: frozenset = frozenset({
    "ls", "glob", "grep", "read_file", "get_workspace",
    "web_search", "web_fetch",
    "create_document", "update_document", "edit_document", "suggest_document",
    "manage_documents",
    "list_sessions", "manage_session", "manage_notes", "manage_memory",
    "list_models", "chat_with_model", "manage_calendar", "manage_tasks",
    "list_cached_models", "list_cookbook_servers",
})

# Tools that only become available when the parent explicitly lists them in
# `tools` — recursion, shell, user interaction, admin surface.
_SENSITIVE_TOOLS: frozenset = frozenset({
    "bash", "python", "edit_file", "write_file",
    "ask_user", "update_plan", "ui_control", "manage_settings",
    "api_call", "app_api", "generate_image", "edit_image",
    "manage_endpoints", "manage_mcp", "manage_webhooks", "manage_tokens",
    "manage_bg_jobs", "download_model", "serve_model", "tail_serve_output",
    "delete_email", "archive_email", "bulk_email", "manage_contact",
    "trigger_research", "manage_research", "spawn_subagent",
})

_SUBAGENT_SYSTEM_PROMPT = """\
You are a focused subagent. A main assistant delegated a task to you and is
waiting for your final answer.

You have a FRESH context — you know only what is in this prompt and what you
discover with your tools. Work autonomously:

1. Understand the task. Break it into steps if needed.
2. Use your tools to gather information or produce outputs. Prefer the
   cheapest sufficient tool; avoid redundant calls.
3. When the task is complete, reply with ONLY your final answer for the main
   assistant: concise, factual, complete, no preamble. Do NOT call tools in
   the final message.

Rules:
- You cannot ask the user questions. If information is missing, say what is
  missing instead of guessing.
- You cannot use shell commands or edit files unless explicitly granted.
- If a tool fails or is unavailable, note it and continue.
- Never fabricate results. If you could not verify something, say so.

Tool calling format — when you need a tool, write a fenced code block whose
language is the tool name, with the arguments as its content:

```tool_name
arguments here
```

Examples:
```web_search
{"query": "latest warehouse stock", "time_filter": "week"}
```

Available tools:
"""


async def _resolve_endpoint(
    endpoint_url: str,
    model: str,
    headers: Optional[dict],
    session_id: Optional[str],
    owner: Optional[str],
) -> Dict:
    """Resolve (endpoint_url, model, headers) for the subagent run.

    Priority: explicit endpoint+model args -> explicit model name (resolved
    against configured endpoints) -> the parent session's own model.
    """
    from src.ai_interaction import _resolve_model

    if endpoint_url and model:
        if not headers:
            # Best-effort: find the configured endpoint behind this URL so we
            # can attach the right API key headers.
            try:
                from src.database import SessionLocal, ModelEndpoint
                from src.endpoint_resolver import resolve_endpoint_runtime, build_headers
                db = SessionLocal()
                try:
                    for ep in db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).all():  # noqa: E712
                        try:
                            base, api_key = resolve_endpoint_runtime(ep, owner=owner)
                        except Exception:
                            continue
                        if endpoint_url.startswith(base.rstrip("/")):
                            headers = build_headers(api_key, base)
                            break
                finally:
                    db.close()
            except Exception:
                pass
        return {"endpoint_url": endpoint_url, "model": model, "headers": headers}

    if model and "@" not in model:
        try:
            url, resolved_model, resolved_headers = await asyncio.to_thread(
                _resolve_model, model, owner=owner,
            )
            return {"endpoint_url": url, "model": resolved_model, "headers": resolved_headers}
        except ValueError:
            logger.warning("subagent model %s not resolvable; falling back to session model", model)

    # Fall back to the parent session's own model.
    try:
        from src.database import SessionLocal, DbSession
        db = SessionLocal()
        try:
            sess = db.query(DbSession).filter(DbSession.id == session_id).first()
        finally:
            db.close()
        if sess and sess.endpoint_url and sess.model:
            return {"endpoint_url": sess.endpoint_url, "model": sess.model, "headers": headers}
    except Exception:
        pass
    raise ValueError("Could not resolve a model for the subagent (no endpoint/model and no session model)")


def _tool_descriptions(tools: Set[str]) -> str:
    """Build the tool list section of the subagent system prompt."""
    descriptions: Dict[str, str] = {}
    try:
        from src.agent_loop import TOOL_SECTIONS as _sections
        for name in tools:
            text = _sections.get(name)
            if text:
                descriptions[name] = str(text).strip().splitlines()[0][:160]
    except Exception:
        pass
    if not descriptions:
        try:
            from src.tool_schemas import FUNCTION_TOOL_SCHEMAS
            for schema in FUNCTION_TOOL_SCHEMAS:
                fn = schema.get("function", {})
                if fn.get("name") in tools:
                    descriptions[fn["name"]] = (fn.get("description") or "")[:200]
        except Exception:
            pass
    lines = []
    for name in sorted(tools):
        lines.append(f"- `{name}` — {descriptions.get(name, 'available')}")
    return "\n".join(lines)


async def run_subagent(
    prompt: str,
    *,
    session_id: Optional[str] = None,
    owner: Optional[str] = None,
    workspace: Optional[str] = None,
    project_file_access: bool = False,
    disabled_tools: Optional[Set[str]] = None,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
    endpoint_url: str = "",
    model: str = "",
    headers: Optional[dict] = None,
    tools: Optional[List[str]] = None,
    max_rounds: Optional[int] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
) -> Dict:
    """Run a fresh-context subagent loop and return its final answer + trace.

    Returns {"response", "rounds", "tool_calls", "model"} on success, or
    {"error": ...} when the run cannot start.
    """
    from src.settings import get_setting
    from src.llm_core import llm_call_async
    # Re-exported by agent_tools — importing tool_parsing directly would trip
    # the tool_parsing <-> agent_tools module cycle.
    from src.agent_tools import parse_tool_blocks
    from src.tool_execution import execute_tool_block, format_tool_result

    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "spawn_subagent requires a non-empty prompt"}

    # Resolve tool allowlist.
    explicit_tools = set(tools or [])
    if explicit_tools:
        allowed = set(explicit_tools) & (DEFAULT_SUBAGENT_TOOLS | _SENSITIVE_TOOLS)
        unknown = explicit_tools - allowed
        if unknown:
            logger.warning("spawn_subagent: ignoring unknown tool names: %s", sorted(unknown))
    else:
        allowed = set(DEFAULT_SUBAGENT_TOOLS)
    if not allowed:
        return {"error": "spawn_subagent: empty tool allowlist"}

    max_rounds = max_rounds or int(get_setting("agent_subagent_max_rounds", 6) or 6)
    max_rounds = max(1, min(max_rounds, 20))
    max_tokens = max_tokens or int(get_setting("agent_subagent_max_tokens", 2000) or 2000)

    try:
        resolved = await _resolve_endpoint(endpoint_url, model, headers, session_id, owner)
    except ValueError as exc:
        return {"error": str(exc)}
    url = resolved["endpoint_url"]
    run_model = resolved["model"]
    run_headers = resolved["headers"]

    system_prompt = _SUBAGENT_SYSTEM_PROMPT + _tool_descriptions(allowed)
    messages: List[Dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    tool_calls: List[Dict] = []
    rounds = 0
    final_response = ""
    # The subagent uses plain-text completions — there is no native
    # function-call channel — so fenced tool blocks must ALWAYS be parsed.
    is_api_model = False

    while rounds < max_rounds:
        rounds += 1
        try:
            round_response = await llm_call_async(
                url, run_model, messages,
                temperature=temperature,
                max_tokens=max_tokens,
                headers=run_headers,
                prompt_type="subagent",
            )
        except Exception as exc:
            logger.error("subagent round %d model call failed: %s", rounds, exc)
            return {
                "error": f"Subagent model call failed: {exc}",
                "rounds": rounds,
                "tool_calls": tool_calls,
            }

        if progress_cb:
            try:
                await progress_cb({
                    "type": "tool_progress",
                    "tool": "spawn_subagent",
                    "round": rounds,
                    "output": round_response[:400],
                })
            except Exception:
                pass

        blocks = parse_tool_blocks(round_response, skip_fenced=is_api_model)
        if not blocks:
            final_response = round_response.strip()
            break

        messages.append({"role": "assistant", "content": round_response})
        for block in blocks:
            tool_name = getattr(block, "tool_type", None) or ""
            if tool_name not in allowed:
                result_text = f"### {tool_name}\nTool '{tool_name}' is not available to this subagent."
                tool_calls.append({"tool": tool_name, "status": "blocked"})
            else:
                try:
                    desc, result = await execute_tool_block(
                        block,
                        session_id=session_id,
                        disabled_tools=disabled_tools,
                        owner=owner,
                        progress_cb=progress_cb,
                        workspace=workspace,
                        project_file_access=project_file_access,
                    )
                    result_text = format_tool_result(desc, result)
                    tool_calls.append({
                        "tool": tool_name,
                        "status": "ok" if not result or result.get("exit_code") in (0, None) else "failed",
                    })
                except Exception as exc:
                    logger.error("subagent tool %s failed: %s", tool_name, exc)
                    result_text = f"### {tool_name}\nError: {exc}"
                    tool_calls.append({"tool": tool_name, "status": "error"})
            messages.append({"role": "user", "content": result_text[:16000]})

    if not final_response:
        final_response = "(subagent ran out of rounds without a final answer)"

    return {
        "response": final_response[:20000],
        "rounds": rounds,
        "tool_calls": tool_calls,
        "model": run_model,
    }
