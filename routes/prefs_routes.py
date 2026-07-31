"""User preferences API — per-user key/value store backed by a JSON file."""
import json
import os
from typing import Optional
from fastapi import APIRouter, HTTPException, Request
from src.auth_helpers import get_current_user
from src.constants import USER_PREFS_FILE
from src.tool_security import owner_is_admin_or_single_user

PREFS_FILE = USER_PREFS_FILE
_WORKSPACE_ROOT_PREF_KEYS = frozenset({"workspace-root", "workspace_root"})


def _load():
    """Load the raw prefs file (internal use only)."""
    try:
        with open(PREFS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(prefs):
    os.makedirs(os.path.dirname(PREFS_FILE) or ".", exist_ok=True)
    tmp = f"{PREFS_FILE}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prefs, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PREFS_FILE)


def _load_for_user(user: Optional[str] = None) -> dict:
    """Load preferences for a specific user."""
    all_prefs = _load()
    if "_users" in all_prefs:
        if user is None:
            # Auth disabled — return first user's prefs for backward compat
            users = all_prefs["_users"]
            return dict(next(iter(users.values()), {}))
        return dict(all_prefs["_users"].get(user, {}))
    # Legacy flat format — return as-is
    return dict(all_prefs)


def _save_for_user(user: Optional[str], prefs: dict):
    """Save preferences for a specific user."""
    all_prefs = _load()
    if user is None:
        # Auth disabled. If the store is already multi-user (e.g. auth was
        # turned off on a deployment that previously ran multi-user), writing
        # `prefs` flat would overwrite the whole `_users` map and destroy every
        # other user's preferences. Instead write back into the same (first)
        # slot _load_for_user(None) reads from, preserving the others.
        if "_users" in all_prefs:
            users = all_prefs["_users"]
            first_key = next(iter(users), None)
            if first_key is not None:
                users[first_key] = prefs
                _save(all_prefs)
                return
        _save(prefs)
        return
    if "_users" not in all_prefs:
        all_prefs = {"_users": {}}
    all_prefs["_users"][user] = prefs
    _save(all_prefs)


def _workspace_root_value(body: dict):
    """Return the explicitly supplied root value without accepting ambiguity."""
    if not isinstance(body, dict):
        raise HTTPException(422, "Request body must be an object")
    if "path" in body:
        return body["path"]
    if "value" in body:  # aligns with the generic /api/prefs/{key} shape
        return body["value"]
    if body.get("clear") is True:
        return None
    raise HTTPException(422, "Provide path (or value), or clear: true")


def _validate_workspace_root(value) -> str:
    """Canonicalize an administrator-selected directory without echoing paths."""
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(422, "Workspace root must be an existing absolute directory")
    raw = os.path.expanduser(value.strip())
    if not os.path.isabs(raw):
        raise HTTPException(422, "Workspace root must be an existing absolute directory")
    resolved = os.path.realpath(raw)
    # Reuse the existing workspace policy: no sensitive directory and never
    # permit the filesystem root, which would dissolve project confinement.
    from src.tool_execution import vet_workspace
    if vet_workspace(resolved) != resolved:
        raise HTTPException(422, "Workspace root must be an existing safe directory")
    return resolved


def setup_prefs_routes():
    router = APIRouter(prefix="/api/prefs", tags=["preferences"])

    # Declare this static endpoint before /{key}; router matching is ordered.
    @router.get("/workspace-root")
    async def get_workspace_root(request: Request):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            # Do not reveal whether a root is stored to non-administrators.
            raise HTTPException(403, "Workspace root configuration is admin-only")
        prefs = _load_for_user(owner)
        value = prefs.get("workspace_root")
        path = value if isinstance(value, str) and value else None
        return {"key": "workspace-root", "value": path, "path": path}

    @router.put("/workspace-root")
    async def set_workspace_root(request: Request, body: dict):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            # Gate before validation so an unprivileged caller gets no path oracle.
            raise HTTPException(403, "Workspace root configuration is admin-only")
        value = _workspace_root_value(body)
        prefs = _load_for_user(owner)
        if value is None:
            prefs.pop("workspace_root", None)
            _save_for_user(owner, prefs)
            return {"key": "workspace-root", "value": None, "path": None}
        path = _validate_workspace_root(value)
        prefs["workspace_root"] = path
        _save_for_user(owner, prefs)
        return {"key": "workspace-root", "value": path, "path": path}

    @router.get("")
    async def get_all_prefs(request: Request):
        user = get_current_user(request)
        prefs = _load_for_user(user)
        # The root is a host path.  The dedicated endpoint has the required
        # admin gate, so do not let a general preference dump become a leak.
        if not owner_is_admin_or_single_user(user):
            prefs.pop("workspace_root", None)
        return prefs

    @router.get("/{key}")
    async def get_pref(request: Request, key: str):
        if key in _WORKSPACE_ROOT_PREF_KEYS:
            raise HTTPException(404, "Preference not found")
        user = get_current_user(request)
        prefs = _load_for_user(user)
        return {"key": key, "value": prefs.get(key)}

    @router.put("/{key}")
    async def set_pref(request: Request, key: str, body: dict):
        if key in _WORKSPACE_ROOT_PREF_KEYS:
            raise HTTPException(404, "Preference not found")
        user = get_current_user(request)
        prefs = _load_for_user(user)
        prefs[key] = body.get("value")
        _save_for_user(user, prefs)
        return {"key": key, "value": prefs[key]}

    return router
