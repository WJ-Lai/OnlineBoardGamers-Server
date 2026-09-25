"""Run a real human-session + two-PAT-Agent FCM acceptance game."""

import json
import uuid
from datetime import datetime

from django.core.management.base import BaseCommand, CommandError
from django.test import Client

from FCM.agent_auth import issue_agent_token
from FCM.models import AgentIdentity
from Lobby.models import Game, User


class Command(BaseCommand):
    help = "Create and drive a real mixed FCM game through the authoritative Agent API"

    def add_arguments(self, parser):
        parser.add_argument("--owner", default="Vincent")
        parser.add_argument("--max-commands", type=int, default=500)
        parser.add_argument("--game-id", type=int)

    @staticmethod
    def _client():
        return Client(HTTP_HOST="127.0.0.1")

    @staticmethod
    def _json_post(client, url, payload):
        return client.post(url, data=json.dumps(payload), content_type="application/json")

    def _create_agent(self, owner_client, label):
        response = self._json_post(
            owner_client,
            "/FCM/agent/v1/identities/",
            {
                "label": label,
                "scopes": ["fcm:read", "fcm:play", "fcm:games:create"],
                "expiresInDays": 1,
            },
        )
        if response.status_code != 201:
            raise CommandError(f"cannot create {label}: {response.content!r}")
        return response.json()

    @staticmethod
    def _pick_actions(view):
        state = view["state"]
        legal = view["legalActions"]
        by_type = {action["type"]: action for action in legal["actions"]}
        phase = state["phase"]
        me = state["players"][state["mySeat"]]

        if phase in (0, 1):
            if me.get("restaurants"):
                return [{"type": "end_turn"}]
            square = by_type["place_restaurant"]["legalSquares"][0]
            return [{"type": "place_restaurant", "index": square}, {"type": "end_turn"}]
        if phase == 2:
            return [{"type": "choose_reserve_card", "cardValue": 1}]
        if phase == 3:
            entry = by_type["place_employees"]
            beach = list(entry["beach"])
            priority_groups = (
                {13, 14, 15, 16},  # marketing
                {27, 28, 29, 30, 31},  # food production
                {17, 18, 19},  # recruiting
            )
            selected = []
            for group in priority_groups:
                candidate = next((employee for employee in beach if employee in group), None)
                if candidate is not None:
                    selected.append(candidate)
                    beach.remove(candidate)
            selected.extend(beach)
            count = min(len(selected), len(entry["slots"]))
            if not count:
                return [{"type": "end_turn"}]
            return [{
                "type": "place_employees",
                "employees": selected[:count],
                "slots": entry["slots"][:count],
            }]
        if phase == 4:
            return [{
                "type": "choose_turn_order",
                "turnOrderPosition": by_type["choose_turn_order"]["positions"][0],
            }]
        if phase == 5:
            subphase = state.get("subphase")
            if subphase == 1:
                entry = by_type.get("hire", {})
                owned = {
                    employee for employee in (
                        list(me.get("employees", [])) + list(me.get("beach", []))
                    ) if isinstance(employee, int)
                }
                preferences = (
                    ("Recruiting Girl", {17, 18, 19}),
                    ("Kitchen Trainee", {27, 28, 29, 30, 31}),
                    ("Marketing Trainee", {13, 14, 15, 16}),
                )
                candidates = entry.get("candidates", [])
                def candidate_name(item):
                    value = item.get("name", "")
                    return value.get("title", "") if isinstance(value, dict) else str(value)
                candidate = next(
                    (item for name, role_ids in preferences for item in candidates
                     if not owned.intersection(role_ids) and name == candidate_name(item)),
                    None,
                )
                if candidate and entry.get("recruitingPoints", 0) > 0:
                    return [
                        {"type": "hire", "employee": candidate["id"]},
                        {"type": "next_subphase"},
                    ]
            elif subphase == 2:
                # This acceptance policy deliberately keeps its three core roles stable.
                # Training is already covered by contract tests; changing a core employee
                # here can leave a three-slot company unable to market and produce together.
                pass
            elif subphase == 3:
                marketing = by_type.get("marketing", {})
                for marketer in marketing.get("options", []):
                    for campaign in marketer.get("campaigns", []):
                        placement = next(
                            (item for item in campaign.get("placements", [])
                             if any(impact.get("houses") for impact in item.get("houseImpacts", []))),
                            next(
                                (item for item in campaign.get("placements", [])
                                 if item.get("legalSquares")),
                                None,
                            ),
                        )
                        if placement:
                            impacted = next(
                                (impact for impact in placement.get("houseImpacts", [])
                                 if impact.get("houses")),
                                None,
                            )
                            return [
                                {
                                    "type": "marketing", "marketer": marketer["marketer"],
                                    "campaign": campaign["campaign"], "good": 4,
                                    "duration": 9 if campaign["durationInfinite"] else 1,
                                    "rotated": placement["rotated"],
                                    "index": (
                                        impacted["index"] if impacted
                                        else placement["legalSquares"][0]
                                    ),
                                },
                                {"type": "next_subphase"},
                            ]
            elif subphase == 4:
                producers = by_type.get("produce", {}).get("producers", [])
                if producers:
                    producer = producers[0]
                    item = 4 if 4 in producer["goods"] else producer["goods"][0]
                    return [
                        {
                            "type": "produce", "producer": producer["id"],
                            "item": item, "amount": 1,
                        },
                        {"type": "next_subphase"},
                    ]
            if "next_subphase" in by_type:
                return [{"type": "next_subphase"}]
            return [{"type": "end_turn"}]
        if phase == 7:
            payday = by_type["resolve_payday"]
            return [{
                "type": "resolve_payday",
                "fireEmployees": [] if payday["currentlyAffordable"] else payday["fireableEmployees"],
                "payWithResources": [],
            }]
        if phase == 9:
            cleanup = by_type["resolve_cleanup"]
            count = cleanup.get("minimumDiscardCount", 0)
            action = {
                "type": "resolve_cleanup",
                "discardResources": cleanup.get("resources", [])[:count],
            }
            if cleanup.get("requiresFridgeChoice"):
                action["fridgeChoice"] = "rest"
            return [action]
        if phase == 11:
            pizza = by_type["place_pizza_radio"]
            if pizza.get("legalSquares"):
                return [{
                    "type": "place_pizza_radio", "campaign": pizza["campaign"],
                    "house": pizza["house"], "index": pizza["legalSquares"][0],
                }]
            return [{
                "type": "place_pizza_radio", "campaign": pizza["campaign"],
                "house": pizza["house"], "skip": True,
            }]
        return None

    def handle(self, *args, **options):
        try:
            owner = User.objects.get(username=options["owner"])
        except User.DoesNotExist as error:
            raise CommandError(f"owner {options['owner']!r} does not exist") from error

        owner_client = self._client()
        owner_client.force_login(owner)
        suffix = datetime.now().strftime("%m%d-%H%M%S")
        clients = [owner_client]
        if options["game_id"]:
            game_id = options["game_id"]
            game = Game.objects.prefetch_related("players__player").get(id=game_id, gameCode="FCM")
            if not game.players.filter(player=owner, is_kicked=False).exists():
                raise CommandError("owner is not an active player in the requested game")
            agent_users = [
                membership.player for membership in game.players.all()
                if membership.player_id != owner.id and not membership.is_kicked
            ]
            if len(agent_users) != 2:
                raise CommandError("resume requires exactly two Agent seats")
            agents = []
            for actor in agent_users:
                identity = AgentIdentity.objects.get(
                    owner=owner, actor_user=actor, disabled_at__isnull=True,
                )
                _credential, token = issue_agent_token(identity, name="acceptance-resume")
                agents.append({"token": token})
        else:
            agents = [
                self._create_agent(owner_client, f"Acceptance Red {suffix}"),
                self._create_agent(owner_client, f"Acceptance Blue {suffix}"),
            ]
            created = self._json_post(
                owner_client,
                "/FCM/agent/v1/games/",
                {"gameName": f"Human + 2 Agents {suffix}", "maxPlayers": 3},
            )
            if created.status_code != 201:
                raise CommandError(f"cannot create game: {created.content!r}")
            game_id = created.json()["game"]["id"]

        for agent in agents:
            client = self._client()
            client.defaults["HTTP_AUTHORIZATION"] = f"Bearer {agent['token']}"
            if not options["game_id"]:
                joined = self._json_post(client, f"/FCM/agent/v1/games/{game_id}/join/", {})
                if joined.status_code != 201:
                    raise CommandError(f"agent cannot join: {joined.content!r}")
            clients.append(client)

        commands = 0
        idle_rounds = 0
        while commands < options["max_commands"]:
            game = Game.objects.get(id=game_id)
            if game.gameStatus == "FINISHED" or game.phase == 10:
                self.stdout.write(self.style.SUCCESS(
                    f"GAME_OVER game={game_id} commands={commands} turn={game.turn} "
                    f"url=http://127.0.0.1:8000/FCM/{game_id}/show/",
                ))
                return
            progressed = False
            for client in clients:
                inspected = client.get(f"/FCM/agent/v1/games/{game_id}/actions/")
                if inspected.status_code != 200:
                    raise CommandError(f"inspect failed: {inspected.content!r}")
                view = inspected.json()
                if not view["legalActions"]["yourTurn"]:
                    continue
                actions = self._pick_actions(view)
                if not actions:
                    continue
                result = self._json_post(
                    client,
                    f"/FCM/agent/v1/games/{game_id}/actions/",
                    {
                        "expectedVersion": view["version"],
                        "idempotencyKey": str(uuid.uuid4()),
                        "actions": actions,
                    },
                )
                if result.status_code != 200:
                    raise CommandError(
                        f"command failed at phase={view['state']['phase']} "
                        f"subphase={view['state'].get('subphase')}: {result.content!r}",
                    )
                commands += 1
                progressed = True
                if commands >= options["max_commands"]:
                    break
            idle_rounds = 0 if progressed else idle_rounds + 1
            if idle_rounds >= 2:
                game = Game.objects.get(id=game_id)
                raise CommandError(
                    f"game stalled at phase={game.phase} turn={game.turn}; game={game_id}",
                )
        game = Game.objects.get(id=game_id)
        raise CommandError(
            f"command budget exhausted at phase={game.phase} turn={game.turn}; game={game_id}",
        )
