"""Narrow, JSON-only API used by the FCM Agent gateway."""

import base64
import gzip
import hashlib
import json
import time
import uuid
from datetime import timedelta
from random import randint

from django.db import transaction
from django.db.models import Max, Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

import Lobby.sharedFunctions.constants as lobby_constants
from Lobby.models import Game, GamePlayer, User
from Lobby.sharedFunctions.sharedRefs import SR_getTimeNow

from . import FCMconstants as fcm_constants
from .agent_auth import (
    DEFAULT_AGENT_SCOPES,
    VALID_AGENT_SCOPES,
    issue_agent_token,
    validate_scopes,
)
from .engine_runner import AuthoritativeEngineError, run_authoritative_engine
from .models import AgentActionReceipt, AgentCredential, AgentIdentity


def _error(code, message, status, next_action=None):
    payload = {"code": code, "message": message}
    if next_action:
        payload["nextAction"] = next_action
    return JsonResponse({"error": payload}, status=status)


def _require_user(request):
    if getattr(request, "agent_auth_error", None):
        return _error("INVALID_TOKEN", "The Agent token is invalid or revoked", 401)
    if not request.user.is_authenticated:
        return _error(
            "AUTH_REQUIRED",
            "Authentication is required",
            401,
            "Log in and retry the request",
        )
    return None


def _require_scope(request, scope):
    credential = getattr(request, "agent_credential", None)
    if credential is not None and scope not in credential.scopes:
        return _error(
            "INSUFFICIENT_SCOPE",
            f"This token requires the {scope} scope",
            403,
            "Issue a new token with the required scope",
        )
    return None


def _parse_page(request):
    try:
        limit = int(request.GET.get("limit", "25"))
        offset = int(request.GET.get("offset", "0"))
    except (TypeError, ValueError):
        return None, _error("INVALID_ARGUMENTS", "limit and offset must be integers", 400)
    if not 1 <= limit <= 100 or offset < 0:
        return None, _error(
            "INVALID_ARGUMENTS",
            "limit must be 1..100 and offset must be non-negative",
            400,
        )
    return (limit, offset), None


def _load_member_game(request, game_id):
    try:
        game = Game.objects.prefetch_related("players__player", "invitedPlayers").get(
            id=game_id,
            gameCode="FCM",
        )
    except Game.DoesNotExist:
        return None, None, _error("GAME_NOT_FOUND", "FCM game does not exist", 404)

    membership = next(
        (
            game_player
            for game_player in game.players.all()
            if game_player.player_id == request.user.id
            and not game_player.is_kicked
            and not game_player.is_missing
        ),
        None,
    )
    if membership is None:
        return None, None, _error(
            "NOT_A_PLAYER",
            "The authenticated account is not an active player in this game",
            403,
            "Join the game or use an account that is already a player",
        )
    return game, membership, None


def _json_field(raw, default):
    if raw in (None, ""):
        return default
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return default


def _compress_side_data(value):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(gzip.compress(payload)).decode("ascii")


def _read_json_object(request, *, allowed_fields):
    if len(request.body) > 16_384:
        return None, _error("INVALID_ARGUMENTS", "Request body is too large", 400)
    try:
        payload = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, _error("INVALID_JSON", "Request body must be valid JSON", 400)
    if not isinstance(payload, dict):
        return None, _error("INVALID_ARGUMENTS", "Request body must be a JSON object", 400)
    unknown = sorted(set(payload) - set(allowed_fields))
    if unknown:
        return None, _error(
            "INVALID_ARGUMENTS",
            f"Unknown fields: {', '.join(unknown)}",
            400,
        )
    return payload, None


