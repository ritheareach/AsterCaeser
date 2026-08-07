"""subagent_tools.py — the spawn_subagent tool handler.

Registered in TOOL_HANDLERS (src/agent_tools/__init__.py) so dispatch flows
through the registry like the other migrated tools. The implementation lives
in src/subagent.py.
"""

import json
import logging
from typing import Dict

logger = logging.getLogger(__name__)


async def spawn_subagent(content: str, ctx: dict) -> Dict:
    """Run a fresh-context subagent and return its final answer + trace.

    Content: JSON object with:
      prompt       (required) — the self-contained task for the subagent
      model        (optional) — model name or model@endpoint (default: session model)
      endpoint     (optional) — explicit endpoint URL
      tools        (optional) — explicit tool allowlist (default: safe read-mostly set)
      max_rounds   (optional) — cap on subagent tool rounds (default 6, max 20)
      max_tokens   (optional) — per-round completion cap
      temperature  (optional) — sampling temperature (default 0.2)

    A bare string is accepted as the prompt for convenience.
    """
    from src.subagent import run_subagent
    from src.tool_execution import get_active_workspace, has_project_file_access

    try:
        args = json.loads(content or "{}")
    except json.JSONDecodeError:
        args = {"prompt": content}
    if not isinstance(args, dict):
        return {"error": "spawn_subagent arguments must be a JSON object"}

    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return {"error": "spawn_subagent requires a prompt"}

    tools = args.get("tools")
    if tools is not None and not isinstance(tools, list):
        return {"error": "spawn_subagent 'tools' must be an array of tool names"}

    try:
        result = await run_subagent(
            prompt,
            session_id=ctx.get("session_id"),
            owner=ctx.get("owner"),
            workspace=get_active_workspace(),
            project_file_access=has_project_file_access(),
            progress_cb=ctx.get("progress_cb"),
            endpoint_url=str(args.get("endpoint") or ""),
            model=str(args.get("model") or ""),
            tools=tools,
            max_rounds=args.get("max_rounds"),
            max_tokens=int(args.get("max_tokens") or 0) or None,
            temperature=float(args.get("temperature") or 0.2),
        )
    except Exception as exc:
        logger.error("spawn_subagent failed: %s", exc)
        return {"error": f"spawn_subagent failed: {exc}"}
    return result


class SpawnSubagentTool:
    async def execute(self, content: str, ctx: dict) -> Dict:
        return await spawn_subagent(content, ctx)
