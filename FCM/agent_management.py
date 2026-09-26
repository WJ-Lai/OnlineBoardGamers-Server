"""Human-owner control plane for FCM Agent identities and credentials."""

import uuid
from collections import defaultdict

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.text import slugify
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_http_methods

from Lobby.models import GamePlayer, User

from .agent_auth import (
    DEFAULT_AGENT_SCOPES,
    issue_agent_token,
    mask_agent_token,
    reveal_agent_token,
)
from .models import AgentCredential, AgentIdentity


def _agent_message(request, raw_token):
    base_url = request.build_absolute_uri("/").rstrip("/")
    return (
        f"Connect to my Online Board Gamers Food Chain Magnate games at {base_url}. "
        f"Use Agent Token {raw_token}; first GET {base_url}/FCM/agent/v1/bootstrap/ "
        "with an Authorization: Bearer header, then follow its workflow exactly. "
        "If more than one game is available, ask me which game to join. "
        "Use only the Agent API—do not operate the webpage or modify server files or the database."
    )


def _context(request, *, error=None):
    try:
        open_identity_id = int(request.GET.get("agent", ""))
    except (TypeError, ValueError):
        open_identity_id = None
    identities = (
        AgentIdentity.objects.filter(owner=request.user, disabled_at__isnull=True)
        .select_related("actor_user")
        .prefetch_related("credentials")
        .order_by("label", "id")
    )
    identities = list(identities)
    games_by_actor = defaultdict(list)
    if identities:
        memberships = (
            GamePlayer.objects.filter(
                player_id__in=[identity.actor_user_id for identity in identities],
                game__gameCode="FCM",
                is_kicked=False,
            )
            .exclude(game__gameStatus="FINISHED")
            .select_related("game")
            .order_by("-game__latestUpdate", "-game_id")
        )
        for membership in memberships:
            games_by_actor[membership.player_id].append(membership.game)

    cards = []
    for identity in identities:
        credential = next(iter(identity.credentials.all()), None)
        cards.append({
            "identity": identity,
            "credential": credential,
            "masked_token": mask_agent_token(credential) if credential else None,
            "token_revealable": bool(credential and reveal_agent_token(credential)),
            "games": games_by_actor[identity.actor_user_id],
        })
    return {
        "agent_cards": cards,
        "form_error": error,
        "open_identity_id": open_identity_id,
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
        with transaction.atomic():
            short_name = slugify(label)[:40] or "agent"
            actor = User(username=f"ai-{short_name}-{uuid.uuid4().hex[:6]}")
            actor.set_unusable_password()
            actor.save()
            identity = AgentIdentity.objects.create(
                owner=request.user,
                actor_user=actor,
                label=label,
            )
            issue_agent_token(
                identity,
                scopes=DEFAULT_AGENT_SCOPES,
                expires_at=None,
            )
        messages.success(request, f"{label} created.")
        return redirect(f"{reverse('FCM:agent_manage')}?agent={identity.id}#agent-{identity.id}")

    if action == "refresh":
        identity = AgentIdentity.objects.filter(
            id=request.POST.get("identity_id"),
            owner=request.user,
            disabled_at__isnull=True,
        ).select_related("actor_user").first()
        if identity is None:
            return _render(request, status=404, error="Agent identity does not exist.")
        issue_agent_token(
            identity,
            scopes=DEFAULT_AGENT_SCOPES,
            name="default",
            expires_at=None,
        )
        messages.success(request, f"Token refreshed for {identity.label}. The old Token no longer works.")
        return redirect(f"{reverse('FCM:agent_manage')}?agent={identity.id}#agent-{identity.id}")

    if action == "delete":
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
            AgentCredential.objects.filter(identity=identity).delete()
        messages.success(request, f"{identity.label} deleted.")
        return redirect("FCM:agent_manage")

    return _render(request, status=400, error="Unknown management action.")


@login_required
@never_cache
@require_GET
def reveal_token(request, identity_id):
    identity = AgentIdentity.objects.filter(
        id=identity_id,
        owner=request.user,
        disabled_at__isnull=True,
    ).prefetch_related("credentials").first()
    if identity is None:
        return JsonResponse({"error": "Agent does not exist"}, status=404)
    credential = next(iter(identity.credentials.all()), None)
    if credential is None:
        return JsonResponse({"error": "Agent has no Token"}, status=404)
    raw_token = reveal_agent_token(credential)
    if raw_token is None:
        return JsonResponse(
            {"error": "This older Token cannot be displayed. Refresh it once to enable reveal and copy."},
            status=409,
        )
    return JsonResponse({
        "token": raw_token,
        "maskedToken": mask_agent_token(credential),
        "connectionMessage": _agent_message(request, raw_token),
    })
