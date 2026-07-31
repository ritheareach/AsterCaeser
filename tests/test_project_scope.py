"""Project-scoped content keeps personal lists and owners isolated."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import core.database as cdb
import core.session_manager as session_manager_module
import routes.note.note_routes as note_routes
import routes.session_routes as session_routes
import routes.task_routes as task_routes
from core.database import Note, Project, ScheduledTask, Session as DbSession, Workspace
from core.session_manager import SessionManager


@pytest.fixture
def scoped_db(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    cdb.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    for module in (session_manager_module, session_routes, note_routes, task_routes):
        monkeypatch.setattr(module, "SessionLocal", factory)

    db = factory()
    try:
        db.add_all([
            Workspace(id="workspace", name="Workspace", owner="alice"),
            Project(id="project-alice", workspace_id="workspace", name="A", owner="alice"),
            Workspace(id="workspace-bob", name="Workspace B", owner="bob"),
            Project(id="project-bob", workspace_id="workspace-bob", name="B", owner="bob"),
            # Compatibility for workspace rows created before anonymous routes
            # switched from __system__ to NULL ownership.
            Workspace(id="workspace-legacy", name="Legacy", owner="__system__"),
            Project(id="project-legacy", workspace_id="workspace-legacy", name="Legacy", owner="__system__"),
        ])
        db.commit()
    finally:
        db.close()
    return factory


def _route(router, method, path):
    return next(
        route.endpoint for route in router.routes
        if route.path == path and method in route.methods
    )


def test_project_delete_nulls_all_scoped_content(scoped_db):
    db = scoped_db()
    try:
        db.add_all([
            DbSession(id="chat", owner="alice", name="chat", endpoint_url="http://x", model="m", project_id="project-alice"),
            Note(id="note", owner="alice", title="note", project_id="project-alice"),
            ScheduledTask(id="task", owner="alice", name="task", project_id="project-alice"),
        ])
        db.commit()
        db.delete(db.get(Project, "project-alice"))
        db.commit()
        assert db.get(DbSession, "chat").project_id is None
        assert db.get(Note, "note").project_id is None
        assert db.get(ScheduledTask, "task").project_id is None
    finally:
        db.close()


def test_content_migration_is_idempotent_for_existing_sqlite(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE projects (id VARCHAR PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE notes (id VARCHAR PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE scheduled_tasks (id VARCHAR PRIMARY KEY)"))

    monkeypatch.setattr(cdb, "engine", engine)
    cdb._migrate_add_project_content_columns()
    cdb._migrate_add_project_content_columns()

    with engine.connect() as conn:
        note_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(notes)"))}
        task_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(scheduled_tasks)"))}
        note_indexes = {row[1] for row in conn.execute(text("PRAGMA index_list(notes)"))}
        task_indexes = {row[1] for row in conn.execute(text("PRAGMA index_list(scheduled_tasks)"))}
    assert "project_id" in note_columns
    assert "project_id" in task_columns
    assert "ix_notes_project_id" in note_indexes
    assert "ix_scheduled_tasks_project_id" in task_indexes


def test_session_manager_and_list_route_enforce_project_scope(scoped_db, monkeypatch):
    manager = SessionManager()
    manager.create_session("legacy", "legacy", "http://x", "m", owner="alice")
    manager.create_session("scoped", "scoped", "http://x", "m", owner="alice", project_id="project-alice")
    with pytest.raises(ValueError):
        manager.create_session("cross-owner", "bad", "http://x", "m", owner="alice", project_id="project-bob")

    monkeypatch.setattr(session_routes, "effective_user", lambda request: "alice")
    # session_routes owns a legacy module-level router. Remove only the routes
    # added by this focused test so later route tests don't capture a closure
    # bound to this temporary SessionManager.
    route_count = len(session_routes.router.routes)
    try:
        endpoint = _route(session_routes.setup_session_routes(manager, {}), "GET", "/api/sessions")
        assert [row["id"] for row in endpoint(MagicMock())] == ["legacy"]
        assert [row["id"] for row in endpoint(MagicMock(), project_id="project-alice")] == ["scoped"]
        with pytest.raises(HTTPException) as error:
            endpoint(MagicMock(), project_id="project-bob")
        assert error.value.status_code == 404
    finally:
        del session_routes.router.routes[route_count:]


def test_note_and_task_routes_scope_and_validate_project_owners(scoped_db, monkeypatch):
    monkeypatch.setattr(note_routes, "require_user", lambda request: "alice")
    notes_router = note_routes.setup_note_routes()
    create_note = _route(notes_router, "POST", "/api/notes")
    list_notes = _route(notes_router, "GET", "/api/notes")
    request = MagicMock()
    create_note(request, note_routes.NoteCreate(title="legacy"))
    create_note(request, note_routes.NoteCreate(title="scoped", project_id="project-alice"))
    assert [note["title"] for note in list_notes(request)["notes"]] == ["legacy"]
    assert [note["title"] for note in list_notes(request, project_id="project-alice")["notes"]] == ["scoped"]
    with pytest.raises(HTTPException) as error:
        create_note(request, note_routes.NoteCreate(title="cross-owner", project_id="project-bob"))
    assert error.value.status_code == 404

    monkeypatch.setattr(task_routes, "get_current_user", lambda request: "alice")
    scheduler = MagicMock()
    scheduler.ensure_defaults = AsyncMock()
    tasks_router = task_routes.setup_task_routes(scheduler)
    create_task = _route(tasks_router, "POST", "/api/tasks")
    list_tasks = _route(tasks_router, "GET", "/api/tasks")

    async def exercise_tasks():
        await create_task(request, task_routes.TaskCreate(name="legacy task", prompt="x", trigger_type="webhook"))
        await create_task(request, task_routes.TaskCreate(name="scoped task", prompt="x", trigger_type="webhook", project_id="project-alice"))
        assert [task["name"] for task in (await list_tasks(request))["tasks"]] == ["legacy task"]
        assert [task["name"] for task in (await list_tasks(request, project_id="project-alice"))["tasks"]] == ["scoped task"]
        with pytest.raises(HTTPException) as error:
            await create_task(request, task_routes.TaskCreate(name="cross-owner", prompt="x", trigger_type="webhook", project_id="project-bob"))
        assert error.value.status_code == 404

    import asyncio
    asyncio.run(exercise_tasks())


def test_anonymous_project_compatibility_is_limited_to_system_rows(scoped_db):
    db = scoped_db()
    try:
        legacy = db.get(Project, "project-legacy")
        named = db.get(Project, "project-alice")
        assert session_routes._project_belongs_to_request(db, legacy.id, None)
        assert note_routes._project_belongs_to_request(db, legacy.id, None)
        assert task_routes._project_belongs_to_request(db, legacy.id, None)
        assert not session_routes._project_belongs_to_request(db, named.id, None)
        assert not note_routes._project_belongs_to_request(db, named.id, None)
        assert not task_routes._project_belongs_to_request(db, named.id, None)
    finally:
        db.close()
