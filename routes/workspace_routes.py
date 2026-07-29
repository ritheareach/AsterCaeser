"""Workspace & Project API — CRUD, file operations, grep, terminal, and directory browsing."""
import asyncio
import fnmatch
import json
import logging
import os
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from core.database import SessionLocal, Workspace, Project, Session as ChatSession
from src.auth_helpers import get_current_user
from src.tool_security import owner_is_admin_or_single_user

logger = logging.getLogger(__name__)

_MAX_BROWSE_DIRS = 500


# ── Pydantic schemas ──

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
    workspace_id: str

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    path: Optional[str] = None

class FileWrite(BaseModel):
    path: str
    content: str

class FileCreate(BaseModel):
    path: str
    type: str = "file"  # "file" or "dir"

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


# ── Helpers ──

def _owner(request: Request) -> str:
    user = get_current_user(request)
    return user or "__system__"


def _get_project_or_404(project_id: str, owner: str):
    db = SessionLocal()
    try:
        p = db.query(Project).filter(Project.id == project_id, Project.owner == owner).first()
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        return p, db
    except HTTPException:
        db.close()
        raise
    except Exception:
        db.close()
        raise


def _resolve_project_root(project: Project) -> str:
    root = project.path or ""
    if not root:
        raise HTTPException(status_code=400, detail="Project has no filesystem path bound")
    root = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root):
        raise HTTPException(status_code=400, detail=f"Project path does not exist: {root}")
    return root


def _safe_path(project_root: str, relative_path: str) -> str:
    abs_path = os.path.abspath(os.path.join(project_root, relative_path))
    if not abs_path.startswith(os.path.abspath(project_root) + os.sep) and abs_path != os.path.abspath(project_root):
        raise HTTPException(status_code=403, detail="Path traversal is not allowed")
    return abs_path


def _walk_files(root: str, glob_pattern: Optional[str] = None, max_results: int = 500):
    matches = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden directories
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            if fname.startswith("."):
                continue
            if glob_pattern and not fnmatch(fname, glob_pattern):
                continue
            fpath = os.path.join(dirpath, fname)
            rel = os.path.relpath(fpath, root)
            matches.append(rel)
            if len(matches) >= max_results:
                return matches
    return matches


