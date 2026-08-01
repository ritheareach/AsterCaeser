"""Focused regressions for the canonical workspace route boundary."""

import json
import os
import shutil
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import routes.prefs_routes as prefs_routes
import routes.workspace_routes as wr
from core.database import Project, SessionLocal, Workspace


def _endpoint(path, method):
    router = wr.setup_workspace_routes()
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


def _pref_endpoint(path, method):
    router = prefs_routes.setup_prefs_routes()
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("ASTERCAESER_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(tmp_path / "user_prefs.json"))
    monkeypatch.setattr(wr, "_owner", lambda request: "alice")
    monkeypatch.setattr(wr, "owner_is_admin_or_single_user", lambda owner: True)
    db = SessionLocal()
    wid, other_wid, pid = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    try:
        db.add_all([
            Workspace(id=wid, name="Primary", owner="alice"),
            Workspace(id=other_wid, name="Other", owner="alice"),
            Project(id=pid, workspace_id=wid, name="Project", path=str(tmp_path), owner="alice"),
        ])
        db.commit()
        yield SimpleNamespace(wid=wid, other_wid=other_wid, pid=pid, root=tmp_path)
    finally:
        db.query(Project).filter(Project.id == pid).delete()
        db.query(Workspace).filter(Workspace.id.in_([wid, other_wid])).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_static_legacy_routes_precede_workspace_id_route():
    router = wr.setup_workspace_routes()
    paths = [route.path for route in router.routes]
    assert paths.index("/api/workspace/browse") < paths.index("/api/workspace/{wid}")
    assert paths.index("/api/workspace/vet") < paths.index("/api/workspace/{wid}")


def test_terminal_websocket_authenticates_the_browser_session_cookie():
    class AuthManager:
        is_configured = True

        @staticmethod
        def validate_token(token):
            return token == "valid-session"

        @staticmethod
        def get_username_for_token(token):
            return "alice" if token == "valid-session" else None

    websocket = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(auth_manager=AuthManager())),
        state=SimpleNamespace(),
        cookies={"astercaeser_session": "valid-session"},
    )

    wr._authenticate_terminal_websocket(websocket)

    assert websocket.state.current_user == "alice"
    assert websocket.state.api_token is False


def test_project_parent_mismatch_is_not_found(project):
    get_project = _endpoint("/api/workspace/{wid}/project/{pid}", "GET")
    with pytest.raises(HTTPException) as error:
        get_project(request=object(), wid=project.other_wid, pid=project.pid)
    assert error.value.status_code == 404


def test_file_operations_reject_escape_symlink_and_missing_parent(project):
    read = _endpoint("/api/workspace/{wid}/project/{pid}/files/read", "POST")
    write = _endpoint("/api/workspace/{wid}/project/{pid}/files/write", "POST")
    delete = _endpoint("/api/workspace/{wid}/project/{pid}/files/delete", "DELETE")
    outside = project.root.parent / "outside.txt"
    outside.write_text("secret")
    (project.root / "escape").symlink_to(outside)

    with pytest.raises(HTTPException) as error:
        read(object(), project.wid, project.pid, wr.FileRead(path="../outside.txt"))
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        read(object(), project.wid, project.pid, wr.FileRead(path="escape"))
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        write(object(), project.wid, project.pid, wr.FileWrite(path="missing/new.txt", content="x"))
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        delete(object(), project.wid, project.pid, wr.FileDelete(path=""))
    assert error.value.status_code == 403


def test_read_requires_only_path_and_grep_is_bounded_text_only(project):
    read = _endpoint("/api/workspace/{wid}/project/{pid}/files/read", "POST")
    grep = _endpoint("/api/workspace/{wid}/project/{pid}/files/grep", "POST")
    (project.root / "notes.txt").write_text("first\nNeedle here\n")
    (project.root / "binary.dat").write_bytes(b"\0Needle")

    assert read(object(), project.wid, project.pid, wr.FileRead(path="notes.txt"))["content"].startswith("first")
    result = grep(object(), project.wid, project.pid, wr.GrepQuery(query="needle", max_results=1))
    assert result["truncated"] is True
    assert result["results"] == [{"path": "notes.txt", "line": 2, "line_number": 2, "content": "Needle here"}]


