"""Transport for the Typst preview sync tier."""
from __future__ import annotations

import asyncio
from collections import deque
import json
import logging
import os
from typing import Deque, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect, WebSocketState

from src.typst_preview import (
    TypstPreviewError,
    TypstPreviewSession,
    manager as preview_manager,
    tinymist_path,
    tinymist_version,
)

logger = logging.getLogger(__name__)

SESSION_COOKIE = "astercaeser_session"

_FRAME_PATH = "/api/workspace/typst/frame"
_FRAME_BRIDGE_TYPE = "astercaeser-preview-frame-v2"
_WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024


class TypstSessionStart(BaseModel):
    project_id: str
    path: str
    mode: str = "document"


class TypstSessionStop(BaseModel):
    token: str


class TypstControlCommand(BaseModel):
    token: str
    payload: dict


def _auth_enabled() -> bool:
    return os.getenv("AUTH_ENABLED", "true").lower() != "false"


def _localhost_bypass() -> bool:
    return os.getenv("LOCALHOST_BYPASS", "false").lower() == "true"


def _is_loopback(websocket: WebSocket) -> bool:
    client = websocket.client
    return bool(client and client.host in ("127.0.0.1", "::1", "localhost"))


def _ws_identity(websocket: WebSocket) -> Tuple[bool, str]:
    if not _auth_enabled():
        return True, ""
    if _localhost_bypass() and _is_loopback(websocket):
        return True, ""
    auth_manager = getattr(websocket.app.state, "auth_manager", None)
    if auth_manager is None:
        return False, ""
    if not getattr(auth_manager, "is_configured", False):
        return (True, "") if _is_loopback(websocket) else (False, "")
    token = websocket.cookies.get(SESSION_COOKIE)
    if not auth_manager.validate_token(token):
        return False, ""
    return True, auth_manager.get_username_for_token(token) or ""


def _resolve_session(websocket: WebSocket, token: str) -> Optional[TypstPreviewSession]:
    ok, owner = _ws_identity(websocket)
    if not ok:
        return None
    from src.tool_security import owner_is_admin_or_single_user
    if not owner_is_admin_or_single_user(owner):
        return None
    return preview_manager().get_by_token(token, owner)


def _to_relative(session: TypstPreviewSession, abs_path: str) -> Optional[str]:
    if not isinstance(abs_path, str) or not abs_path:
        return None
    root = session.root
    try:
        resolved = os.path.realpath(abs_path)
    except (OSError, ValueError):
        return None
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    rel = os.path.relpath(resolved, root)
    if rel.startswith(".."):
        return None
    return rel.replace(os.sep, "/")


def _to_absolute(session: TypstPreviewSession, rel_path: str) -> Optional[str]:
    if not isinstance(rel_path, str) or not rel_path:
        return None
    cleaned = rel_path.strip().replace("\\", "/")
    if cleaned.startswith("/") or (
        len(cleaned) >= 3 and cleaned[0].isalpha() and cleaned[1:3] == ":/"
    ):
        return None
    root = session.root
    try:
        resolved = os.path.realpath(os.path.join(root, cleaned))
    except (OSError, ValueError):
        return None
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


def _inbound_event(session: TypstPreviewSession, payload: dict) -> Optional[dict]:
    event = payload.get("event")
    if event == "editorScrollTo":
        rel = _to_relative(session, payload.get("filepath"))
        if rel is None:
            return None
        out = dict(payload)
        out["filepath"] = rel
        return out
    return payload