def setup_workspace_routes():
    router = APIRouter(prefix="/api/workspace", tags=["workspace"])

    # ═══════════════════════════════════════════════════════════
    #  WORKSPACE CRUD
    # ═══════════════════════════════════════════════════════════

    @router.get("")
    def list_workspaces(request: Request):
        user = _owner(request)
        db = SessionLocal()
        try:
            q = db.query(Workspace).filter(Workspace.owner == user).order_by(Workspace.name)
            return {"workspaces": [w.to_dict() for w in q.all()]}
        finally:
            db.close()

    @router.post("")
    def create_workspace(request: Request, body: WorkspaceCreate):
        user = _owner(request)
        db = SessionLocal()
        try:
            w = Workspace(id=str(uuid.uuid4()), name=body.name, description=body.description, owner=user)
            db.add(w)
            db.commit()
            db.refresh(w)
            return w.to_dict()
        finally:
            db.close()

    @router.get("/{wid}")
    def get_workspace(request: Request, wid: str):
        user = _owner(request)
        db = SessionLocal()
        try:
            w = db.query(Workspace).filter(Workspace.id == wid, Workspace.owner == user).first()
            if not w:
                raise HTTPException(404, "Workspace not found")
            return w.to_dict()
        finally:
            db.close()

    @router.put("/{wid}")
    def update_workspace(request: Request, wid: str, body: WorkspaceUpdate):
        user = _owner(request)
        db = SessionLocal()
        try:
            w = db.query(Workspace).filter(Workspace.id == wid, Workspace.owner == user).first()
            if not w:
                raise HTTPException(404, "Workspace not found")
            if body.name is not None:
                w.name = body.name
            if body.description is not None:
                w.description = body.description
            db.commit()
            db.refresh(w)
            return w.to_dict()
        finally:
            db.close()

    @router.delete("/{wid}")
    def delete_workspace(request: Request, wid: str):
        user = _owner(request)
        db = SessionLocal()
        try:
            w = db.query(Workspace).filter(Workspace.id == wid, Workspace.owner == user).first()
            if not w:
                raise HTTPException(404, "Workspace not found")
            db.delete(w)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    # ═══════════════════════════════════════════════════════════
    #  PROJECT CRUD
    # ═══════════════════════════════════════════════════════════

    @router.get("/{wid}/project")
    def list_projects(request: Request, wid: str):
        user = _owner(request)
        db = SessionLocal()
        try:
            q = db.query(Project).filter(Project.workspace_id == wid, Project.owner == user).order_by(Project.name)
            return {"projects": [p.to_dict() for p in q.all()]}
        finally:
            db.close()

    @router.post("/{wid}/project")
    def create_project(request: Request, wid: str, body: ProjectCreate):
        user = _owner(request)
        db = SessionLocal()
        try:
            p = Project(
                id=str(uuid.uuid4()),
                workspace_id=wid,
                name=body.name,
                description=body.description,
                path=body.path,
                owner=user,
            )
            db.add(p)
            db.commit()
            db.refresh(p)
            return p.to_dict()
        finally:
            db.close()

    @router.get("/{wid}/project/{pid}")
    def get_project(request: Request, wid: str, pid: str):
        user = _owner(request)
        db = SessionLocal()
        try:
            p = db.query(Project).filter(Project.id == pid, Project.owner == user).first()
            if not p:
                raise HTTPException(404, "Project not found")
            d = p.to_dict()
            # Enrich with file stats if path bound
            if p.path and os.path.isdir(p.path):
                file_count = 0
                dir_count = 0
                for root, dirs, files in os.walk(p.path):
                    dir_count += len(dirs)
                    file_count += len(files)
                d["file_count"] = file_count
                d["dir_count"] = dir_count
            return d
        finally:
            db.close()

    @router.put("/{wid}/project/{pid}")
    def update_project(request: Request, wid: str, pid: str, body: ProjectUpdate):
        user = _owner(request)
        db = SessionLocal()
        try:
            p = db.query(Project).filter(Project.id == pid, Project.owner == user).first()
            if not p:
                raise HTTPException(404, "Project not found")
            if body.name is not None:
                p.name = body.name
            if body.description is not None:
                p.description = body.description
            if body.path is not None:
                p.path = body.path
            db.commit()
            db.refresh(p)
            return p.to_dict()
        finally:
            db.close()

    @router.delete("/{wid}/project/{pid}")
    def delete_project(request: Request, wid: str, pid: str):
        user = _owner(request)
        db = SessionLocal()
        try:
            p = db.query(Project).filter(Project.id == pid, Project.owner == user).first()
            if not p:
                raise HTTPException(404, "Project not found")
            db.delete(p)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    # ═══════════════════════════════════════════════════════════
    #  PROJECT CHATS
    # ═══════════════════════════════════════════════════════════

    @router.get("/{wid}/project/{pid}/chats")
    def list_project_chats(request: Request, wid: str, pid: str):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        try:
            chats = db.query(ChatSession).filter(
                ChatSession.project_id == pid,
                ChatSession.owner == user,
            ).order_by(ChatSession.last_accessed.desc()).all()
            return {"chats": [c.to_dict() for c in chats]}
        finally:
            db.close()

    # ═══════════════════════════════════════════════════════════
    #  FILE OPERATIONS
    # ═══════════════════════════════════════════════════════════

    @router.post("/{wid}/project/{pid}/files/list")
    def list_files(request: Request, wid: str, pid: str, body: dict):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        rel_path = body.get("path", "")
        target = _safe_path(root, rel_path)

        if not os.path.isdir(target):
            raise HTTPException(400, "Not a directory")

        entries = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                        st = entry.stat()
                        entries.append({
                            "name": entry.name,
                            "path": os.path.relpath(os.path.join(target, entry.name), root),
                            "type": "dir" if is_dir else "file",
                            "size": st.st_size if not is_dir else 0,
                            "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                        })
                    except OSError:
                        continue
        except PermissionError:
            raise HTTPException(403, "Permission denied")

        entries.sort(key=lambda e: (0 if e["type"] == "dir" else 1, e["name"].lower()))
        return {"entries": entries, "path": rel_path}

    @router.post("/{wid}/project/{pid}/files/read")
    def read_file(request: Request, wid: str, pid: str, body: FileWrite):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        target = _safe_path(root, body.path)

        if not os.path.isfile(target):
            raise HTTPException(404, "File not found")

        try:
            with open(target, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            return {"content": content, "path": body.path}
        except Exception as e:
            raise HTTPException(500, f"Failed to read file: {e}")

    @router.post("/{wid}/project/{pid}/files/write")
    def write_file(request: Request, wid: str, pid: str, body: FileWrite):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        target = _safe_path(root, body.path)

        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            with open(target, "w", encoding="utf-8") as f:
                f.write(body.content)
            return {"ok": True, "path": body.path}
        except Exception as e:
            raise HTTPException(500, f"Failed to write file: {e}")

    @router.post("/{wid}/project/{pid}/files/create")
    def create_file(request: Request, wid: str, pid: str, body: FileCreate):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        target = _safe_path(root, body.path)

        if os.path.exists(target):
            raise HTTPException(400, "Path already exists")

        try:
            if body.type == "dir":
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                Path(target).touch()
            return {"ok": True, "path": body.path, "type": body.type}
        except Exception as e:
            raise HTTPException(500, f"Failed to create: {e}")

    @router.post("/{wid}/project/{pid}/files/delete")
    def delete_file(request: Request, wid: str, pid: str, body: FileDelete):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        target = _safe_path(root, body.path)

        if not os.path.exists(target):
            raise HTTPException(404, "Path not found")

        try:
            if os.path.isdir(target):
                import shutil
                shutil.rmtree(target)
            else:
                os.remove(target)
            return {"ok": True, "path": body.path}
        except Exception as e:
            raise HTTPException(500, f"Failed to delete: {e}")

    @router.post("/{wid}/project/{pid}/files/rename")
    def rename_file(request: Request, wid: str, pid: str, body: FileRename):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)
        src = _safe_path(root, body.path)
        dst = os.path.join(os.path.dirname(src), body.new_name)

        if not os.path.exists(src):
            raise HTTPException(404, "Source not found")
        if os.path.exists(dst):
            raise HTTPException(400, "Destination already exists")

        try:
            os.rename(src, dst)
            rel = os.path.relpath(dst, root)
            return {"ok": True, "path": rel}
        except Exception as e:
            raise HTTPException(500, f"Failed to rename: {e}")

    # ═══════════════════════════════════════════════════════════
    #  GREP / SEARCH
    # ═══════════════════════════════════════════════════════════

    @router.post("/{wid}/project/{pid}/files/grep")
    def grep_files(request: Request, wid: str, pid: str, body: GrepQuery):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)

        results = []
        flags = 0 if body.case_sensitive else re.IGNORECASE
        try:
            pattern = re.compile(body.query, flags) if body.regex else re.compile(re.escape(body.query), flags)
        except re.error as e:
            raise HTTPException(400, f"Invalid regex: {e}")

        for dirpath, dirnames, fnames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in fnames:
                if fname.startswith("."):
                    continue
                if body.glob:
                    import fnmatch
                    if not fnmatch.fnmatch(fname, body.glob):
                        continue
                fpath = os.path.join(dirpath, fname)
                rel = os.path.relpath(fpath, root)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        for i, line in enumerate(f, 1):
                            if pattern.search(line):
                                results.append({
                                    "path": rel,
                                    "line": i,
                                    "content": line.rstrip("\n"),
                                })
                                if len(results) >= body.max_results:
                                    return {"results": results, "total": len(results), "truncated": True}
                except (OSError, UnicodeDecodeError):
                    continue

        return {"results": results, "total": len(results), "truncated": False}

    @router.post("/{wid}/project/{pid}/files/replace")
    def replace_files(request: Request, wid: str, pid: str, body: ReplaceQuery):
        user = _owner(request)
        p, db = _get_project_or_404(pid, user)
        db.close()
        root = _resolve_project_root(p)

        flags = 0 if body.case_sensitive else re.IGNORECASE
        try:
            pattern = re.compile(body.query, flags) if body.regex else re.compile(re.escape(body.query), flags)
        except re.error as e:
            raise HTTPException(400, f"Invalid regex: {e}")

        replaced = 0
        files_changed = []

        for dirpath, dirnames, fnames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in fnames:
                if fname.startswith("."):
                    continue
                if body.glob:
                    import fnmatch
                    if not fnmatch.fnmatch(fname, body.glob):
                        continue
                fpath = os.path.join(dirpath, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                    new_content, count = pattern.subn(body.replacement, content)
                    if count > 0:
                        with open(fpath, "w", encoding="utf-8") as f:
                            f.write(new_content)
                        replaced += count
                        rel = os.path.relpath(fpath, root)
                        files_changed.append({"path": rel, "replacements": count})
                except (OSError, UnicodeDecodeError):
                    continue

        return {"ok": True, "replaced": replaced, "files": files_changed}

    # ═══════════════════════════════════════════════════════════
    #  TERMINAL (WebSocket)
    # ═══════════════════════════════════════════════════════════

    @router.websocket("/{wid}/project/{pid}/terminal")
    async def terminal(websocket: WebSocket, wid: str, pid: str):
        await websocket.accept()
        user = None
        try:
            from src.auth_helpers import get_current_user as _auth
            user = _auth(websocket)
        except Exception:
            pass
        if not user:
            try:
                user = websocket.cookies.get("user") or None
            except Exception:
                pass

        db = SessionLocal()
        try:
            q = db.query(Project).filter(Project.id == pid)
            if user:
                q = q.filter(Project.owner == user)
            p = q.first()
            if not p or not p.path:
                await websocket.send_json({"type": "error", "message": "Project not found or no path bound"})
                await websocket.close()
                return
            root = os.path.abspath(os.path.expanduser(p.path))
            if not os.path.isdir(root):
                await websocket.send_json({"type": "error", "message": f"Path does not exist: {root}"})
                await websocket.close()
                return
        finally:
            db.close()

        shell = os.environ.get("SHELL", "/bin/bash")
        try:
            proc = await asyncio.create_subprocess_exec(
                shell,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=root,
                env={**os.environ, "TERM": "xterm-256color"},
            )
        except Exception as e:
            await websocket.send_json({"type": "error", "message": f"Failed to start shell: {e}"})
            await websocket.close()
            return

        async def read_stdout():
            while True:
                line = await proc.stdout.read(4096)
                if not line:
                    break
                await websocket.send_bytes(line)

        async def read_stdin():
            try:
                while True:
                    data = await websocket.receive()
                    if "bytes" in data:
                        proc.stdin.write(data["bytes"])
                        await proc.stdin.drain()
                    elif "text" in data:
                        msg = json.loads(data["text"])
                        if msg.get("type") == "resize":
                            pass
                        elif msg.get("type") == "input":
                            proc.stdin.write(msg["data"].encode())
                            await proc.stdin.drain()
            except WebSocketDisconnect:
                proc.terminate()

        await asyncio.gather(read_stdout(), read_stdin())

    # ═══════════════════════════════════════════════════════════
    #  DIRECTORY BROWSING (existing, preserved)
    # ═══════════════════════════════════════════════════════════

    @router.get("/browse")
    def browse(request: Request, path: str = Query(default="")):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace browsing is admin-only")
        target = os.path.realpath(os.path.expanduser(path.strip() or "~"))
        if not os.path.isdir(target):
            target = os.path.realpath(os.path.expanduser("~"))
        dirs = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                            dirs.append({"name": entry.name, "path": os.path.join(target, entry.name)})
                    except OSError:
                        continue
        except (PermissionError, OSError):
            dirs = []
        dirs_sorted = sorted(dirs, key=lambda d: d["name"].lower())
        truncated = len(dirs_sorted) > _MAX_BROWSE_DIRS
        parent = os.path.dirname(target)
        from src.tool_execution import vet_workspace
        return {
            "path": target,
            "parent": parent if parent and parent != target else None,
            "dirs": dirs_sorted[:_MAX_BROWSE_DIRS],
            "truncated": truncated,
            "selectable": vet_workspace(target) is not None,
        }

    @router.get("/vet")
    def vet(request: Request, path: str = Query(default="")):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(status_code=403, detail="Workspace selection is admin-only")
        from src.tool_execution import vet_workspace
        resolved = vet_workspace(path)
        return {"ok": resolved is not None, "path": resolved}

    return router