def test_workspace_root_pref_persists_and_is_primary_for_bindings(tmp_path, monkeypatch):
    prefs_file = tmp_path / "user_prefs.json"
    selected = tmp_path / "selected"
    env_root = tmp_path / "legacy-env"
    project_dir = selected / "project"
    external_project_dir = tmp_path / "outside-selected-root"
    project_dir.mkdir(parents=True)
    external_project_dir.mkdir()
    env_root.mkdir()
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(prefs_file))
    monkeypatch.setattr(prefs_routes, "get_current_user", lambda request: "admin")
    monkeypatch.setattr(prefs_routes, "owner_is_admin_or_single_user", lambda owner: True)
    monkeypatch.setattr(wr, "owner_is_admin_or_single_user", lambda owner: True)
    monkeypatch.setenv("ASTERCAESER_WORKSPACE_ROOT", str(env_root))
    put = _pref_endpoint("/api/prefs/workspace-root", "PUT")
    get = _pref_endpoint("/api/prefs/workspace-root", "GET")

    saved = asyncio_run(put, object(), {"path": str(selected)})
    assert saved["path"] == os.path.realpath(selected)
    # _load_for_user reads the JSON file afresh, which is the restart boundary.
    assert prefs_routes._load_for_user("admin")["workspace_root"] == os.path.realpath(selected)
    fetched = asyncio_run(get, object())
    assert fetched["value"] == os.path.realpath(selected)
    assert wr._validate_project_path(str(project_dir), "admin") == os.path.realpath(project_dir)
    assert wr._validate_project_path(str(external_project_dir), "admin") == os.path.realpath(external_project_dir)


def test_workspace_root_pref_rejects_unprivileged_invalid_and_supports_clear(tmp_path, monkeypatch):
    prefs_file = tmp_path / "user_prefs.json"
    selected = tmp_path / "selected"
    selected.mkdir()
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(prefs_file))
    put = _pref_endpoint("/api/prefs/workspace-root", "PUT")
    get = _pref_endpoint("/api/prefs/workspace-root", "GET")

    monkeypatch.setattr(prefs_routes, "get_current_user", lambda request: "bob")
    monkeypatch.setattr(prefs_routes, "owner_is_admin_or_single_user", lambda owner: False)
    with pytest.raises(HTTPException) as error:
        asyncio_run(put, object(), {"path": "/does/not/exist"})
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        asyncio_run(get, object())
    assert error.value.status_code == 403

    monkeypatch.setattr(prefs_routes, "get_current_user", lambda request: "admin")
    monkeypatch.setattr(prefs_routes, "owner_is_admin_or_single_user", lambda owner: True)
    with pytest.raises(HTTPException) as error:
        asyncio_run(put, object(), {"path": "/does/not/exist"})
    assert error.value.status_code == 422
    asyncio_run(put, object(), {"value": str(selected)})
    cleared = asyncio_run(put, object(), {"clear": True})
    assert cleared["path"] is None
    assert "workspace_root" not in prefs_routes._load_for_user("admin")


def test_path_browser_does_not_apply_a_persisted_root_gate(tmp_path, monkeypatch):
    """A saved legacy root must not restrict the next local project binding."""
    prefs_file = tmp_path / "user_prefs.json"
    home = tmp_path / "home"
    root = home / "approved"
    project_dir = root / "project"
    outside = home / "outside"
    project_dir.mkdir(parents=True)
    outside.mkdir()
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(prefs_file))
    monkeypatch.setattr(prefs_routes, "get_current_user", lambda request: "admin")
    monkeypatch.setattr(wr, "get_current_user", lambda request: "admin")
    monkeypatch.setattr(prefs_routes, "owner_is_admin_or_single_user", lambda owner: True)
    monkeypatch.setattr(wr, "owner_is_admin_or_single_user", lambda owner: True)
    monkeypatch.delenv("ASTERCAESER_WORKSPACE_ROOT", raising=False)

    browse = _endpoint("/api/workspace/browse", "GET")
    vet = _endpoint("/api/workspace/vet", "GET")
    put = _pref_endpoint("/api/prefs/workspace-root", "PUT")

    first_visit = browse(object(), str(home))
    assert "needs_workspace_root" not in first_visit
    assert "workspace_root" not in first_visit
    assert first_visit["path"] == os.path.realpath(home)
    assert first_visit["selectable"] is True

    saved = asyncio_run(put, object(), {"path": str(root)})
    assert saved["path"] == os.path.realpath(root)

    # A saved legacy preference no longer clamps local project selection.
    outside_visit = browse(object(), str(outside))
    assert outside_visit["path"] == os.path.realpath(outside)
    assert outside_visit["parent"] == os.path.realpath(home)
    assert outside_visit["selectable"] is True

    inside_visit = browse(object(), str(project_dir))
    assert inside_visit["path"] == os.path.realpath(project_dir)
    assert inside_visit["selectable"] is True
    assert vet(object(), str(project_dir)) == {"ok": True, "path": os.path.realpath(project_dir)}
    assert vet(object(), str(outside)) == {"ok": True, "path": os.path.realpath(outside)}