@require_http_methods(["GET", "POST"])
def list_games(request):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    required_scope = "fcm:games:create" if request.method == "POST" else "fcm:read"
    scope_error = _require_scope(request, required_scope)
    if scope_error:
        return scope_error
    if request.method == "POST":
        return create_game(request)
    page, page_error = _parse_page(request)
    if page_error:
        return page_error
    limit, offset = page

    games = (
        Game.objects.filter(gameCode="FCM")
        .filter(
            Q(players__player=request.user, players__is_kicked=False)
            | Q(invitedPlayers=request.user)
            | Q(gameStatus="AVAILABLE")
        )
        .distinct()
        .order_by("-latestUpdate", "-id")
    )
    total = games.count()
    page_items = games[offset : offset + limit]
    items = [
        {
            "id": game.id,
            "gameName": game.gameName,
            "status": game.gameStatus,
            "maxPlayers": game.maxPlayers,
            "playerCount": game.players.filter(is_kicked=False).count(),
            "latestUpdate": str(game.latestUpdate),
            "turn": game.turn,
            "phase": game.phase,
        }
        for game in page_items
    ]
    return JsonResponse(
        {
            "games": items,
            "count": len(items),
            "total": total,
            "offset": offset,
            "limit": limit,
            "hasMore": offset + len(items) < total,
            "nextOffset": offset + len(items) if offset + len(items) < total else None,
        }
    )


def create_game(request):
    payload, payload_error = _read_json_object(
        request,
        allowed_fields={
            "gameName",
            "gameDescription",
            "maxPlayers",
            "invitedUsernames",
            "private",
        },
    )
    if payload_error:
        return payload_error

    game_name = payload.get("gameName")
    description = payload.get("gameDescription", "")
    max_players = payload.get("maxPlayers", 2)
    invited_usernames = payload.get("invitedUsernames", [])
    private = payload.get("private", False)
    if not isinstance(game_name, str) or not 1 <= len(game_name.strip()) <= 120:
        return _error("INVALID_ARGUMENTS", "gameName must contain 1..120 characters", 400)
    if not isinstance(description, str) or len(description) > 120:
        return _error("INVALID_ARGUMENTS", "gameDescription must be at most 120 characters", 400)
    if not isinstance(private, bool):
        return _error("INVALID_ARGUMENTS", "private must be a boolean", 400)
    if isinstance(max_players, bool) or not isinstance(max_players, int) or not 2 <= max_players <= 6:
        return _error("INVALID_ARGUMENTS", "maxPlayers must be an integer from 2 to 6", 400)
    if not isinstance(invited_usernames, list) or any(
        not isinstance(username, str) or not username or len(username) > 150
        for username in invited_usernames
    ):
        return _error("INVALID_ARGUMENTS", "invitedUsernames must be a list of valid usernames", 400)
    if len(invited_usernames) > max_players - 1:
        return _error("INVALID_ARGUMENTS", "Invitations cannot exceed the available seats", 400)
    if len(set(invited_usernames)) != len(invited_usernames):
        return _error("INVALID_ARGUMENTS", "invitedUsernames cannot contain duplicates", 400)
    if request.user.username in invited_usernames:
        return _error("INVALID_ARGUMENTS", "You cannot invite the creating account", 400)

    invited_users_by_name = {
        user.username: user
        for user in User.objects.filter(username__in=invited_usernames, is_active=True)
    }
    if set(invited_users_by_name) != set(invited_usernames):
        return _error("INVALID_ARGUMENTS", "One or more invited users do not exist", 400)
    invited_users = [invited_users_by_name[username] for username in invited_usernames]

    created = SR_getTimeNow()
    with transaction.atomic():
        game = Game.objects.create(
            gameCode="FCM",
            gameName=game_name.strip(),
            gameDescription=description,
            creator=request.user,
            host=request.user,
            gamePace=lobby_constants.PACE_STANDARD,
            turn=0,
            phase=0,
            created=created,
            latestUpdate=created,
            playerOrderSeed=randint(0, max_players - 1),
            startingOptions="[]",
            maxPlayers=max_players,
            gameStatus="PRIVATE" if private else ("WAITING" if invited_users else "AVAILABLE"),
            kickoutDuration=lobby_constants.KICKOUT_1_DAY,
            zoomLevels="200" * max_players,
            startingMap="",
            statsExcludedGame=False,
            FCMnotificationSuppression="0" * max_players,
        )
        GamePlayer.objects.create(
            game=game,
            player=request.user,
            seat_order=0,
        )
        if invited_users:
            game.invitedPlayers.add(*invited_users)

    return JsonResponse(
        {
            "game": {
                "id": game.id,
                "gameName": game.gameName,
                "status": game.gameStatus,
                "maxPlayers": game.maxPlayers,
                "invitedUsernames": invited_usernames,
                "latestUpdate": str(game.latestUpdate),
            }
        },
        status=201,
    )


