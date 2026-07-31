"""Regression guards for project context on a newly created chat."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_pending_session_falls_back_to_current_project_scope():
    source = (ROOT / "static/js/sessions.js").read_text(encoding="utf-8")

    assert "pending.projectId || Storage.get('astercaeser-active-project', null)" in source
    assert "fd.append('project_id', projectId)" in source


def test_chat_turn_sends_active_project_for_server_side_recovery():
    source = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")

    assert "const _projectId = Storage.get('astercaeser-active-project', null);" in source
    assert "fd.append('project_id', _projectId);" in source


def test_server_binds_only_unscoped_sessions_after_project_owner_check():
    source = (ROOT / "routes/chat_routes.py").read_text(encoding="utf-8")

    assert "def _bind_unscoped_session_to_project" in source
    assert "if not project_id or getattr(sess, \"project_id\", None):" in source
    assert "if project.owner != owner:" in source
    assert "row.project_id = project.id" in source
    assert "_bind_unscoped_session_to_project(sess, requested_project_id, owner)" in source


def test_project_file_actions_are_promoted_and_confined_to_project_path():
    intents = (ROOT / "src/action_intents.py").read_text(encoding="utf-8")
    routes = (ROOT / "routes/chat_routes.py").read_text(encoding="utf-8")

    assert '"files", "project file creation or edit request"' in intents
    assert "_project_workspace_for_session(sess, owner)" in routes
    assert '"read_file", "write_file", "edit_file", "ls", "get_workspace"' in routes


def test_contextual_file_edit_is_promoted_to_agent_mode():
    from types import SimpleNamespace
    from routes.chat_routes import _is_contextual_file_followup

    session = SimpleNamespace(history=[
        {"role": "assistant", "content": "Created say_hi.py in the project directory."},
    ])
    assert _is_contextual_file_followup("edit it to print hello world", session)
    assert not _is_contextual_file_followup("edit it to print hello world", SimpleNamespace(history=[]))