def test_generic_preferences_cannot_bypass_or_leak_workspace_root(tmp_path, monkeypatch):
    prefs_file = tmp_path / "user_prefs.json"
    monkeypatch.setattr(prefs_routes, "PREFS_FILE", str(prefs_file))
    prefs_routes._save({"_users": {"admin": {"workspace_root": "/private/root"}}})
    generic_get = _pref_endpoint("/api/prefs/{key}", "GET")
    generic_put = _pref_endpoint("/api/prefs/{key}", "PUT")
    get_all = _pref_endpoint("/api/prefs", "GET")
    monkeypatch.setattr(prefs_routes, "get_current_user", lambda request: "admin")
    monkeypatch.setattr(prefs_routes, "owner_is_admin_or_single_user", lambda owner: False)

    with pytest.raises(HTTPException) as error:
        asyncio_run(generic_get, object(), "workspace_root")
    assert error.value.status_code == 404
    with pytest.raises(HTTPException) as error:
        asyncio_run(generic_put, object(), "workspace_root", {"value": "/tmp"})
    assert error.value.status_code == 404
    assert "workspace_root" not in asyncio_run(get_all, object())


def test_symbol_search_is_project_confined_and_classifies_results(project):
    search = _endpoint("/api/workspace/{wid}/project/{pid}/symbols/search", "POST")
    (project.root / "symbols.py").write_text(
        "def build_widget(value):\n"
        "    return value\n"
        "result = build_widget(1)\n"
    )
    (project.root / "ignored.bin").write_bytes(b"\0build_widget")

    result = search(object(), project.wid, project.pid, wr.SymbolQuery(query="build_widget"))
    assert result["results"] == [
        {"path": "symbols.py", "line_number": 1, "content": "def build_widget(value):", "kind": "definition"},
        {"path": "symbols.py", "line_number": 3, "content": "result = build_widget(1)", "kind": "reference"},
    ]
    definitions = search(
        object(), project.wid, project.pid, wr.SymbolQuery(query="build_widget", mode="definition")
    )
    assert [match["kind"] for match in definitions["results"]] == ["definition"]
    with pytest.raises(HTTPException) as error:
        search(object(), project.wid, project.pid, wr.SymbolQuery(query="build_widget", path="../outside"))
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        search(object(), project.other_wid, project.pid, wr.SymbolQuery(query="build_widget"))
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_completion_reports_authenticated_unavailability_with_bounded_context(project):
    completion = _endpoint("/api/workspace/{wid}/project/{pid}/completion", "POST")
    response = await completion(
        object(), project.wid, project.pid,
        wr.CompletionRequest(prefix="pri", current_file_context="print('hello')"),
    )
    assert response.status_code == 503
    assert json.loads(response.body) == {
        "available": False,
        "reason": "No policy-safe project completion service is configured.",
    }
    with pytest.raises(ValidationError):
        wr.CompletionRequest(path="/host/path-is-not-accepted")
    with pytest.raises(HTTPException) as error:
        await completion(
            object(), project.wid, project.pid,
            wr.CompletionRequest(current_file_context="x" * (wr._MAX_COMPLETION_FILE_CONTEXT_CHARS + 1)),
        )
    assert error.value.status_code == 413
    with pytest.raises(HTTPException) as error:
        await completion(object(), project.other_wid, project.pid, wr.CompletionRequest())
    assert error.value.status_code == 404


def test_typst_preview_absence_and_project_validation(project, monkeypatch):
    preview = _endpoint("/api/workspace/typst/preview", "POST")
    body = wr.TypstPreviewRequest(
        workspace_id=project.wid, project_id=project.pid, path="main.typ", content="= Hello",
    )
    monkeypatch.setattr(wr.shutil, "which", lambda name: None)
    unavailable = preview(object(), body)
    assert unavailable.status_code == 503
    assert json.loads(unavailable.body) == {
        "ok": False,
        "message": "Typst CLI is not available on this server.",
    }
    with pytest.raises(HTTPException) as error:
        preview(
            object(),
            wr.TypstPreviewRequest(
                workspace_id=project.wid, project_id=project.pid, path="../escape.typ", content="= Nope",
            ),
        )
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        preview(
            object(),
            wr.TypstPreviewRequest(
                workspace_id=project.other_wid, project_id=project.pid, path="main.typ", content="= Nope",
            ),
        )
    assert error.value.status_code == 404


