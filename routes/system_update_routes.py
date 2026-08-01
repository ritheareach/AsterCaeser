"""Read-only system update status for the Settings panel."""

from __future__ import annotations

import subprocess
import os
import sys
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from core.constants import BASE_DIR
from src.auth_helpers import get_current_user
from src.tool_security import owner_is_admin_or_single_user

DEFAULT_UPSTREAM_URL = "https://github.com/odysseus-dev/odysseus.git"


class SystemUpdateAction(BaseModel):
    action: str
    commit: Optional[str] = None


def _git(root: str, *args: str, timeout: int = 30):
    try:
        result = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(500, f"Git command failed: {exc}") from exc
    if result.returncode:
        raise HTTPException(400, result.stderr.strip() or result.stdout.strip() or "Git command failed.")
    return result.stdout.strip()


def _conflicts(root: str):
    return [line for line in _git(root, "diff", "--name-only", "--diff-filter=U").splitlines() if line]


def _run_tests(root: str):
    python = os.path.join(root, "venv", "bin", "python")
    if not os.path.isfile(python):
        python = sys.executable
    try:
        result = subprocess.run(
            [python, "-m", "pytest", "-q"], cwd=root,
            capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(500, f"Test run failed: {exc}") from exc
    output = (result.stdout + "\n" + result.stderr).strip()[-12000:]
    return result.returncode == 0, output


def _upstream_commits(root: str, limit: int = 100):
    raw = _git(root, "log", f"--max-count={limit}", "--format=%H%x09%h%x09%s", "HEAD..FETCH_HEAD")
    commits = []
    for line in raw.splitlines():
        full, short, subject = (line.split("\t", 2) + ["", "", ""])[:3]
        if not full:
            continue
        files = _git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", full).splitlines()
        commits.append({"hash": full, "short": short, "subject": subject, "files": files[:200]})
    return commits


def setup_system_update_routes() -> APIRouter:
    router = APIRouter(tags=["system-update"])

    @router.get("/api/system-update/status")
    async def system_update_status(request: Request):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(403, "Admin only")

        root = str(BASE_DIR)
        upstream_url = os.getenv("ASTERCAESER_UPSTREAM_URL", DEFAULT_UPSTREAM_URL).strip()
        try:
            status = subprocess.run(
                ["git", "status", "--short", "--branch"],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            remotes = subprocess.run(
                ["git", "remote", "-v"],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(500, f"Could not inspect the repository: {exc}") from exc

        if status.returncode != 0:
            raise HTTPException(500, status.stderr.strip() or "AsterCaeser is not a Git repository.")
        try:
            upstream = subprocess.run(
                ["git", "ls-remote", upstream_url, "HEAD"],
                cwd=root, capture_output=True, text=True, timeout=20,
            )
            upstream_available = upstream.returncode == 0 and bool(upstream.stdout.strip())
            upstream_error = "" if upstream_available else (upstream.stderr.strip() or "Unable to reach upstream.")
        except (OSError, subprocess.TimeoutExpired) as exc:
            upstream_available = False
            upstream_error = str(exc)
        return {
            "ok": True,
            "root": root,
            "status": status.stdout.strip(),
            "remotes": remotes.stdout.strip(),
            "upstream_url": upstream_url,
            "upstream_available": upstream_available,
            "upstream_error": upstream_error,
            "branch": status.stdout.splitlines()[0] if status.stdout else "",
            "conflicts": _conflicts(root),
        }

    @router.post("/api/system-update/action")
    async def system_update_action(request: Request, body: SystemUpdateAction):
        owner = get_current_user(request)
        if not owner_is_admin_or_single_user(owner):
            raise HTTPException(403, "Admin only")
        root = str(BASE_DIR)
        action = body.action.strip().lower()
        upstream_url = os.getenv("ASTERCAESER_UPSTREAM_URL", DEFAULT_UPSTREAM_URL).strip()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

        if action == "fetch":
            _git(root, "fetch", upstream_url, "main", timeout=120)
            commits = _upstream_commits(root)
            return {"ok": True, "phase": "fetched", "commits": commits,
                    "message": f"Found {len(commits)} upstream commit(s) not in this repository."}

        if action == "checkpoint":
            dirty = bool(_git(root, "status", "--porcelain"))
            if dirty:
                _git(root, "add", "-A")
                _git(root, "commit", "-m", "Checkpoint before Odysseus system update")
            backup = f"astercaeser-backup-{stamp}"
            _git(root, "branch", backup, "HEAD")
            return {"ok": True, "message": f"Backup checkpoint created: {backup}", "branch": backup}

        if action == "prepare":
            if _git(root, "status", "--porcelain"):
                raise HTTPException(409, "Create a backup checkpoint first; the working tree must be clean.")
            _git(root, "fetch", upstream_url, "main", timeout=120)
            target = (body.commit or "FETCH_HEAD").strip()
            if target != "FETCH_HEAD":
                if not all(c in "0123456789abcdefABCDEF" for c in target) or len(target) < 7:
                    raise HTTPException(400, "Invalid upstream commit selected.")
                _git(root, "cat-file", "-e", f"{target}^{{commit}}")
            review = f"astercaeser-update-{stamp}"
            _git(root, "switch", "-c", review)
            try:
                _git(root, "merge", "--no-commit", "--no-ff", target, timeout=120)
            except HTTPException:
                conflicts = _conflicts(root)
                if conflicts:
                    return {"ok": True, "phase": "conflicts", "branch": review, "conflicts": conflicts,
                            "message": "Conflicts found. Review them before applying the update."}
                raise
            return {"ok": True, "phase": "ready", "branch": review,
                    "message": "Update prepared on a review branch. Review and apply when ready."}

        if action == "apply":
            conflicts = _conflicts(root)
            if conflicts:
                raise HTTPException(409, f"Resolve conflicts first: {', '.join(conflicts)}")
            passed, test_output = _run_tests(root)
            if not passed:
                raise HTTPException(409, f"Tests failed. Update was not applied.\n{test_output}")
            _git(root, "commit", "-m", "Merge Odysseus upstream updates")
            return {"ok": True, "phase": "applied", "message": "Tests passed and the update was applied on the review branch."}

        if action == "test":
            if _conflicts(root):
                raise HTTPException(409, "Resolve conflicts before running tests.")
            passed, test_output = _run_tests(root)
            if not passed:
                raise HTTPException(409, f"Tests failed.\n{test_output}")
            return {"ok": True, "phase": "tested", "message": "All tests passed.", "output": test_output}

        if action == "abort":
            _git(root, "merge", "--abort")
            return {"ok": True, "phase": "aborted", "message": "Update merge aborted. Your backup branch is preserved."}

        raise HTTPException(400, "Unknown system update action.")

    return router
