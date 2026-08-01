"""Antigravity Subscription device-flow setup routes."""

import json
import logging
import uuid
from typing import Dict, Optional

from fastapi import HTTPException, Request

from core.database import ModelEndpoint, ProviderAuthSession, SessionLocal, utcnow_naive
from routes.device_flow import (
    DeviceFlowPoll,
    DeviceFlowStart,
    PendingDeviceFlowStore,
    create_device_flow_router,
)
from src.auth_helpers import get_current_user
from src import antigravity_subscription

logger = logging.getLogger(__name__)

_DEVICE_FLOW_STORE = PendingDeviceFlowStore()


def _provision_endpoint(tokens: Dict, owner: Optional[str]) -> Dict:
    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")
    if not access_token or str(access_token).startswith("agy_access_token_"):
        local_creds = antigravity_subscription._load_local_antigravity_oauth_credentials()
        if local_creds.get("access_token"):
            access_token = local_creds["access_token"]
            refresh_token = local_creds.get("refresh_token") or refresh_token
    if not access_token:
        raise ValueError("Antigravity token response was missing access_token")

    base = antigravity_subscription.DEFAULT_ANTIGRAVITY_SUBSCRIPTION_BASE_URL
    models = antigravity_subscription.fetch_available_models(access_token)

    db = SessionLocal()
    try:
        auth = (
            db.query(ProviderAuthSession)
            .filter(
                ProviderAuthSession.provider == antigravity_subscription.ANTIGRAVITY_SUBSCRIPTION_PROVIDER,
                ProviderAuthSession.owner == owner,
            )
            .first()
        )
        if auth is None:
            auth = ProviderAuthSession(
                id=str(uuid.uuid4())[:8],
                provider=antigravity_subscription.ANTIGRAVITY_SUBSCRIPTION_PROVIDER,
                owner=owner,
                label="Antigravity Subscription",
                base_url=base,
                auth_mode="antigravity",
            )
            db.add(auth)
        auth.base_url = base
        auth.access_token = access_token
        auth.refresh_token = refresh_token
        auth.last_refresh = utcnow_naive()
        auth.auth_mode = "antigravity"

        ep = (
            db.query(ModelEndpoint)
            .filter(
                ModelEndpoint.base_url == base,
                ModelEndpoint.provider_auth_id == auth.id,
                ModelEndpoint.owner == owner,
            )
            .first()
        )
        if ep is None:
            ep = ModelEndpoint(
                id=str(uuid.uuid4())[:8],
                name="Antigravity Subscription",
                base_url=base,
                model_type="llm",
                endpoint_kind="api",
                owner=owner,
            )
            db.add(ep)
        ep.name = "Antigravity Subscription"
        ep.base_url = base
        ep.api_key = None
        ep.provider_auth_id = auth.id
        ep.is_enabled = True
        ep.supports_tools = True
        ep.model_type = "llm"
        ep.endpoint_kind = "api"
        ep.model_refresh_mode = "manual"
        ep.cached_models = json.dumps(models)
        db.commit()
        result = {
            "id": ep.id,
            "name": ep.name,
            "base_url": ep.base_url,
            "models": models,
        }
    finally:
        db.close()

    try:
        from routes.model_routes import _invalidate_models_cache

        _invalidate_models_cache()
    except Exception:
        pass
    return result


def _start_device_flow(request: Request, _form) -> DeviceFlowStart:
    local_creds = antigravity_subscription._load_local_antigravity_oauth_credentials()
    if local_creds.get("access_token"):
        return DeviceFlowStart(
            pending={
                "device_auth_id": "local_gemini_auth",
                "user_code": "LOCAL_AUTH",
                "owner": get_current_user(request) or None,
                "auto_authorize": True,
            },
            response={
                "user_code": "LOCAL_AUTH",
                "verification_uri": "",
            },
            interval=1,
            expires_in=60,
        )

    try:
        data = antigravity_subscription.request_device_code()
    except Exception as exc:
        raise antigravity_subscription.to_http_exception(exc)

    device_auth_id = data.get("device_auth_id")
    user_code = data.get("user_code")
    if not device_auth_id or not user_code:
        raise HTTPException(502, "Antigravity did not return a complete device code")
    verification_uri = data.get("verification_uri") or ""
    return DeviceFlowStart(
        pending={
            "device_auth_id": device_auth_id,
            "user_code": user_code,
            "owner": get_current_user(request) or None,
        },
        response={
            "user_code": user_code,
            "verification_uri": verification_uri,
        },
        interval=int(data.get("interval") or 5),
        expires_in=int(data.get("expires_in") or 900),
    )


def _poll_device_flow(_request: Request, pending: Dict) -> DeviceFlowPoll:
    if pending.get("auto_authorize"):
        local_creds = antigravity_subscription._load_local_antigravity_oauth_credentials()
        try:
            result = _provision_endpoint(local_creds, pending["owner"])
            return DeviceFlowPoll.authorized(result)
        except Exception as exc:
            logger.exception("Antigravity Subscription local endpoint provisioning failed")
            raise antigravity_subscription.to_http_exception(exc)

    try:
        data = antigravity_subscription.poll_device_auth(pending["device_auth_id"], pending["user_code"])
    except Exception as exc:
        logger.debug("Antigravity device poll failed: %s", exc)
        return DeviceFlowPoll.pending(str(exc))

    authorization_code = data.get("authorization_code")
    code_verifier = data.get("code_verifier")
    if authorization_code and code_verifier:
        try:
            tokens = antigravity_subscription.exchange_authorization_code(authorization_code, code_verifier)
            result = _provision_endpoint(tokens, pending["owner"])
        except Exception as exc:
            logger.exception("Antigravity Subscription endpoint provisioning failed")
            raise antigravity_subscription.to_http_exception(exc)
        return DeviceFlowPoll.authorized(result)

    err = data.get("error") or data.get("status")
    if err in ("authorization_pending", "pending", None):
        return DeviceFlowPoll.pending()
    if err == "slow_down":
        return DeviceFlowPoll.slow_down(int(data.get("interval") or 0) or None)
    if err in ("expired_token", "access_denied", "denied"):
        return DeviceFlowPoll.failed(err)
    return DeviceFlowPoll.pending(err or "unknown")


def setup_antigravity_subscription_routes():
    return create_device_flow_router(
        prefix="/api/antigravity-subscription",
        tags=["antigravity-subscription"],
        store=_DEVICE_FLOW_STORE,
        start_flow=_start_device_flow,
        poll_flow=_poll_device_flow,
    )
