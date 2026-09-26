from django.shortcuts import get_object_or_404, redirect
from django.urls import path

from Lobby.models import Game

from . import agent_api, agent_management, views

app_name = "FCM"


def redirect_old_url(request, original_id):
    """Redirect old FCM_Game URLs to Game URLs"""
    try:
        game = Game.objects.get(gameCode="FCM", original_id=original_id)
        return redirect("FCM:showFCMgame", game_id=game.id)
    except Game.DoesNotExist:
        # If not found by original_id, try by direct id (might already be a new game)
        game = get_object_or_404(Game, id=original_id, gameCode="FCM")
        return redirect("FCM:showFCMgame", game_id=game.id)


urlpatterns = [
    path("", views.index, name="index"),
    path("agent/manage/", agent_management.manage_agents, name="agent_manage"),
    path(
        "agent/manage/<int:identity_id>/token/",
        agent_management.reveal_token,
        name="agent_reveal_token",
    ),
    path("agent/v1/games/", agent_api.list_games, name="agent_list_games"),
    path("agent/v1/whoami/", agent_api.agent_whoami, name="agent_whoami"),
    path("agent/v1/bootstrap/", agent_api.agent_bootstrap, name="agent_bootstrap"),
    path("agent/v1/identities/", agent_api.agent_identities, name="agent_identities"),
    path(
        "agent/v1/identities/<int:identity_id>/tokens/",
        agent_api.create_agent_token,
        name="agent_create_token",
    ),
    path(
        "agent/v1/identities/<int:identity_id>/",
        agent_api.disable_agent_identity,
        name="agent_disable_identity",
    ),
    path(
        "agent/v1/tokens/<int:credential_id>/",
        agent_api.revoke_agent_token,
        name="agent_revoke_token",
    ),
    path(
        "agent/v1/games/<int:game_id>/snapshot/",
        agent_api.game_snapshot,
        name="agent_game_snapshot",
    ),
    path(
        "agent/v1/games/<int:game_id>/actions/",
        agent_api.game_actions,
        name="agent_game_actions",
    ),
    path(
        "agent/v1/games/<int:game_id>/changes/",
        agent_api.game_changes,
        name="agent_game_changes",
    ),
    path(
        "agent/v1/games/<int:game_id>/join/",
        agent_api.join_game,
        name="agent_join_game",
    ),
    path(
        "agent/v1/games/<int:game_id>/commands/<uuid:idempotency_key>/",
        agent_api.command_receipt,
        name="agent_command_receipt",
    ),
    path("help/", views.FCMhelp, name="FCMhelp"),
    path("chinaHelp/", views.FCMchinaHelp, name="FCMchinaHelp"),
    path("coffeeHelp/", views.coffeeHelp, name="coffeeHelp"),
    path("test/", views.test, name="test"),
    path("gameAdmin/", views.gameAdmin, name="gameAdmin"),
    path("<int:game_id>/show2/", views.showGame, name="showFCMgame"),
    path("<int:game_id>/show/", views.showGameVue, name="showFCMgameVue"),
    path("<int:original_id>/", redirect_old_url, name="redirect_old_url"),
    path("FCMstats/", views.FCMstats, name="FCMstats"),
    path("FCMstatGames/", views.FCMstatGames, name="FCMstatGames"),
    # API Routes
    path("createFCMgame/", views.createFCMgame, name="createFCMgame"),
    path("processTurn/", views.processTurn, name="processTurn"),
    path("bugEntry/", views.bugEntry, name="bugEntry"),
    path("notes/", views.notes, name="notes"),
    path("<int:game_id>/checkNewData/", views.checkNewData, name="checkNewData"),
    path("changeAssistance/", views.changeAssistance, name="changeAssistance"),
    path(
        "gameAdminGetMoveData/", views.gameAdminGetMoveData, name="gameAdminGetMoveData"
    ),
    path("data/<int:dataType>/", views.FCMdata, name="FCMdata"),
    path("sendChatMessage/", views.sendChatMessage, name="sendChatMessage"),
    path("castVote/", views.castVote, name="castVoteCNS"),
]
