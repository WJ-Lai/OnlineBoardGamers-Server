"""Human-owner control plane for FCM Agent identities and credentials."""

import uuid
from datetime import timedelta

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods

from Lobby.models import User

from .agent_auth import (
    DEFAULT_AGENT_SCOPES,
    VALID_AGENT_SCOPES,
    issue_agent_token,
    validate_scopes,
)
from .models import AgentCredential, AgentIdentity


def _expires_at(raw_days):
    try:
        days = int(raw_days)
    except (TypeError, ValueError) as error:
        raise ValueError("Expiry must be a whole number between 1 and 365 days.") from error
    if not 1 <= days <= 365:
        raise ValueError("Expiry must be between 1 and 365 days.")
    return timezone.now() + timedelta(days=days)


def _scopes(request):
    scopes = request.POST.getlist("scopes")
    return validate_scopes(scopes)


def _context(request, *, raw_token=None, identity=None, error=None):
    identities = (
        AgentIdentity.objects.filter(owner=request.user)
        .select_related("actor_user")
        .prefetch_related("credentials")
        .order_by("label", "id")
    )
    config = None
    agent_message = None
    if raw_token and identity:
        base_url = request.build_absolute_uri("/").rstrip("/")
        config = (
            f"FCM_BASE_URL={base_url}\n"
            f"FCM_AGENT_TOKEN={raw_token}\n"
            f"FCM_AGENT_USERNAME={identity.actor_user.username}\n"
        )
        agent_message = (
            f"Connect to my Online Board Gamers Food Chain Magnate game at {base_url}. "
            f"Use Agent Token {raw_token}; first GET {base_url}/FCM/agent/v1/bootstrap/ "
            "with an Authorization: Bearer header, then follow its workflow exactly. "
            "If more than one game is available, ask me which game to join. "
            "Use only the Agent API—do not operate the webpage or modify server files or the database."
        )
    return {
        "identities": identities,
        "available_scopes": sorted(VALID_AGENT_SCOPES),
        "raw_token": raw_token,
        "connection_config": config,
        "agent_message": agent_message,
        "created_identity": identity,
        "form_error": error,
        "now": timezone.now(),
    }


def _render(request, *, status=200, **context):
    return render(
        request,
        "FCM/agent_manage.html",
        _context(request, **context),
        status=status,
    )


@login_required
@never_cache
@require_http_methods(["GET", "POST"])
def manage_agents(request):
    # PATs are restricted to /agent/v1/ and cannot open this browser control plane.
    if getattr(request, "agent_credential", None) is not None:
        return _render(request, status=403, error="Use the human owner account.")
    if request.method == "GET":
        return _render(request)

    action = request.POST.get("action")
    if action == "create":
        label = request.POST.get("label", "").strip()
        if not 1 <= len(label) <= 80:
            return _render(request, status=400, error="Label must contain 1 to 80 characters.")
        try:
            scopes = _scopes(request)
            expires_at = _expires_at(request.POST.get("expires_in_days"))
        except ValueError as error:
            return _render(request, status=400, error=str(error))
        with transaction.atomic():
            actor = User(username=f"fcm-agent-{request.user.id}-{uuid.uuid4().hex[:12]}")
            actor.set_unusable_password()
            actor.save()
            identity = AgentIdentity.objects.create(
                owner=request.user,
                actor_user=actor,
                label=label,
            )
            _credential, raw_token = issue_agent_token(
                identity,
                scopes=scopes,
                expires_at=expires_at,
            )
        return _render(request, status=201, raw_token=raw_token, identity=identity)

    if action == "rotate":
        identity = AgentIdentity.objects.filter(
            id=request.POST.get("identity_id"),
            owner=request.user,
            disabled_at__isnull=True,
        ).select_related("actor_user").first()
        if identity is None:
            return _render(request, status=404, error="Agent identity does not exist.")
        name = request.POST.get("token_name", "default").strip()
        if not 1 <= len(name) <= 80:
            return _render(request, status=400, error="Token name must contain 1 to 80 characters.")
        try:
            scopes = _scopes(request)
            expires_at = _expires_at(request.POST.get("expires_in_days"))
        except ValueError as error:
            return _render(request, status=400, error=str(error))
        _credential, raw_token = issue_agent_token(
            identity,
            scopes=scopes,
            name=name,
            expires_at=expires_at,
        )
        return _render(request, status=201, raw_token=raw_token, identity=identity)

    if action == "revoke":
        credential = AgentCredential.objects.filter(
            id=request.POST.get("credential_id"),
            identity__owner=request.user,
        ).first()
        if credential is None:
            return _render(request, status=404, error="Agent token does not exist.")
        if credential.revoked_at is None:
            credential.revoked_at = timezone.now()
            credential.save(update_fields=["revoked_at"])
        messages.success(request, "Agent token revoked.")
        return redirect("FCM:agent_manage")

    if action == "disable":
        identity = AgentIdentity.objects.filter(
            id=request.POST.get("identity_id"),
            owner=request.user,
        ).select_related("actor_user").first()
        if identity is None:
            return _render(request, status=404, error="Agent identity does not exist.")
        now = timezone.now()
        with transaction.atomic():
            AgentIdentity.objects.filter(pk=identity.pk).update(disabled_at=now)
            User.objects.filter(pk=identity.actor_user_id).update(is_active=False)
            AgentCredential.objects.filter(
                identity=identity,
                revoked_at__isnull=True,
            ).update(revoked_at=now)
        messages.success(request, "Agent disabled and all of its tokens revoked.")
        return redirect("FCM:agent_manage")

    return _render(request, status=400, error="Unknown management action.")
