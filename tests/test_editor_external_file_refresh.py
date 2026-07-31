from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_agent_file_writes_notify_and_refresh_open_project_tabs():
    agent_loop = (ROOT / "src/agent_loop.py").read_text(encoding="utf-8")
    chat = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")
    editor = (ROOT / "static/js/editor/editor.js").read_text(encoding="utf-8")

    assert 'tool_output_data["path"] = result["path"]' in agent_loop
    assert "aster:project-file-changed" in chat
    assert "refreshExternallyChangedFile" in editor
    assert "keeping your unsaved editor changes" in editor


def test_editor_watches_disk_changes_outside_the_browser():
    routes = (ROOT / "routes/workspace_routes.py").read_text(encoding="utf-8")
    editor = (ROOT / "static/js/editor/editor.js").read_text(encoding="utf-8")

    assert 'files/stat' in routes
    assert 'st_mtime_ns' in routes
    assert 'pollExternalProjectChanges' in editor
    assert 'startExternalFileWatcher' in editor
    assert 'changed outside the editor' in editor