@require_POST
def join_game(request, game_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    scope_error = _require_scope(request, "fcm:play")
    if scope_error:
        return scope_error
    _payload, payload_error = _read_json_object(request, allowed_fields=set())
    if payload_error:
        return payload_error

    with transaction.atomic():
        try:
            game = (
                Game.objects.select_for_update()
                .prefetch_related("players__player", "invitedPlayers")
                .get(id=game_id, gameCode="FCM")
            )
        except Game.DoesNotExist:
            return _error("GAME_NOT_FOUND", "FCM game does not exist", 404)

        existing = game.players.filter(player=request.user).first()
        if existing and not existing.is_kicked:
            return JsonResponse(
                {
                    "gameID": game.id,
                    "status": game.gameStatus,
                    "alreadyJoined": True,
                    "seat": existing.seat_order,
                }
            )
        if existing and existing.is_kicked:
            return _error("JOIN_FORBIDDEN", "A kicked player cannot rejoin this game", 403)
        if game.gameStatus not in {"AVAILABLE", "WAITING", "PRIVATE"}:
            return _error("GAME_NOT_JOINABLE", "This game has already started or ended", 409)

        active_players = game.players.filter(is_kicked=False)
        player_count = active_players.count()
        if player_count >= game.maxPlayers:
            return _error("GAME_FULL", "This game is full", 409)

        is_invited = game.invitedPlayers.filter(id=request.user.id).exists()
        reserved_count = player_count + game.invitedPlayers.count()
        if game.gameStatus == "PRIVATE" and not is_invited:
            return _error("JOIN_FORBIDDEN", "This private game requires an invitation", 403)
        if game.gameStatus == "WAITING" and not is_invited and reserved_count >= game.maxPlayers:
            return _error("JOIN_FORBIDDEN", "All remaining seats are reserved for invited players", 403)
        if game.creator and game.creator.profile.blacklistedPlayers.filter(id=request.user.id).exists():
            return _error("JOIN_FORBIDDEN", "The game creator has blocked this account", 403)

        max_seat = active_players.aggregate(value=Max("seat_order"))["value"]
        membership = GamePlayer.objects.create(
            game=game,
            player=request.user,
            seat_order=(max_seat + 1) if max_seat is not None else 0,
        )
        game.invitedPlayers.remove(request.user)

        if player_count + 1 == game.maxPlayers:
            game.presenter().startGame(request)
            membership.refresh_from_db()
        else:
            game.gameStatus = "WAITING" if game.invitedPlayers.exists() else "AVAILABLE"
            game.latestUpdate = SR_getTimeNow()
            game.save(update_fields=["gameStatus", "latestUpdate"])

        game.refresh_from_db()
        return JsonResponse(
            {
                "gameID": game.id,
                "status": game.gameStatus,
                "alreadyJoined": False,
                "seat": membership.seat_order,
                "latestUpdate": str(game.latestUpdate),
            },
            status=201,
        )


def _serialize_game_snapshot(game, membership):
    players = [
        game_player
        for game_player in game.players.all()
        if game_player.player is not None and not game_player.is_kicked
    ]
    players.sort(key=lambda game_player: (
        game_player.seat_order is None,
        game_player.seat_order if game_player.seat_order is not None else 999,
        game_player.id,
    ))
    player_names = [game_player.player.username for game_player in players]
    my_seat = next(
        index for index, game_player in enumerate(players) if game_player.id == membership.id
    )
    current_players = [
        game_player.player.username for game_player in players if game_player.is_current
    ]

    presenter = game.presenter()
    move_data = ""
    actor_name = membership.player.username
    if presenter.hasValidActualMoveData(actor_name):
        move_data = presenter.getCompressedMoveArr(actor_name)

    return {
        "id": game.id,
        "gameName": game.gameName,
        "status": game.gameStatus,
        "turn": game.turn,
        "phase": game.phase,
        "latestUpdate": str(game.latestUpdate),
        "gameData": game.gameData,
        "startingMap": _json_field(game.startingMap, []),
        "startingOptions": _json_field(game.startingOptions, []),
        "playerNames": player_names,
        "displayNames": player_names,
        "currentPlayers": current_players,
        "mySeat": my_seat,
        "moveData": move_data,
        "chatData": game.chatData,
        "gameCreationTimestamp": game.created,
        "initializationSeed": f"{game.id}:{game.playerOrderSeed}",
    }


@require_GET
def game_snapshot(request, game_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    scope_error = _require_scope(request, "fcm:read")
    if scope_error:
        return scope_error
    game, membership, game_error = _load_member_game(request, game_id)
    if game_error:
        return game_error
    return JsonResponse(_serialize_game_snapshot(game, membership))


def _command_hash(game_id, expected_version, actions):
    canonical = json.dumps(
        {"gameID": game_id, "expectedVersion": expected_version, "actions": actions},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _next_version(current):
    return str(max(int(time.time()) * 1000, int(current) + 1))


def _accepted_move_phases(phase):
    if phase in {
        fcm_constants.PHASE_SETUP_RESTAURANT1,
        fcm_constants.PHASE_SETUP_RESTAURANT2,
        fcm_constants.PHASE_SETUP_RESERVE,
    }:
        return [
            fcm_constants.PHASE_SETUP_RESTAURANT1,
            fcm_constants.PHASE_SETUP_RESTAURANT2,
            fcm_constants.PHASE_SETUP_RESERVE,
        ]
    if phase == fcm_constants.PHASE_RESTRUCTURING:
        return [fcm_constants.PHASE_RESTRUCTURING, fcm_constants.PHASE_TURN_ORDER]
    return [
        fcm_constants.PHASE_WORKING_DAY,
        fcm_constants.PHASE_DINNERTIME,
        fcm_constants.PHASE_PAYDAY,
        fcm_constants.PHASE_MARKETING_CAMPAIGNS,
        fcm_constants.PHASE_CLEAN_UP,
        fcm_constants.PHASE_PIZZA_BOMB,
        fcm_constants.PHASE_COFFE_SHOP_MS,
        fcm_constants.PHASE_CHOOSE_CEO_BONUS,
    ]


def _validate_engine_commit(result, *, game_id, expected_version, actions, player_names):
    if not isinstance(result, dict):
        raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine result is not an object")
    if result.get("gameID") != game_id or result.get("beforeVersion") != expected_version:
        raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine result identity mismatch")
    if result.get("actions") != actions:
        raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine action echo mismatch")
    canonical = result.get("canonicalSave")
    simultaneous = result.get("simultaneousSubmission")
    if canonical is None and simultaneous is None:
        raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine returned no durable commit")
    if canonical is not None:
        if (
            not isinstance(canonical, dict)
            or canonical.get("gameID") != game_id
            or not isinstance(canonical.get("gameData"), str)
            or len(canonical["gameData"]) > 4 * 1024 * 1024
            or not isinstance(canonical.get("phase"), int)
            or not isinstance(canonical.get("turn"), int)
        ):
            raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine canonical save is invalid")
        next_players = canonical.get("nextPlayer", [])
        if not isinstance(next_players, list) or not set(next_players).issubset(set(player_names)):
            raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine returned unknown next players")
        if canonical.get("status") not in {None, "ACTIVE", "FINISHED"}:
            raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine returned an invalid game status")
    else:
        moves = simultaneous.get("moves") if isinstance(simultaneous, dict) else None
        pending = simultaneous.get("playersToMove") if isinstance(simultaneous, dict) else None
        if not isinstance(moves, list) or not isinstance(pending, list):
            raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine simultaneous save is invalid")
        if not set(pending).issubset(set(player_names)):
            raise AuthoritativeEngineError("ENGINE_FAILURE", "Engine returned unknown pending players")


def _replay_receipt(receipt, request_hash):
    if receipt.request_hash != request_hash:
        return _error(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used for a different command",
            409,
        )
    response = JsonResponse(receipt.response_json, status=receipt.http_status)
    response["X-OBG-Idempotent-Replay"] = "true"
    return response


@require_http_methods(["GET", "POST"])
def game_actions(request, game_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    scope_error = _require_scope(request, "fcm:read" if request.method == "GET" else "fcm:play")
    if scope_error:
        return scope_error
    game, membership, game_error = _load_member_game(request, game_id)
    if game_error:
        return game_error
    snapshot = _serialize_game_snapshot(game, membership)
    if request.method == "POST":
        payload, payload_error = _read_json_object(
            request, allowed_fields={"expectedVersion", "idempotencyKey", "actions"},
        )
        if payload_error:
            return payload_error
        expected_version = payload.get("expectedVersion")
        actions = payload.get("actions")
        if not isinstance(expected_version, str) or not expected_version.isdigit():
            return _error("INVALID_ARGUMENTS", "expectedVersion must be a numeric string", 400)
        if not isinstance(actions, list) or not 1 <= len(actions) <= 64:
            return _error("INVALID_ARGUMENTS", "actions must contain 1..64 items", 400)
        try:
            idempotency_key = uuid.UUID(str(payload.get("idempotencyKey")))
        except (TypeError, ValueError, AttributeError):
            return _error("INVALID_ARGUMENTS", "idempotencyKey must be a UUID", 400)
        request_hash = _command_hash(game.id, expected_version, actions)
        previous = AgentActionReceipt.objects.filter(
            actor=request.user, game=game, idempotency_key=idempotency_key,
        ).first()
        if previous:
            return _replay_receipt(previous, request_hash)
        if expected_version != str(game.latestUpdate):
            return _error("STALE_STATE", "The game changed; reload actions and retry", 409)

        presenter = game.presenter()
        existing_moves_raw = game.FCMplayersMoveData or ""
        existing_moves = presenter.getOrScaffoldAllMoveData()
        player_names = snapshot["playerNames"]
        moves_by_name = {
            entry[0]: entry for entry in existing_moves
            if isinstance(entry, list) and len(entry) >= 4
        }
        pending_players = []
        for name in player_names:
            entry = moves_by_name.get(name)
            phase_values = entry[1] if entry and isinstance(entry[1], list) else []
            if game.phase not in phase_values or not presenter.hasValidActualMoveData(name):
                pending_players.append(name)
        next_version = _next_version(game.latestUpdate)
        engine_command = {
            "operation": "execute",
            "payload": {
                "snapshot": snapshot,
                "actor": {"name": request.user.username, "seat": snapshot["mySeat"]},
                "expectedVersion": expected_version,
                "actions": actions,
                "transportContext": {
                    "existingMoves": existing_moves,
                    "pendingPlayerNames": pending_players,
                    "acceptedPhases": _accepted_move_phases(game.phase),
                    "nextVersion": next_version,
                    "sideData": _compress_side_data(existing_moves),
                },
            },
        }
        engine_started = time.monotonic()
        try:
            result = run_authoritative_engine(engine_command)
            _validate_engine_commit(
                result,
                game_id=game.id,
                expected_version=expected_version,
                actions=actions,
                player_names=player_names,
            )
        except AuthoritativeEngineError as error:
            status = 400 if error.code in {
                "ACTOR_MISMATCH", "INCOMPLETE_COMMAND", "INVALID_ENGINE_COMMAND",
                "INVALID_SNAPSHOT", "NOT_A_PLAYER", "ILLEGAL_ACTION", "INVALID_ACTION",
            } else (409 if error.code == "STALE_STATE" else 503)
            return _error(error.code, str(error), status)
        duration_ms = max(0, round((time.monotonic() - engine_started) * 1000))

        canonical = result.get("canonicalSave")
        simultaneous = result.get("simultaneousSubmission")
        with transaction.atomic():
            locked = Game.objects.select_for_update().get(id=game.id, gameCode="FCM")
            previous = AgentActionReceipt.objects.filter(
                actor=request.user, game=locked, idempotency_key=idempotency_key,
            ).first()
            if previous:
                return _replay_receipt(previous, request_hash)
            if (
                str(locked.latestUpdate) != expected_version
                or (locked.FCMplayersMoveData or "") != existing_moves_raw
            ):
                return _error("STALE_STATE", "The game changed during command execution", 409)

            pending = []
            if canonical is None:
                locked.FCMplayersMoveData = json.dumps(
                    simultaneous["moves"], separators=(",", ":"),
                )
                pending = simultaneous["playersToMove"]
                locked.latestUpdate = next_version
                locked.save(update_fields=["FCMplayersMoveData", "latestUpdate"])
            else:
                old_phase = locked.phase
                locked.gameData = canonical["gameData"]
                locked.phase = canonical["phase"]
                locked.turn = canonical["turn"]
                locked.latestUpdate = next_version
                if canonical.get("status") in {"ACTIVE", "FINISHED"}:
                    locked.gameStatus = canonical["status"]
                if isinstance(canonical.get("mapTiles"), list):
                    locked.startingMap = json.dumps(canonical["mapTiles"], separators=(",", ":"))
                update_fields = [
                    "gameData", "phase", "turn", "latestUpdate", "gameStatus", "startingMap",
                ]
                if old_phase != locked.phase and locked.phase in {
                    fcm_constants.PHASE_RESTRUCTURING,
                    fcm_constants.PHASE_WORKING_DAY,
                }:
                    locked.FCMplayersMoveData = ""
                    update_fields.append("FCMplayersMoveData")
                locked.save(update_fields=update_fields)
                pending = canonical.get("nextPlayer", [])

            locked.players.update(is_current=False)
            if pending:
                locked.players.filter(player__username__in=pending).update(is_current=True)

            response_payload = {
                "protocolVersion": result.get("protocolVersion"),
                "rulesetHash": result.get("rulesetHash"),
                "gameID": locked.id,
                "beforeVersion": expected_version,
                "version": next_version,
                "actions": actions,
                "resolved": canonical is not None,
                "pendingPlayers": pending,
                "state": result.get("state"),
                "legalActions": result.get("legalActions"),
            }
            AgentActionReceipt.objects.create(
                actor=request.user,
                game=locked,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                command_hash=request_hash,
                ruleset_hash=result.get("rulesetHash", ""),
                duration_ms=duration_ms,
                transport_action="authoritativeBatch",
                agent_action=actions[-1].get("type", "") if isinstance(actions[-1], dict) else "",
                before_version=expected_version,
                after_version=next_version,
                outcome=AgentActionReceipt.Outcome.SUCCEEDED,
                http_status=200,
                response_json=response_payload,
            )
        return JsonResponse(response_payload)

    try:
        result = run_authoritative_engine({
            "operation": "inspect",
            "payload": {
                "snapshot": snapshot,
                "actor": {
                    "name": request.user.username,
                    "seat": snapshot["mySeat"],
                },
            },
        })
    except AuthoritativeEngineError as error:
        status = 400 if error.code in {
            "ACTOR_MISMATCH", "INVALID_ENGINE_COMMAND", "INVALID_SNAPSHOT", "NOT_A_PLAYER"
        } else 503
        return _error(error.code, str(error), status)
    return JsonResponse(result)


@require_GET
def game_changes(request, game_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    scope_error = _require_scope(request, "fcm:read")
    if scope_error:
        return scope_error
    game, _membership, game_error = _load_member_game(request, game_id)
    if game_error:
        return game_error
    after_version = request.GET.get("afterVersion")
    if after_version is None or not after_version.isdigit() or len(after_version) > 32:
        return _error(
            "INVALID_ARGUMENTS",
            "afterVersion must be a numeric string no longer than 32 characters",
            400,
        )
    version = str(game.latestUpdate)
    return JsonResponse(
        {
            "gameID": game.id,
            "changed": after_version != version,
            "version": version,
            "status": game.gameStatus,
        }
    )


@require_GET
def command_receipt(request, game_id, idempotency_key):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    scope_error = _require_scope(request, "fcm:read")
    if scope_error:
        return scope_error
    game, _membership, game_error = _load_member_game(request, game_id)
    if game_error:
        return game_error

    receipt = AgentActionReceipt.objects.filter(
        actor=request.user,
        game=game,
        idempotency_key=idempotency_key,
    ).first()
    if receipt is None:
        return _error(
            "COMMAND_NOT_FOUND",
            "No completed command exists for this idempotency key",
            404,
        )
    return JsonResponse(
        {
            "command": {
                "idempotencyKey": str(receipt.idempotency_key),
                "commandHash": receipt.command_hash,
                "rulesetHash": receipt.ruleset_hash,
                "durationMs": receipt.duration_ms,
                "transportAction": receipt.transport_action,
                "agentAction": receipt.agent_action,
                "beforeVersion": receipt.before_version,
                "afterVersion": receipt.after_version,
                "outcome": receipt.outcome,
                "httpStatus": receipt.http_status,
                "response": receipt.response_json,
            }
        }
    )


def _identity_json(identity):
    return {
        "id": identity.id,
        "label": identity.label,
        "actorUsername": identity.actor_user.username,
        "active": identity.is_active,
        "createdAt": identity.created_at.isoformat(),
    }


def _credential_json(credential):
    return {
        "id": credential.id,
        "name": credential.name,
        "scopes": credential.scopes,
        "prefix": credential.prefix,
        "expiresAt": credential.expires_at.isoformat() if credential.expires_at else None,
    }


def _token_expiry(payload):
    days = payload.get("expiresInDays", 90)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 365:
        raise ValueError("expiresInDays must be an integer from 1 to 365")
    return timezone.now() + timedelta(days=days)


@require_GET
def agent_whoami(request):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    credential = getattr(request, "agent_credential", None)
    if credential is None:
        return JsonResponse({
            "username": request.user.username,
            "authentication": "session",
            "scopes": sorted(VALID_AGENT_SCOPES),
            "identity": None,
        })
    identity = credential.identity
    return JsonResponse({
        "username": request.user.username,
        "authentication": "pat",
        "scopes": credential.scopes,
        "credential": {
            "id": credential.id,
            "name": credential.name,
            "prefix": credential.prefix,
        },
        "identity": {
            **_identity_json(identity),
            "ownerUsername": identity.owner.username,
        },
    })


@require_http_methods(["GET", "POST"])
def agent_identities(request):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    if getattr(request, "agent_credential", None) is not None:
        return _error("OWNER_AUTH_REQUIRED", "Use the human owner session", 403)

    if request.method == "GET":
        identities = AgentIdentity.objects.filter(owner=request.user).select_related("actor_user")
        return JsonResponse({"identities": [_identity_json(item) for item in identities]})

    payload, payload_error = _read_json_object(
        request, allowed_fields={"label", "scopes", "expiresInDays"},
    )
    if payload_error:
        return payload_error
    label = payload.get("label")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80:
        return _error("INVALID_ARGUMENTS", "label must contain 1..80 characters", 400)
    try:
        scopes = validate_scopes(payload.get("scopes", list(DEFAULT_AGENT_SCOPES)))
        expires_at = _token_expiry(payload)
    except ValueError as error:
        return _error("INVALID_ARGUMENTS", str(error), 400)

    with transaction.atomic():
        username = f"fcm-agent-{request.user.id}-{uuid.uuid4().hex[:12]}"
        actor = User(username=username, is_active=True)
        actor.set_unusable_password()
        actor.save()
        identity = AgentIdentity.objects.create(
            owner=request.user, actor_user=actor, label=label.strip(),
        )
        credential, raw_token = issue_agent_token(
            identity, scopes=scopes, expires_at=expires_at,
        )
    return JsonResponse(
        {
            "identity": _identity_json(identity),
            "credential": _credential_json(credential),
            "token": raw_token,
        },
        status=201,
    )


@require_POST
def create_agent_token(request, identity_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    if getattr(request, "agent_credential", None) is not None:
        return _error("OWNER_AUTH_REQUIRED", "Use the human owner session", 403)
    identity = AgentIdentity.objects.filter(
        id=identity_id, owner=request.user, disabled_at__isnull=True,
    ).select_related("actor_user").first()
    if identity is None:
        return _error("AGENT_IDENTITY_NOT_FOUND", "Agent identity does not exist", 404)
    payload, payload_error = _read_json_object(
        request, allowed_fields={"name", "scopes", "expiresInDays"},
    )
    if payload_error:
        return payload_error
    name = payload.get("name", "default")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        return _error("INVALID_ARGUMENTS", "name must contain 1..80 characters", 400)
    try:
        scopes = validate_scopes(payload.get("scopes", list(DEFAULT_AGENT_SCOPES)))
        expires_at = _token_expiry(payload)
    except ValueError as error:
        return _error("INVALID_ARGUMENTS", str(error), 400)
    credential, raw_token = issue_agent_token(
        identity, scopes=scopes, name=name.strip(), expires_at=expires_at,
    )
    return JsonResponse({
        "credential": _credential_json(credential),
        "token": raw_token,
    }, status=201)


@require_http_methods(["DELETE"])
def disable_agent_identity(request, identity_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    if getattr(request, "agent_credential", None) is not None:
        return _error("OWNER_AUTH_REQUIRED", "Use the human owner session", 403)
    identity = AgentIdentity.objects.filter(
        id=identity_id, owner=request.user,
    ).select_related("actor_user").first()
    if identity is None:
        return _error("AGENT_IDENTITY_NOT_FOUND", "Agent identity does not exist", 404)
    now = timezone.now()
    with transaction.atomic():
        AgentIdentity.objects.filter(pk=identity.pk).update(disabled_at=now)
        User.objects.filter(pk=identity.actor_user_id).update(is_active=False)
        AgentCredential.objects.filter(
            identity=identity, revoked_at__isnull=True,
        ).update(revoked_at=now)
    return JsonResponse({}, status=204)


@require_http_methods(["DELETE"])
def revoke_agent_token(request, credential_id):
    auth_error = _require_user(request)
    if auth_error:
        return auth_error
    if getattr(request, "agent_credential", None) is not None:
        return _error("OWNER_AUTH_REQUIRED", "Use the human owner session", 403)
    credential = AgentCredential.objects.filter(
        id=credential_id, identity__owner=request.user,
    ).first()
    if credential is None:
        return _error("AGENT_TOKEN_NOT_FOUND", "Agent token does not exist", 404)
    if credential.revoked_at is None:
        credential.revoked_at = timezone.now()
        credential.save(update_fields=["revoked_at"])
    return JsonResponse({}, status=204)