def _outbound_event(session: TypstPreviewSession, payload: dict) -> Optional[dict]:
    event = payload.get("event")
    if event == "updateMemoryFiles":
        files = payload.get("files")
        if not isinstance(files, dict):
            return None
        translated = {}
        for rel, content in files.items():
            abs_path = _to_absolute(session, rel)
            if abs_path is None or not isinstance(content, str):
                continue
            translated[abs_path] = content
        if not translated:
            return None
        return {"event": "updateMemoryFiles", "files": translated}
    if event == "removeMemoryFiles":
        files = payload.get("files")
        if not isinstance(files, list):
            return None
        translated = [p for p in (_to_absolute(session, r) for r in files) if p is not None]
        if not translated:
            return None
        return {"event": "removeMemoryFiles", "files": translated}
    if event == "panelScrollTo":
        abs_path = _to_absolute(session, payload.get("filepath"))
        if abs_path is None:
            return None
        try:
            line = int(payload.get("line", 0))
            character = int(payload.get("character", 0))
        except (TypeError, ValueError):
            return None
        return {"event": "panelScrollTo", "filepath": abs_path, "line": max(0, line), "character": max(0, character)}
    return None


async def _pump_client_to_upstream(websocket: WebSocket, upstream) -> None:
    while True:
        message = await websocket.receive()
        kind = message.get("type")
        if kind == "websocket.disconnect":
            return
        text = message.get("text")
        data = message.get("bytes")
        if text is not None:
            if len(text) > _WS_MAX_MESSAGE_BYTES:
                return
            await upstream.send(text)
        elif data is not None:
            if len(data) > _WS_MAX_MESSAGE_BYTES:
                return
            await upstream.send(data)


async def _pump_upstream_to_client(websocket: WebSocket, upstream) -> None:
    async for message in upstream:
        if isinstance(message, (bytes, bytearray)):
            await websocket.send_bytes(bytes(message))
        else:
            await websocket.send_text(message)


def _connect_upstream(upstream_url: str):
    try:
        from websockets.asyncio.client import connect as ws_connect
    except ImportError:
        from websockets.client import connect as ws_connect
        return ws_connect(upstream_url, max_size=_WS_MAX_MESSAGE_BYTES, open_timeout=10, ping_interval=None, extra_headers={"Origin": "http://localhost"})
    return ws_connect(upstream_url, max_size=_WS_MAX_MESSAGE_BYTES, open_timeout=10, ping_interval=None, additional_headers={"Origin": "http://localhost"})