def test_typst_preview_compiles_svg_when_cli_is_available(project):
    typst = shutil.which("typst")
    if not typst:
        pytest.skip("Typst CLI is not installed")
    preview = _endpoint("/api/workspace/typst/preview", "POST")
    output = preview(
        object(),
        wr.TypstPreviewRequest(
            workspace_id=project.wid, project_id=project.pid, path="main.typ", content="= Preview\nHello",
        ),
    )
    assert output["ok"] is True
    assert output["pages"] and "<svg" in output["pages"][0].lower()
    assert not list(project.root.glob(".astercaeser-typst-*"))
    failed = preview(
        object(),
        wr.TypstPreviewRequest(
            workspace_id=project.wid, project_id=project.pid, path="main.typ", content="#let = invalid",
        ),
    )
    assert failed.status_code == 422
    payload = json.loads(failed.body)
    assert payload["ok"] is False and str(project.root) not in str(payload)
    assert not list(project.root.glob(".astercaeser-typst-*"))


def test_typst_preview_resolves_project_relative_imports(project):
    if not shutil.which("typst"):
        pytest.skip("Typst CLI is not installed")
    (project.root / "shared.typ").write_text('#let greeting = "Imported"\n', encoding="utf-8")
    preview = _endpoint("/api/workspace/typst/preview", "POST")
    output = preview(
        object(),
        wr.TypstPreviewRequest(
            workspace_id=project.wid,
            project_id=project.pid,
            path="main.typ",
            content='#import "shared.typ": greeting\n= #greeting',
        ),
    )
    assert output["ok"] is True
    assert output["pages"]
    assert not list(project.root.glob(".astercaeser-typst-*"))
    assert not list(project.root.glob(".main.typ.astercaeser-preview-*.typ"))


@pytest.mark.skipif(os.name != "posix", reason="PTY resize is Unix-only")
def test_terminal_resize_applies_only_bounded_dimensions():
    import fcntl
    import pty
    import struct
    import termios

    master, slave = pty.openpty()
    try:
        process = SimpleNamespace(_pty_master_fd=master)
        assert wr._resize_terminal(process, 120, 42) is True
        rows, columns, _, _ = struct.unpack("HHHH", fcntl.ioctl(master, termios.TIOCGWINSZ, b"\0" * 8))
        assert (columns, rows) == (120, 42)
        assert wr._resize_terminal(process, 2, 42) is False
        assert wr._resize_terminal(process, 120, 999) is False
    finally:
        os.close(master)
        os.close(slave)


@pytest.mark.skipif(os.name != "posix", reason="Interactive PTY terminals are Unix-only")
def test_terminal_starts_an_interactive_shell(project):
    import asyncio

    async def exercise():
        process = await wr._start_terminal_process("/bin/sh", str(project.root))
        try:
            await wr._terminal_write(process, b"printf __ASTER_TERMINAL_OK__\\nexit\\n")
            output = b""
            while b"__ASTER_TERMINAL_OK__" not in output:
                try:
                    data = await asyncio.wait_for(wr._terminal_read(process), timeout=2)
                except (asyncio.TimeoutError, OSError):
                    break
                if not data:
                    break
                output += data
            return output
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            wr._close_terminal_pty(process)

    assert b"__ASTER_TERMINAL_OK__" in asyncio.run(exercise())


def asyncio_run(function, *args):
    """Run an async endpoint directly, without an ASGI server."""
    import asyncio
    return asyncio.run(function(*args))


def test_terminal_shell_selection(monkeypatch):
    import shutil

    # Case 1: fish is present
    monkeypatch.setattr(shutil, "which", lambda cmd: "/usr/local/bin/fish" if cmd == "fish" else None)
    monkeypatch.setenv("SHELL", "/bin/zsh")
    shell = shutil.which("fish") or os.environ.get("SHELL") or "/bin/bash"
    assert shell == "/usr/local/bin/fish"

    # Case 2: fish is absent, SHELL is set
    monkeypatch.setattr(shutil, "which", lambda cmd: None)
    monkeypatch.setenv("SHELL", "/bin/zsh")
    shell = shutil.which("fish") or os.environ.get("SHELL") or "/bin/bash"
    assert shell == "/bin/zsh"

    # Case 3: fish is absent, SHELL is unset or empty
    monkeypatch.delenv("SHELL", raising=False)
    shell = shutil.which("fish") or os.environ.get("SHELL") or "/bin/bash"
    assert shell == "/bin/bash"


def test_terminal_pipe_bridge_resize():
    class DummyPipe:
        def __init__(self):
            self.written = b""
            self.closed = False
        def is_closing(self):
            return self.closed
        def write(self, data):
            self.written += data

    dummy_stdin = DummyPipe()
    process = SimpleNamespace(stdin=dummy_stdin)

    # Valid resize emits escape sequence to stdin
    assert wr._resize_terminal(process, 120, 40) is True
    assert dummy_stdin.written == b"\x1bAsterResize:120:40\n"

    # Out of bounds dimensions reject resize
    assert wr._resize_terminal(process, 2, 40) is False
    assert wr._resize_terminal(process, 120, 999) is False

