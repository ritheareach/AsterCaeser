"""Owner-scoped workspace, project, and project-file routes.

Each project binds one existing local directory.  File operations remain
owner-checked and confined to that project's canonical directory; there is no
additional global workspace-root gate.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel
try:  # Keep the module importable on the project's older Pydantic installs.
    from pydantic import ConfigDict
except ImportError:  # pragma: no cover - exercised only on Pydantic v1
    ConfigDict = None

from core.database import Project, Session as ChatSession, SessionLocal, Workspace
from src.auth_helpers import get_current_user, require_user
from src.tool_security import owner_is_admin_or_single_user

logger = logging.getLogger(__name__)

_MAX_BROWSE_DIRS = 500
_MAX_LIST_ENTRIES = 500
_MAX_GREP_FILES = 1_000
_MAX_GREP_RESULTS = 500
_MAX_TEXT_FILE_BYTES = 1_000_000
_MAX_WRITE_BYTES = 1_000_000
_MAX_NAME_LENGTH = 120
_MAX_DESCRIPTION_LENGTH = 10_000
_MAX_SYMBOL_FILES = 1_000
_MAX_SYMBOL_RESULTS = 200
_MAX_SYMBOL_LINE_CHARS = 400
_MAX_COMPLETION_SELECTION_CHARS = 4_000
_MAX_COMPLETION_FILE_CONTEXT_CHARS = 12_000
_MAX_COMPLETION_EDGE_CONTEXT_CHARS = 4_000
_MAX_TYPST_CONTENT_BYTES = 1_000_000
_MAX_TYPST_PAGES = 20
# SVG embeds can legitimately be large for report-style documents containing
# diagrams, vector plots, or raster figures.  These limits are applied only to
# the temporary project-bound preview response; they are high enough for real
# technical reports while still bounding memory and browser transfer size.
_MAX_TYPST_PAGE_BYTES = 16_000_000
_MAX_TYPST_TOTAL_BYTES = 64_000_000
_TYPST_TIMEOUT_SECONDS = 20


class WorkspaceCreate(BaseModel):
    name: str
    description: str = ""


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    path: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    path: Optional[str] = None


class FileList(BaseModel):
    path: str = ""


class FileRead(BaseModel):
    path: str


class FileWrite(BaseModel):
    path: str
    content: str


class FileCreate(BaseModel):
    path: str
    type: str = "file"


class FileDelete(BaseModel):
    path: str


class FileRename(BaseModel):
    path: str
    new_name: str


class GrepQuery(BaseModel):
    query: str
    regex: bool = False
    case_sensitive: bool = False
    glob: Optional[str] = None
    max_results: int = 200


class ReplaceQuery(BaseModel):
    query: str
    replacement: str
    regex: bool = False
    case_sensitive: bool = False
    glob: Optional[str] = None


class SymbolQuery(BaseModel):
    """A bounded, language-agnostic symbol lookup within one project."""
    query: str
    mode: str = "all"  # all | definition | reference
    path: Optional[str] = None
    max_results: int = 100


class CompletionRequest(BaseModel):
    """Context-only completion contract; filesystem paths are intentionally absent."""
    prefix: str = ""
    suffix: str = ""
    selected_text: str = ""
    current_file_context: str = ""
    language: Optional[str] = None

    if ConfigDict is not None:
        model_config = ConfigDict(extra="forbid")
    else:  # pragma: no cover - Pydantic v1 compatibility
        class Config:
            extra = "forbid"


class TypstPreviewRequest(BaseModel):
    workspace_id: str
    project_id: str
    path: str
    content: str


def _owner(request: Request) -> str:
    """Require an authenticated caller, retaining explicit single-user mode."""
    return require_user(request)


def _authenticate_terminal_websocket(websocket: WebSocket) -> None:
    """Attach the authenticated browser user to a terminal WebSocket.

    Starlette's ``BaseHTTPMiddleware`` deliberately runs only for HTTP scopes,
    so the normal cookie-auth middleware cannot populate ``state.current_user``
    on a WebSocket upgrade.  The browser does send its same-origin session
    cookie with the upgrade, however.  Validate that cookie here before the
    existing owner and project checks run.

    In explicitly anonymous/first-run modes we leave state untouched and let
    ``require_user`` preserve its existing, loopback-safe behavior.
    """
    if getattr(websocket.state, "current_user", None):
        return
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        return

    auth_manager = getattr(websocket.app.state, "auth_manager", None)
    if auth_manager is None or not getattr(auth_manager, "is_configured", False):
        return

    # Import locally to avoid coupling route setup order to the auth router.
    from routes.auth_routes import SESSION_COOKIE

    token = websocket.cookies.get(SESSION_COOKIE)
    if not auth_manager.validate_token(token):
        raise HTTPException(401, "Not authenticated")
    user = auth_manager.get_username_for_token(token)
    if not user:
        raise HTTPException(401, "Not authenticated")
    websocket.state.current_user = user
    websocket.state.api_token = False


def _owner_query(query, model, owner: str):
    """Exact owners in multi-user mode; retain old anonymous rows locally only."""
    if owner:
        return query.filter(model.owner == owner)
    # Older workspace_routes versions wrote __system__; content routes use NULL.
    # They are compatible only in explicitly anonymous/single-user operation.
    return query.filter((model.owner == None) | (model.owner == "__system__"))  # noqa: E711


def _new_owner(owner: str) -> Optional[str]:
    return owner or None


def _field_set(body: BaseModel, field: str) -> bool:
    fields = getattr(body, "model_fields_set", None)
    if fields is None:  # pydantic v1
        fields = getattr(body, "__fields_set__", set())
    return field in fields


def _name(value: str) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "Name must be a string")
    value = value.strip()
    if not value or len(value) > _MAX_NAME_LENGTH:
        raise HTTPException(422, f"Name must be between 1 and {_MAX_NAME_LENGTH} characters")
    return value


def _description(value: str) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "Description must be a string")
    if len(value) > _MAX_DESCRIPTION_LENGTH:
        raise HTTPException(422, "Description is too long")
    return value


def _get_workspace_or_404(db, wid: str, owner: str) -> Workspace:
    workspace = _owner_query(db.query(Workspace).filter(Workspace.id == wid), Workspace, owner).first()
    if not workspace:
        raise HTTPException(404, "Workspace not found")
    return workspace


def _get_project_or_404(project_id: str, owner: str, workspace_id: Optional[str] = None):
    """Return a project and open DB session after validating owner and parent.

    The optional workspace_id is used by every canonical project endpoint.  The
    public Typst resolver has no workspace id in its historical URL, so it
    still verifies the project's actual parent workspace here.
    """
    db = SessionLocal()
    try:
        project = _owner_query(db.query(Project).filter(Project.id == project_id), Project, owner).first()
        if not project or (workspace_id is not None and project.workspace_id != workspace_id):
            raise HTTPException(404, "Project not found")
        _get_workspace_or_404(db, project.workspace_id, owner)
        return project, db
    except Exception:
        db.close()
        raise


def _inside(root: str, target: str) -> bool:
    try:
        return os.path.commonpath((root, target)) == root
    except ValueError:
        return False


def _validate_project_path(path: str, owner: str) -> str:
    if not owner_is_admin_or_single_user(owner):
        raise HTTPException(403, "Only an administrator can bind a project directory")
    if not isinstance(path, str) or not path.strip():
        raise HTTPException(422, "Project path must be a non-empty absolute directory")
    expanded = os.path.expanduser(path.strip())
    if not os.path.isabs(expanded):
        raise HTTPException(422, "Project path must be absolute")
    target = os.path.realpath(expanded)
    from src.tool_execution import vet_workspace
    if vet_workspace(target) != target:
        raise HTTPException(422, "Project path must be an existing non-sensitive directory")
    return target


def _resolve_project_root(project: Project, owner: Optional[str] = None) -> str:
    path = project.path or ""
    if not path:
        raise HTTPException(400, "Project has no filesystem path bound")
    root = os.path.realpath(os.path.expanduser(path))
    from src.tool_execution import vet_workspace
    if vet_workspace(root) != root:
        raise HTTPException(400, "Project path does not exist or is not available")
    return root


def _symlink_component(root: str, target: str) -> bool:
    """Reject symlink components instead of attempting to reason about races."""
    relative = os.path.relpath(target, root)
    if relative == ".":
        return False
    current = root
    for part in relative.split(os.sep):
        current = os.path.join(current, part)
        if os.path.islink(current):
            return True
    return False


def _safe_path(project_root: str, relative_path: str, *, allow_root: bool = False) -> str:
    """Resolve a relative project path without traversal or symlink escapes."""
    if not isinstance(relative_path, str) or "\x00" in relative_path:
        raise HTTPException(422, "Path must be a string")
    relative_path = relative_path.strip()
    if os.path.isabs(relative_path):
        raise HTTPException(403, "Absolute paths are not allowed")
    parts = Path(relative_path).parts
    if any(part == ".." for part in parts):
        raise HTTPException(403, "Path traversal is not allowed")
    target = os.path.normpath(os.path.join(project_root, relative_path))
    canonical = os.path.realpath(target)
    if not _inside(project_root, canonical):
        raise HTTPException(403, "Path traversal or symlink escape is not allowed")
    if _symlink_component(project_root, target):
        raise HTTPException(403, "Symlink paths are not allowed")
    if not allow_root and canonical == project_root:
        raise HTTPException(403, "The project root cannot be modified")
    return target


def _project_file(request: Request, wid: str, pid: str, path: str, *, allow_root: bool = False):
    owner = _owner(request)
    project, db = _get_project_or_404(pid, owner, wid)
    try:
        root = _resolve_project_root(project, owner)
        return root, _safe_path(root, path, allow_root=allow_root)
    finally:
        db.close()


def _resolve_workspace_file(request: Request, project_id: str, path: str):
    """Public compatibility resolver used by the Typst sync routes.

    Its legacy signature lacks ``wid``.  It nevertheless requires the caller
    to own both the project and the project's actual parent workspace.
    """
    owner = _owner(request)
    project, db = _get_project_or_404(project_id, owner)
    try:
        root = _resolve_project_root(project, owner)
        return root, _safe_path(root, path)
    finally:
        db.close()


def _text_file(path: str) -> str:
    try:
        size = os.stat(path).st_size
    except OSError:
        raise HTTPException(404, "File not found")
    if size > _MAX_TEXT_FILE_BYTES:
        raise HTTPException(413, "File is too large")
    try:
        raw = Path(path).read_bytes()
    except OSError:
        raise HTTPException(404, "File not found")
    if b"\0" in raw:
        raise HTTPException(400, "Binary files are not supported")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "Binary files are not supported")


def _binary_or_oversized(path: str, size: int) -> bool:
    """Cheap bounded test used by the tree as well as search."""
    if size > _MAX_TEXT_FILE_BYTES:
        return True
    try:
        with open(path, "rb") as file:
            return b"\0" in file.read(8192)
    except OSError:
        return True


def _glob_matches(pattern: Optional[str], relative_path: str) -> bool:
    if not pattern:
        return True
    if not isinstance(pattern, str) or "\x00" in pattern or os.path.isabs(pattern):
        raise HTTPException(403, "Invalid file glob")
    parts = Path(pattern).parts
    if any(part == ".." for part in parts):
        raise HTTPException(403, "Invalid file glob")
    normalized = relative_path.replace(os.sep, "/")
    return fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(os.path.basename(relative_path), pattern)


def _grep_pattern(query: str, regex: bool, case_sensitive: bool):
    if not isinstance(query, str) or not query:
        raise HTTPException(422, "Search query is required")
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(query if regex else re.escape(query), flags)
    except re.error as exc:
        raise HTTPException(422, f"Invalid regex: {exc}")


def _symbol_line_kind(line: str, symbol: str) -> Optional[str]:
    """Classify a common source definition; all other word hits are references."""
    word = re.escape(symbol)
    definition = re.compile(
        rf"^\s*(?:(?:export\s+|pub\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|trait|fn|func)\s+{word}\b|"
        rf"(?:export\s+)?(?:const|let|var)\s+{word}\s*=)",
    )
    if definition.search(line):
        return "definition"
    if re.search(rf"\b{word}\b", line):
        return "reference"
    return None


def _symbol_files(root: str, target: str):
    """Yield bounded, visible regular files below an already-safe target."""
    if os.path.isfile(target):
        yield target
        return
    if not os.path.isdir(target):
        raise HTTPException(404, "Symbol search path not found")
    seen = 0
    for directory, dirs, files in os.walk(target, followlinks=False):
        dirs[:] = [
            name for name in dirs
            if not name.startswith(".")
            and name not in {"node_modules", "venv", ".venv", "__pycache__", "dist", "build"}
            and not os.path.islink(os.path.join(directory, name))
        ]
        for filename in files:
            if filename.startswith("."):
                continue
            path = os.path.join(directory, filename)
            if os.path.islink(path):
                continue
            seen += 1
            if seen > _MAX_SYMBOL_FILES:
                return
            yield path


def _completion_context_is_bounded(body: CompletionRequest) -> None:
    limits = {
        "prefix": _MAX_COMPLETION_EDGE_CONTEXT_CHARS,
        "suffix": _MAX_COMPLETION_EDGE_CONTEXT_CHARS,
        "selected_text": _MAX_COMPLETION_SELECTION_CHARS,
        "current_file_context": _MAX_COMPLETION_FILE_CONTEXT_CHARS,
    }
    for field, maximum in limits.items():
        value = getattr(body, field)
        if not isinstance(value, str) or len(value) > maximum:
            raise HTTPException(413, f"{field} exceeds the completion context limit")


def _resize_terminal(process, cols, rows) -> bool:
    """Best-effort Unix PTY resize; pipe-backed terminals receive stdin resize control.

    Some deployments wrap the child streams in a PTY and expose its master fd
    as ``_pty_master_fd``.  On macOS where terminal_bridge.py is used,
    resize control commands are sent via stdin control sequences.
    """
    if isinstance(cols, bool) or isinstance(rows, bool):
        return False
    if not isinstance(cols, int) or not isinstance(rows, int):
        return False
    if not 20 <= cols <= 500 or not 5 <= rows <= 200:
        return False

    fd = getattr(process, "_pty_master_fd", None)
    if isinstance(fd, int):
        try:
            import fcntl
            import struct
            import termios
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            if hasattr(process, "pid") and process.pid:
                try:
                    import signal
                    os.kill(process.pid, signal.SIGWINCH)
                except OSError:
                    pass
            return True
        except (ImportError, OSError, ValueError):
            return False

    if process and getattr(process, "stdin", None) and not process.stdin.is_closing():
        try:
            process.stdin.write(f"\x1bAsterResize:{cols}:{rows}\n".encode())
            return True
        except Exception:
            return False

    return False


async def _start_terminal_process(shell: str, root: str):
    """Start an isolated interactive shell for the browser terminal.

    On macOS, attaching a WebSocket handler directly to a PTY can block the
    Uvicorn event loop after the terminal emits its first resize/input frame.
    A small child bridge owns the shell PTY while AsterCaeser communicates
    through asyncio pipes, keeping the web application responsive. Other
    platforms retain the direct PTY path.
    """
    environment = {**os.environ, "TERM": "xterm-256color"}
    shell_path = str(shell or "/bin/bash")
    shell_name = os.path.basename(shell_path).lower()
    command = [shell_path, "-i"] if shell_name in {"sh", "bash", "zsh", "fish", "ksh", "dash"} else [shell_path]

    if sys.platform == "darwin":
        # The bridge gives the shell a real PTY, but only exposes normal pipes
        # to this process.  BSD ``script`` cannot be used here because it
        # rejects a pipe-backed stdin with ``tcgetattr ... not supported``.
        bridge = os.path.join(os.path.dirname(os.path.dirname(__file__)), "src", "terminal_bridge.py")
        return await asyncio.create_subprocess_exec(
            sys.executable, bridge, shell_path, root,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=root,
            env=environment,
            start_new_session=True,
        )

    try:
        import pty
        master_fd, slave_fd = pty.openpty()
    except (ImportError, OSError):
        return await asyncio.create_subprocess_exec(
            *command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            cwd=root, env=environment,
        )
    try:
        process = await asyncio.create_subprocess_exec(
            *command, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            cwd=root, env=environment, start_new_session=True,
        )
    except Exception:
        os.close(master_fd)
        raise
    finally:
        os.close(slave_fd)
    # Kept on the Process object so read/write/resize have one trusted fd.
    process._pty_master_fd = master_fd
    return process


async def _terminal_write(process, data: bytes) -> None:
    fd = getattr(process, "_pty_master_fd", None)
    if isinstance(fd, int):
        await asyncio.to_thread(os.write, fd, data)
        return
    if process.stdin is None:
        raise OSError("Terminal stdin is unavailable")
    process.stdin.write(data)
    await process.stdin.drain()


async def _terminal_read(process) -> bytes:
    fd = getattr(process, "_pty_master_fd", None)
    if isinstance(fd, int):
        return await asyncio.to_thread(os.read, fd, 4096)
    if process.stdout is None:
        return b""
    return await process.stdout.read(4096)


def _close_terminal_pty(process) -> None:
    fd = getattr(process, "_pty_master_fd", None)
    if isinstance(fd, int):
        try:
            os.close(fd)
        except OSError:
            pass
        process._pty_master_fd = None


active_sessions = {}

async def run_session_reader(session_id: str):
    session = active_sessions.get(session_id)
    if not session:
        return
    process = session["process"]
    try:
        while True:
            try:
                data = await _terminal_read(process)
            except OSError:
                break
            if not data:
                break
            
            # Save history
            session["output_history"].extend(data)
            if len(session["output_history"]) > 100000:
                session["output_history"] = session["output_history"][-100000:]
                
            # Broadcast to active WebSocket
            ws = session.get("ws")
            if ws:
                try:
                    await ws.send_bytes(data)
                except Exception:
                    session["ws"] = None
    finally:
        # Cleanup session when process exits
        if session_id in active_sessions:
            del active_sessions[session_id]
        if process.stdin:
            try:
                process.stdin.close()
            except Exception:
                pass
        _close_terminal_pty(process)
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


def setup_workspace_routes():
    router = APIRouter(prefix="/api/workspace", tags=["workspace"])

    # These must be registered before /{wid}; Starlette uses declaration order.
    @router.get("/browse")
    def browse(request: Request, path: str = Query(default="")):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(403, "Workspace browsing is admin-only")

        # Browsing is an administrator-only convenience for selecting a
        # project directory.  It deliberately has no persisted global root:
        # each subsequent file request is confined to the selected project.
        target = os.path.realpath(os.path.expanduser(path.strip() or "~"))
        if not os.path.isdir(target):
            target = os.path.realpath(os.path.expanduser("~"))
        dirs = []
        try:
            with os.scandir(target) as entries:
                for entry in entries:
                    if len(dirs) >= _MAX_BROWSE_DIRS + 1:
                        break
                    try:
                        if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                            dirs.append({"name": entry.name, "path": entry.path})
                    except OSError:
                        continue
        except (OSError, PermissionError):
            pass
        dirs.sort(key=lambda item: item["name"].lower())
        from src.tool_execution import vet_workspace
        parent = os.path.dirname(target)
        return {
            "path": target,
            "parent": parent if parent != target else None,
            "dirs": dirs[:_MAX_BROWSE_DIRS],
            "truncated": len(dirs) > _MAX_BROWSE_DIRS,
            "selectable": vet_workspace(target) is not None,
        }

    @router.get("/vet")
    def vet(request: Request, path: str = Query(default="")):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(403, "Workspace selection is admin-only")
        from src.tool_execution import vet_workspace
        try:
            resolved = _validate_project_path(path, owner)
        except HTTPException:
            resolved = None
        return {"ok": resolved is not None, "path": resolved}

    @router.get("")
    def list_workspaces(request: Request):
        owner = _owner(request)
        db = SessionLocal()
        try:
            workspaces = _owner_query(db.query(Workspace), Workspace, owner).order_by(Workspace.name).all()
            return {"workspaces": [workspace.to_dict() for workspace in workspaces]}
        finally:
            db.close()

    @router.post("")
    def create_workspace(request: Request, body: WorkspaceCreate):
        owner = _owner(request)
        db = SessionLocal()
        try:
            workspace = Workspace(
                id=str(uuid.uuid4()), name=_name(body.name), description=_description(body.description), owner=_new_owner(owner)
            )
            db.add(workspace)
            db.commit()
            db.refresh(workspace)
            return workspace.to_dict()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @router.get("/{wid}/project")
    def list_projects(request: Request, wid: str):
        owner = _owner(request)
        db = SessionLocal()
        try:
            _get_workspace_or_404(db, wid, owner)
            projects = _owner_query(db.query(Project).filter(Project.workspace_id == wid), Project, owner).order_by(Project.name).all()
            return {"projects": [project.to_dict() for project in projects]}
        finally:
            db.close()

    @router.post("/{wid}/project")
    def create_project(request: Request, wid: str, body: ProjectCreate):
        owner = _owner(request)
        db = SessionLocal()
        try:
            _get_workspace_or_404(db, wid, owner)
            path = _validate_project_path(body.path, owner) if body.path is not None else None
            project = Project(
                id=str(uuid.uuid4()), workspace_id=wid, name=_name(body.name),
                description=_description(body.description), path=path, owner=_new_owner(owner),
            )
            db.add(project)
            db.commit()
            db.refresh(project)
            return project.to_dict()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @router.get("/{wid}/project/{pid}")
    def get_project(request: Request, wid: str, pid: str):
        owner = _owner(request)
        project, db = _get_project_or_404(pid, owner, wid)
        try:
            return project.to_dict()
        finally:
            db.close()

    @router.put("/{wid}/project/{pid}")
    def update_project(request: Request, wid: str, pid: str, body: ProjectUpdate):
        owner = _owner(request)
        project, db = _get_project_or_404(pid, owner, wid)
        try:
            if _field_set(body, "name"):
                project.name = _name(body.name or "")
            if _field_set(body, "description"):
                project.description = _description(body.description or "")
            if _field_set(body, "path"):
                project.path = _validate_project_path(body.path, owner) if body.path is not None else None
            db.commit()
            db.refresh(project)
            return project.to_dict()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @router.delete("/{wid}/project/{pid}")
    def delete_project(request: Request, wid: str, pid: str):
        owner = _owner(request)
        project, db = _get_project_or_404(pid, owner, wid)
        try:
            db.delete(project)
            db.commit()
            return {"ok": True}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @router.get("/{wid}/project/{pid}/chats")
    def list_project_chats(request: Request, wid: str, pid: str):
        owner = _owner(request)
        _, db = _get_project_or_404(pid, owner, wid)
        try:
            chats = _owner_query(db.query(ChatSession).filter(ChatSession.project_id == pid), ChatSession, owner)
            return {"chats": [chat.to_dict() for chat in chats.order_by(ChatSession.last_accessed.desc()).all()]}
        finally:
            db.close()

    @router.post("/{wid}/project/{pid}/files/list")
    def list_files(request: Request, wid: str, pid: str, body: FileList):
        root, target = _project_file(request, wid, pid, body.path, allow_root=True)
        if not os.path.isdir(target):
            raise HTTPException(404, "Directory not found")
        entries = []
        try:
            with os.scandir(target) as scanned:
                for entry in scanned:
                    if len(entries) >= _MAX_LIST_ENTRIES:
                        break
                    if entry.name in {".git", "node_modules", "__pycache__"} or entry.is_symlink():
                        continue
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if not is_dir and _binary_or_oversized(entry.path, stat.st_size):
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": os.path.relpath(entry.path, root),
                        "type": "dir" if is_dir else "file",
                        "size": 0 if is_dir else stat.st_size,
                        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    })
        except PermissionError:
            raise HTTPException(403, "Permission denied")
        entries.sort(key=lambda item: (item["type"] != "dir", item["name"].lower()))
        return {"entries": entries, "path": body.path.strip(), "truncated": len(entries) >= _MAX_LIST_ENTRIES}

    @router.post("/{wid}/project/{pid}/files/read")
    def read_file(request: Request, wid: str, pid: str, body: FileRead):
        root, target = _project_file(request, wid, pid, body.path)
        if not os.path.isfile(target):
            raise HTTPException(404, "File not found")
        stat = os.stat(target)
        return {"content": _text_file(target), "path": os.path.relpath(target, root), "version": f"{stat.st_mtime_ns}:{stat.st_size}"}

    @router.post("/{wid}/project/{pid}/files/stat")
    def stat_file(request: Request, wid: str, pid: str, body: FileRead):
        """Return a small file revision marker for the editor's change watcher."""
        root, target = _project_file(request, wid, pid, body.path)
        if not os.path.isfile(target):
            raise HTTPException(404, "File not found")
        stat = os.stat(target)
        return {"path": os.path.relpath(target, root), "version": f"{stat.st_mtime_ns}:{stat.st_size}"}

    @router.post("/{wid}/project/{pid}/files/write")
    def write_file(request: Request, wid: str, pid: str, body: FileWrite):
        root, target = _project_file(request, wid, pid, body.path)
        encoded = body.content.encode("utf-8")
        if len(encoded) > _MAX_WRITE_BYTES:
            raise HTTPException(413, "File content is too large")
        if not os.path.isdir(os.path.dirname(target)):
            raise HTTPException(409, "Parent directory does not exist")
        if os.path.exists(target) and not os.path.isfile(target):
            raise HTTPException(409, "Path is not a file")
        try:
            with open(target, "x" if not os.path.exists(target) else "w", encoding="utf-8") as file:
                file.write(body.content)
        except OSError as exc:
            raise HTTPException(500, f"Failed to write file: {exc}")
        stat = os.stat(target)
        return {"ok": True, "path": os.path.relpath(target, root), "version": f"{stat.st_mtime_ns}:{stat.st_size}"}

    @router.post("/{wid}/project/{pid}/files/create")
    def create_file(request: Request, wid: str, pid: str, body: FileCreate):
        root, target = _project_file(request, wid, pid, body.path)
        if body.type not in {"file", "dir"}:
            raise HTTPException(422, "type must be 'file' or 'dir'")
        if os.path.lexists(target):
            raise HTTPException(409, "Path already exists")
        if not os.path.isdir(os.path.dirname(target)):
            raise HTTPException(409, "Parent directory does not exist")
        try:
            if body.type == "dir":
                os.mkdir(target)
            else:
                Path(target).touch(exist_ok=False)
        except OSError as exc:
            raise HTTPException(500, f"Failed to create path: {exc}")
        return {"ok": True, "path": os.path.relpath(target, root), "type": body.type}

    @router.delete("/{wid}/project/{pid}/files/delete")
    def delete_file(request: Request, wid: str, pid: str, body: FileDelete):
        root, target = _project_file(request, wid, pid, body.path)
        if not os.path.lexists(target):
            raise HTTPException(404, "Path not found")
        try:
            if os.path.isdir(target):
                os.rmdir(target)  # deliberately refuses non-empty directories
            else:
                os.unlink(target)
        except OSError as exc:
            if os.path.isdir(target):
                raise HTTPException(409, "Directory is not empty")
            raise HTTPException(500, f"Failed to delete path: {exc}")
        return {"ok": True, "path": os.path.relpath(target, root)}

    @router.post("/{wid}/project/{pid}/files/rename")
    def rename_file(request: Request, wid: str, pid: str, body: FileRename):
        root, source = _project_file(request, wid, pid, body.path)
        name = body.new_name.strip() if isinstance(body.new_name, str) else ""
        if not name or name in {".", ".."} or os.path.basename(name) != name or "/" in name or "\\" in name or "\x00" in name:
            raise HTTPException(422, "new_name must be a basename")
        if not os.path.lexists(source):
            raise HTTPException(404, "Source not found")
        target = _safe_path(root, os.path.relpath(os.path.join(os.path.dirname(source), name), root))
        if os.path.lexists(target):
            raise HTTPException(409, "Destination already exists")
        try:
            os.rename(source, target)
        except OSError as exc:
            raise HTTPException(500, f"Failed to rename path: {exc}")
        return {"ok": True, "path": os.path.relpath(target, root)}

    @router.post("/{wid}/project/{pid}/files/grep")
    def grep_files(request: Request, wid: str, pid: str, body: GrepQuery):
        root, _ = _project_file(request, wid, pid, "", allow_root=True)
        pattern = _grep_pattern(body.query, body.regex, body.case_sensitive)
        maximum = min(max(int(body.max_results), 1), _MAX_GREP_RESULTS)
        results, files_seen = [], 0
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if name not in {".git", "node_modules", "__pycache__"} and not os.path.islink(os.path.join(directory, name))]
            for filename in files:
                if files_seen >= _MAX_GREP_FILES:
                    return {"results": results, "total": len(results), "truncated": True}
                if filename in {".git", "node_modules", "__pycache__"}:
                    continue
                path = os.path.join(directory, filename)
                if os.path.islink(path):
                    continue
                relative = os.path.relpath(path, root)
                if not _glob_matches(body.glob, relative):
                    continue
                files_seen += 1
                try:
                    content = _text_file(path)
                except HTTPException:
                    continue
                for number, line in enumerate(content.splitlines(), 1):
                    if pattern.search(line):
                        results.append({"path": relative, "line": number, "line_number": number, "content": line})
                        if len(results) >= maximum:
                            return {"results": results, "total": len(results), "truncated": True}
        return {"results": results, "total": len(results), "truncated": False}

    @router.post("/{wid}/project/{pid}/files/replace")
    def replace_files(request: Request, wid: str, pid: str, body: ReplaceQuery):
        root, _ = _project_file(request, wid, pid, "", allow_root=True)
        pattern = _grep_pattern(body.query, body.regex, body.case_sensitive)
        replaced, files_changed, files_seen = 0, [], 0
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if name not in {".git", "node_modules", "__pycache__"} and not os.path.islink(os.path.join(directory, name))]
            for filename in files:
                if files_seen >= _MAX_GREP_FILES:
                    return {"ok": True, "replaced": replaced, "files": files_changed, "truncated": True}
                if filename in {".git", "node_modules", "__pycache__"}:
                    continue
                path = os.path.join(directory, filename)
                if os.path.islink(path):
                    continue
                relative = os.path.relpath(path, root)
                if not _glob_matches(body.glob, relative):
                    continue
                files_seen += 1
                try:
                    content = _text_file(path)
                except HTTPException:
                    continue
                changed, count = pattern.subn(body.replacement, content)
                if count:
                    if len(changed.encode("utf-8")) > _MAX_WRITE_BYTES:
                        continue
                    with open(path, "w", encoding="utf-8") as file:
                        file.write(changed)
                    replaced += count
                    files_changed.append({"path": relative, "replacements": count})
        return {"ok": True, "replaced": replaced, "files": files_changed, "truncated": False}

    @router.post("/{wid}/project/{pid}/symbols/search")
    def search_symbols(request: Request, wid: str, pid: str, body: SymbolQuery):
        """Find definitions and references without leaving the project root."""
        if not isinstance(body.query, str) or not body.query.strip() or len(body.query.strip()) > 200:
            raise HTTPException(422, "Symbol query must be between 1 and 200 characters")
        symbol = body.query.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", symbol):
            raise HTTPException(422, "Symbol query must be an identifier")
        mode = body.mode.strip().lower() if isinstance(body.mode, str) else ""
        if mode not in {"all", "definition", "reference"}:
            raise HTTPException(422, "mode must be all, definition, or reference")
        maximum = min(max(int(body.max_results), 1), _MAX_SYMBOL_RESULTS)
        root, target = _project_file(request, wid, pid, body.path or "", allow_root=True)
        results, truncated = [], False
        for path in _symbol_files(root, target):
            try:
                content = _text_file(path)
            except HTTPException:
                # Binary and oversized files are intentionally invisible to
                # symbol lookup, matching grep/file-read safety policy.
                continue
            for line_number, line in enumerate(content.splitlines(), 1):
                kind = _symbol_line_kind(line, symbol)
                if not kind or (mode != "all" and kind != mode):
                    continue
                results.append({
                    "path": os.path.relpath(path, root),
                    "line_number": line_number,
                    "content": line[:_MAX_SYMBOL_LINE_CHARS],
                    "kind": kind,
                })
                if len(results) >= maximum:
                    truncated = True
                    break
            if truncated:
                break
        return {"results": results, "total": len(results), "truncated": truncated}

    @router.post("/{wid}/project/{pid}/completion")
    def completion_availability(request: Request, wid: str, pid: str, body: CompletionRequest):
        """AI Copilot code completion provider endpoint."""
        owner = _owner(request)
        _, db = _get_project_or_404(pid, owner, wid)
        try:
            _completion_context_is_bounded(body)
        finally:
            db.close()

        prefix = body.prefix or ""
        suffix = body.suffix or ""
        lang = body.language or "python"

        completion_text = ""

        # Primary: local Ollama with Qwen2.5-Coder-0.5B (lightweight FIM model)
        try:
            import json, urllib.request

            OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
            fim_prompt = f"<|fim_prefix|>{prefix[-1200:]}<|fim_suffix|>{suffix[:300]}<|fim_middle|>"
            req_payload = json.dumps({
                "model": "qwen2.5-coder:0.5b",
                "prompt": fim_prompt,
                "stream": False,
                "options": {"num_predict": 64, "temperature": 0.1, "stop": ["<|endoftext|>", "<|fim_end|>"]}
            }).encode('utf-8')
            http_req = urllib.request.Request(OLLAMA_URL, data=req_payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(http_req, timeout=5) as resp:
                res = json.loads(resp.read().decode('utf-8'))
                completion_text = res.get("response", "").replace("```python", "```").replace("```", "").strip("\r\n")
        except Exception:
            pass

        # Fallback: enabled ModelEndpoints from DB
        if not completion_text:
            try:
                from core.database import ModelEndpoint
                from src.auth_helpers import owner_filter
                from src.ai_interaction import resolve_endpoint_runtime, build_chat_url, build_headers
                import httpx

                q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
                if owner:
                    q = owner_filter(q, ModelEndpoint, owner)
                endpoints = q.all()
                for ep in endpoints:
                    try:
                        base, api_key = resolve_endpoint_runtime(ep, owner=owner)
                        chat_url = build_chat_url(base)
                        headers = build_headers(api_key, base)
                        prompt = f"Complete the code snippet at <CURSOR>. Output ONLY the exact code to insert at <CURSOR>. No markdown fences, no explanations.\n\nLanguage: {lang}\nContext:\n{prefix[-1200:]}<CURSOR>{suffix[:300]}"
                        resp = httpx.post(chat_url, headers=headers, json={
                            "model": ep.default_model or "qwen2.5-coder",
                            "messages": [{"role": "user", "content": prompt}],
                            "max_tokens": 120, "temperature": 0.2
                        }, timeout=3.0)
                        if resp.status_code == 200:
                            choices = resp.json().get("choices", [])
                            if choices:
                                completion_text = choices[0].get("message", {}).get("content", "").replace("```", "").strip("\r\n")
                                if completion_text:
                                    break
                    except Exception:
                        continue
            except Exception:
                pass

        if completion_text:
            return JSONResponse(status_code=200, content={"available": True, "completion": completion_text})

        return JSONResponse(
            status_code=503,
            content={
                "available": False,
                "reason": "No policy-safe project completion service is configured.",
            },
        )

    @router.post("/typst/preview")
    def preview_typst(request: Request, body: TypstPreviewRequest):
        """Compile caller-provided Typst into temporary, project-confined SVGs."""
        if not isinstance(body.path, str) or not body.path.strip().lower().endswith(".typ"):
            raise HTTPException(422, "Typst preview requires a relative .typ path")
        if not isinstance(body.content, str) or len(body.content.encode("utf-8")) > _MAX_TYPST_CONTENT_BYTES:
            raise HTTPException(413, "Typst source exceeds the preview limit")
        # This checks authentication, project ownership, parent workspace, the
        # persisted root policy, and relative/symlink-safe path handling.  The
        # real project file is intentionally never written by preview.
        root, target = _project_file(request, body.workspace_id, body.project_id, body.path)
        typst = shutil.which("typst")
        if not typst:
            return JSONResponse(
                status_code=503,
                content={"ok": False, "message": "Typst CLI is not available on this server."},
            )

        # Keep generated pages in a uniquely named hidden directory below the
        # approved project root.  The source itself is a temporary *sibling*
        # of the requested document: Typst resolves relative imports from the
        # source file's directory, so compiling from a detached temp directory
        # broke otherwise valid ``#import "shared.typ"`` documents.
        source_parent = os.path.dirname(target)
        source = os.path.join(
            source_parent,
            f".{Path(target).name}.astercaeser-preview-{uuid.uuid4().hex}.typ",
        )
        with tempfile.TemporaryDirectory(prefix=".astercaeser-typst-", dir=source_parent) as temporary:
            output_pattern = os.path.join(temporary, "page-{p}.svg")
            try:
                with open(source, "x", encoding="utf-8") as file:
                    file.write(body.content)
                completed = subprocess.run(
                    [typst, "compile", "--root", root, "--format", "svg", source, output_pattern],
                    cwd=temporary,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=_TYPST_TIMEOUT_SECONDS,
                    check=False,
                )
                if completed.returncode != 0:
                    # Compiler stderr often contains source excerpts and absolute
                    # temporary paths; do not surface either through this API.
                    return JSONResponse(
                        status_code=422,
                        content={"ok": False, "message": "Typst could not compile this document."},
                    )

                outputs = sorted(
                    Path(temporary).glob("page-*.svg"),
                    key=lambda p: int(re.search(r"page-(\d+)", p.name).group(1))
                )
                if not outputs or len(outputs) > _MAX_TYPST_PAGES:
                    return JSONResponse(
                        status_code=422,
                        content={"ok": False, "message": "Typst did not produce a supported SVG preview."},
                    )
                pages, total = [], 0
                try:
                    for output in outputs:
                        size = output.stat().st_size
                        if size > _MAX_TYPST_PAGE_BYTES or total + size > _MAX_TYPST_TOTAL_BYTES:
                            return JSONResponse(
                                status_code=413,
                                content={"ok": False, "message": "Typst preview output exceeds the limit."},
                            )
                        svg = output.read_text(encoding="utf-8")
                        if "<svg" not in svg[:1024].lower():
                            return JSONResponse(
                                status_code=422,
                                content={"ok": False, "message": "Typst did not produce a supported SVG preview."},
                            )
                        pages.append(svg)
                        total += size
                except (OSError, UnicodeDecodeError):
                    return JSONResponse(
                        status_code=422,
                        content={"ok": False, "message": "Typst did not produce a readable SVG preview."},
                    )
                return {"ok": True, "pages": pages}
            except subprocess.TimeoutExpired:
                return JSONResponse(
                    status_code=504,
                    content={"ok": False, "message": "Typst preview timed out."},
                )
            except OSError:
                return JSONResponse(
                    status_code=503,
                    content={"ok": False, "message": "Typst preview could not start."},
                )
            finally:
                try:
                    os.remove(source)
                except FileNotFoundError:
                    pass
                except OSError:
                    logger.warning("Could not remove temporary Typst source")

    @router.websocket("/{wid}/project/{pid}/terminal")
    async def terminal(websocket: WebSocket, wid: str, pid: str):
        # Do all authentication, ownership and filesystem checks before accept.
        try:
            _authenticate_terminal_websocket(websocket)
            owner = _owner(websocket)
            project, db = _get_project_or_404(pid, owner, wid)
            try:
                root = _resolve_project_root(project, owner)
            finally:
                db.close()
        except HTTPException:
            await websocket.close(code=1008)
            return
        except Exception:
            logger.exception("Terminal authorization failed")
            await websocket.close(code=1011)
            return

        session_id = websocket.query_params.get("session_id", f"{pid}-default")

        try:
            await websocket.accept()
        except Exception:
            return

        # Check if session exists and is alive
        session = active_sessions.get(session_id)
        if session and session["process"].returncode is not None:
            session = None
            if session_id in active_sessions:
                del active_sessions[session_id]

        if not session:
            try:
                shell = shutil.which("fish") or os.environ.get("SHELL") or "/bin/bash"
                process = await _start_terminal_process(shell, root)
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"Failed to start shell: {exc}"})
                await websocket.close()
                return

            session = {
                "process": process,
                "output_history": bytearray(),
                "ws": websocket,
                "cols": 80,
                "rows": 24,
                "shell": shell,
            }
            active_sessions[session_id] = session
            asyncio.create_task(run_session_reader(session_id))
            _resize_terminal(session["process"], session["cols"], session["rows"])
        else:
            session["ws"] = websocket
            if session["output_history"]:
                await websocket.send_bytes(bytes(session["output_history"]))
            _resize_terminal(session["process"], session["cols"], session["rows"])

        # Send shell name to client
        shell = session.get("shell") or shutil.which("fish") or os.environ.get("SHELL") or "/bin/bash"
        shell_name = os.path.basename(shell)
        try:
            await websocket.send_json({"type": "init", "shell": shell_name})
        except Exception:
            pass

        try:
            while True:
                message = await websocket.receive()
                if message.get("bytes") is not None:
                    await _terminal_write(session["process"], message["bytes"])
                elif message.get("text"):
                    try:
                        payload = json.loads(message["text"])
                    except (json.JSONDecodeError, TypeError, ValueError):
                        payload = None
                    if isinstance(payload, dict):
                        if payload.get("type") == "input" and isinstance(payload.get("data"), str):
                            await _terminal_write(session["process"], payload["data"].encode())
                        elif payload.get("type") == "resize":
                            session["cols"] = payload.get("cols", session["cols"])
                            session["rows"] = payload.get("rows", session["rows"])
                            _resize_terminal(session["process"], session["cols"], session["rows"])
                        elif payload.get("type") == "kill":
                            process = session["process"]
                            if session_id in active_sessions:
                                del active_sessions[session_id]
                            if process.stdin:
                                try: process.stdin.close()
                                except Exception: pass
                            _close_terminal_pty(process)
                            if process.returncode is None:
                                process.terminate()
                            break
                    elif isinstance(message["text"], str):
                        await _terminal_write(session["process"], message["text"].encode())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            if session_id in active_sessions and active_sessions[session_id]["ws"] == websocket:
                active_sessions[session_id]["ws"] = None
            try:
                await websocket.close()
            except Exception:
                pass

    # Keep this catch-all LAST so /browse and /vet cannot be shadowed.
    @router.get("/{wid}")
    def get_workspace(request: Request, wid: str):
        owner = _owner(request)
        db = SessionLocal()
        try:
            return _get_workspace_or_404(db, wid, owner).to_dict()
        finally:
            db.close()

    @router.put("/{wid}")
    def update_workspace(request: Request, wid: str, body: WorkspaceUpdate):
        owner = _owner(request)
        db = SessionLocal()
        try:
            workspace = _get_workspace_or_404(db, wid, owner)
            if _field_set(body, "name"):
                workspace.name = _name(body.name or "")
            if _field_set(body, "description"):
                workspace.description = _description(body.description or "")
            db.commit()
            db.refresh(workspace)
            return workspace.to_dict()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @router.delete("/{wid}")
    def delete_workspace(request: Request, wid: str):
        owner = _owner(request)
        db = SessionLocal()
        try:
            workspace = _get_workspace_or_404(db, wid, owner)
            db.delete(workspace)
            db.commit()
            return {"ok": True}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    return router