class _ControlBridge:
    def __init__(self, session: TypstPreviewSession):
        self.session = session
        self._commands: asyncio.Queue[dict] = asyncio.Queue()
        self._events: Deque[Tuple[int, dict]] = deque(maxlen=256)
        self._revision = 0
        self._changed = asyncio.Condition()
        self._task: Optional[asyncio.Task] = None
        self._stopped = False

    def start(self) -> None:
        if self._task is None:
            preview_manager().attach(self.session)
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        preview_manager().release(self.session)

    async def send(self, payload: dict) -> None:
        self.start()
        await self._commands.put(payload)

    async def events_since(self, after: int, timeout: float = 25.0) -> dict:
        self.start()
        async with self._changed:
            if self._revision <= after:
                try:
                    await asyncio.wait_for(self._changed.wait_for(lambda: self._revision > after), timeout)
                except asyncio.TimeoutError:
                    pass
            return {"revision": self._revision, "events": [event for rev, event in self._events if rev > after]}

    async def _publish(self, event: dict) -> None:
        async with self._changed:
            self._revision += 1
            self._events.append((self._revision, event))
            self._changed.notify_all()

    async def _run(self) -> None:
        while not self._stopped and self.session.is_alive():
            try:
                async with _connect_upstream(f"ws://{self.session.control_addr}/") as upstream:
                    self.session.touch()
                    await self._publish({"event": "bridgeStatus", "kind": "Connected"})
                    async def send_commands() -> None:
                        while True:
                            payload = await self._commands.get()
                            await upstream.send(json.dumps(payload) + "\n")
                            self.session.touch()
                    async def receive_events() -> None:
                        buffer = ""
                        async for chunk in upstream:
                            if isinstance(chunk, (bytes, bytearray)):
                                chunk = chunk.decode("utf-8", errors="replace")
                            buffer += chunk
                            while "\n" in buffer:
                                line, buffer = buffer.split("\n", 1)
                                try:
                                    event = json.loads(line)
                                except (TypeError, ValueError):
                                    continue
                                if isinstance(event, dict):
                                    safe = _inbound_event(self.session, event)
                                    if safe is not None:
                                        await self._publish(safe)
                    sender = asyncio.create_task(send_commands())
                    receiver = asyncio.create_task(receive_events())
                    children = (sender, receiver)
                    try:
                        done, pending = await asyncio.wait(children, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for task in children:
                            if not task.done():
                                task.cancel()
                        results = await asyncio.gather(*children, return_exceptions=True)
                    for result in results:
                        if isinstance(result, BaseException):
                            raise result
            except asyncio.CancelledError:
                raise
            except OSError as exc:
                if getattr(exc, "errno", None) == 61:
                    logger.warning("typst control listener disappeared; retiring session. Log tail:\n%s", self.session.log_tail())
                    preview_manager().close_session(self.session)
                    await self._publish({"event": "bridgeStatus", "kind": "Closed"})
                    return
                logger.info("typst server-owned control bridge reconnecting: %s", exc)
                await self._publish({"event": "bridgeStatus", "kind": "Reconnecting"})
                await asyncio.sleep(0.5)
            except Exception as exc:
                logger.info("typst server-owned control bridge reconnecting: %s", exc)
                await self._publish({"event": "bridgeStatus", "kind": "Reconnecting"})
                await asyncio.sleep(0.5)
        await self._publish({"event": "bridgeStatus", "kind": "Closed"})


_control_bridges: Dict[str, _ControlBridge] = {}

def _control_bridge(session: TypstPreviewSession) -> _ControlBridge:
    bridge = _control_bridges.get(session.token)
    if bridge is None:
        bridge = _ControlBridge(session)
        _control_bridges[session.token] = bridge
    return bridge

async def _drop_control_bridge(token: str) -> None:
    bridge = _control_bridges.pop(token, None)
    if bridge is not None:
        await bridge.stop()

async def _relay_connected(websocket: WebSocket, upstream) -> None:
    tasks = [asyncio.create_task(_pump_client_to_upstream(websocket, upstream)), asyncio.create_task(_pump_upstream_to_client(websocket, upstream))]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                logger.debug("typst sync relay ended: %s", exc)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()

async def _close_quietly(websocket: WebSocket, code: int, reason: str = "") -> None:
    try:
        if websocket.client_state is WebSocketState.CONNECTING:
            await websocket.close(code=code, reason=reason[:120])
        elif websocket.client_state is WebSocketState.CONNECTED:
            await websocket.close(code=code, reason=reason[:120])
    except Exception:
        pass


def setup_typst_sync_routes():
    router = APIRouter(prefix="/api/workspace/typst", tags=["typst-sync"])

    @router.post("/session")
    def start_session(request: Request, body: TypstSessionStart):
        from routes.workspace_routes import _resolve_workspace_file
        root, target = _resolve_workspace_file(request, body.project_id, body.path)
        if os.path.splitext(target)[1].lower() != ".typ":
            raise HTTPException(400, "Only .typ files support preview sync")
        if not tinymist_path():
            raise HTTPException(503, "The `tinymist` binary was not found on PATH.")
        from src.auth_helpers import require_user
        owner = require_user(request)
        rel = body.path.strip().replace("\\", "/").lstrip("/")
        try:
            session = preview_manager().acquire(owner=owner, project_id=body.project_id, rel_path=rel, root=root, abs_path=target, mode=body.mode)
        except TypstPreviewError as exc:
            raise HTTPException(503, str(exc)) from exc
        out = session.public()
        out["frame_url"] = f"{_FRAME_PATH}"
        out["tinymist_version"] = tinymist_version()
        return out

    @router.delete("/session")
    async def stop_session(request: Request, body: TypstSessionStop):
        from src.auth_helpers import require_user
        owner = require_user(request)
        session = preview_manager().get_by_token(body.token, owner)
        if session is None:
            return {"ok": True, "released": False}
        session.touch()
        await _drop_control_bridge(body.token)
        return {"ok": True, "released": True}

    @router.post("/sync/command")
    async def control_command(request: Request, body: TypstControlCommand):
        from src.auth_helpers import require_user
        owner = require_user(request)
        session = preview_manager().get_by_token(body.token, owner)
        if session is None or not session.is_alive():
            raise HTTPException(410, "Preview session is no longer available")
        translated = _outbound_event(session, body.payload)
        if translated is None:
            raise HTTPException(400, "Unsupported preview sync command")
        await _control_bridge(session).send(translated)
        return {"ok": True}

    @router.get("/sync/events")
    async def control_events(request: Request, token: str = Query(...), after: int = Query(default=0, ge=0)):
        from src.auth_helpers import require_user
        owner = require_user(request)
        session = preview_manager().get_by_token(token, owner)
        if session is None or not session.is_alive():
            raise HTTPException(410, "Preview session is no longer available")
        return await _control_bridge(session).events_since(after)

    _FRAME_HTML: Optional[str] = None

    @router.get("/frame")
    async def preview_frame(request: Request):
        nonlocal _FRAME_HTML
        if _FRAME_HTML is None:
            frame_path = os.path.join(os.path.dirname(__file__), "..", "static", "preview-frame.html")
            try:
                with open(frame_path, "r", encoding="utf-8") as fh:
                    _FRAME_HTML = fh.read()
            except OSError:
                raise HTTPException(500, "Preview frame template not found")
        return Response(content=_FRAME_HTML, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"})

    @router.websocket("/sync/control")
    async def sync_control(websocket: WebSocket, token: str = Query(default="")):
        session = _resolve_session(websocket, token)
        if session is None:
            await _close_quietly(websocket, 4401, "Not authorised")
            return
        if not session.is_alive():
            await _close_quietly(websocket, 4503, "Preview process is not running")
            return
        close_code = 1000
        close_reason = ""
        lease_manager = preview_manager()
        attached = False
        try:
            async with _connect_upstream(f"ws://{session.control_addr}/") as upstream:
                await websocket.accept()
                lease_manager.attach(session)
                attached = True
                async def browser_to_tinymist():
                    while True:
                        raw = await websocket.receive_text()
                        if len(raw) > _WS_MAX_MESSAGE_BYTES:
                            return
                        try:
                            payload = json.loads(raw)
                        except (ValueError, TypeError):
                            continue
                        if not isinstance(payload, dict) or "event" not in payload:
                            continue
                        translated = _outbound_event(session, payload)
                        if translated is None:
                            continue
                        session.touch()
                        await upstream.send(json.dumps(translated) + "\n")
                async def tinymist_to_browser():
                    buffer = ""
                    async for chunk in upstream:
                        if isinstance(chunk, (bytes, bytearray)):
                            chunk = chunk.decode("utf-8", errors="replace")
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                payload = json.loads(line)
                            except (ValueError, TypeError):
                                continue
                            if not isinstance(payload, dict):
                                continue
                            safe = _inbound_event(session, payload)
                            if safe is None:
                                continue
                            await websocket.send_text(json.dumps(safe))
                        if len(buffer) > _WS_MAX_MESSAGE_BYTES:
                            return
                tasks = [asyncio.create_task(browser_to_tinymist()), asyncio.create_task(tinymist_to_browser())]
                try:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        if task.cancelled():
                            continue
                        exc = task.exception()
                        if exc and not isinstance(exc, WebSocketDisconnect):
                            raise exc
                finally:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            close_code = 1011
            close_reason = "Preview control channel unavailable"
            logger.info("typst control-plane relay failed: %s", exc)
        finally:
            if attached:
                lease_manager.release(session)
            else:
                session.touch()
            await _close_quietly(websocket, close_code, close_reason)

    return router
