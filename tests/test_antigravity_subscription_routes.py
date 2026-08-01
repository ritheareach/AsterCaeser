"""DB-backed Antigravity Subscription endpoint provisioning tests."""

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core.database import Base, ModelEndpoint, ProviderAuthSession
import routes.antigravity_subscription_routes as asr
from src.antigravity_subscription import (
    is_antigravity_subscription_base,
    antigravity_headers,
    resolve_runtime_credentials,
)


def _mem_db(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestSessionLocal = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(asr, "SessionLocal", TestSessionLocal)
    return TestSessionLocal


def test_is_antigravity_subscription_base():
    assert is_antigravity_subscription_base("https://antigravity.google/backend-api/v1") is True
    assert is_antigravity_subscription_base("https://sub.antigravity.google/api") is True
    assert is_antigravity_subscription_base("https://google.com") is False


def test_antigravity_headers():
    h = antigravity_headers("MY_TOKEN")
    assert h["Authorization"] == "Bearer MY_TOKEN"
    assert h["Origin"] == "https://antigravity.google"


def test_provision_creates_owner_scoped_auth_session_and_endpoint(monkeypatch):
    TestSessionLocal = _mem_db(monkeypatch)
    monkeypatch.setattr(asr.antigravity_subscription, "fetch_available_models", lambda token: ["gemini-3.6-pro", "antigravity-coder"])

    res = asr._provision_endpoint({"access_token": "AGY_AT", "refresh_token": "AGY_RT"}, "alice")

    assert res["name"] == "Antigravity Subscription"
    assert res["base_url"] == asr.antigravity_subscription.DEFAULT_ANTIGRAVITY_SUBSCRIPTION_BASE_URL
    assert res["models"] == ["gemini-3.6-pro", "antigravity-coder"]

    db = TestSessionLocal()
    try:
        auth = db.query(ProviderAuthSession).first()
        ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == res["id"]).first()
        assert auth is not None
        assert auth.owner == "alice"
        assert auth.provider == asr.antigravity_subscription.ANTIGRAVITY_SUBSCRIPTION_PROVIDER
        assert auth.access_token == "AGY_AT"
        assert auth.refresh_token == "AGY_RT"
        assert auth.auth_mode == "antigravity"
        assert ep is not None
        assert ep.owner == "alice"
        assert ep.api_key is None
        assert ep.provider_auth_id == auth.id
        assert ep.supports_tools is True
        assert json.loads(ep.cached_models) == ["gemini-3.6-pro", "antigravity-coder"]
    finally:
        db.close()


def test_provision_refreshes_existing_auth_session_and_endpoint(monkeypatch):
    TestSessionLocal = _mem_db(monkeypatch)
    monkeypatch.setattr(asr.antigravity_subscription, "fetch_available_models", lambda token: ["gemini-3.6-pro"])

    first = asr._provision_endpoint({"access_token": "OLD", "refresh_token": "OLD-RT"}, "bob")
    second = asr._provision_endpoint({"access_token": "NEW", "refresh_token": "NEW-RT"}, "bob")

    assert first["id"] == second["id"]
    db = TestSessionLocal()
    try:
        auth_rows = db.query(ProviderAuthSession).filter(ProviderAuthSession.owner == "bob").all()
        ep_rows = db.query(ModelEndpoint).filter(ModelEndpoint.owner == "bob").all()
        assert len(auth_rows) == 1
        assert len(ep_rows) == 1
        assert auth_rows[0].access_token == "NEW"
    finally:
        db.close()
