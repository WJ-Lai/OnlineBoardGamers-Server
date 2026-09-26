import base64
import gzip
import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from FCM import FCMconstants as fcm_constants
from FCM.agent_auth import issue_agent_token
from FCM.engine_runner import AuthoritativeEngineError
from FCM.management.commands.run_agent_acceptance import Command as AcceptanceCommand
from FCM.models import AgentActionReceipt, AgentCredential, AgentIdentity
from Lobby.models import Game, GamePlayer, User


class FCMAcceptancePolicyTestCase(TestCase):
    def test_restructuring_prioritizes_marketing_production_and_recruiting(self):
        view = {
            "state": {
                "phase": 3,
                "mySeat": 0,
                "players": [{"employees": [], "beach": [17, 20, 27, 13]}],
            },
            "legalActions": {
                "actions": [{
                    "type": "place_employees",
                    "beach": [17, 20, 27, 13],
                    "slots": [0, 1, 2],
                }],
            },
        }

        self.assertEqual(AcceptanceCommand._pick_actions(view), [{
            "type": "place_employees",
            "employees": [13, 27, 17],
            "slots": [0, 1, 2],
        }])

    def test_hiring_stops_after_the_three_core_roles_are_owned(self):
        view = {
            "state": {
                "phase": 5,
                "subphase": 1,
                "mySeat": 0,
                "players": [{
                    "employees": [17, 13], "beach": [27],
                }],
            },
            "legalActions": {
                "actions": [
                    {
                        "type": "hire",
                        "recruitingPoints": 2,
                        "candidates": [{"id": 20, "name": {"title": "Trainer"}}],
                    },
                    {"type": "next_subphase"},
                ],
            },
        }

        self.assertEqual(
            AcceptanceCommand._pick_actions(view),
            [{"type": "next_subphase"}],
        )

    def test_training_does_not_remove_a_core_role_from_the_next_workday(self):
        view = {
            "state": {
                "phase": 5,
                "subphase": 2,
                "mySeat": 0,
                "players": [{"employees": [17, 13, 27], "beach": []}],
            },
            "legalActions": {
                "actions": [
                    {
                        "type": "train",
                        "available": [{
                            "id": 27, "origin": "employees",
                            "upgrades": [{"id": 28, "steps": 1}],
                        }],
                    },
                    {"type": "next_subphase"},
                ],
            },
        }

        self.assertEqual(
            AcceptanceCommand._pick_actions(view),
            [{"type": "next_subphase"}],
        )

    def test_marketing_prefers_a_placement_that_reaches_a_house(self):
        view = {
            "state": {
                "phase": 5, "subphase": 3, "mySeat": 0,
                "players": [{"employees": [13], "beach": []}],
            },
            "legalActions": {
                "actions": [
                    {
                        "type": "marketing",
                        "options": [{
                            "marketer": 13,
                            "campaigns": [{
                                "campaign": 11,
                                "durationInfinite": False,
                                "placements": [{
                                    "rotated": False,
                                    "legalSquares": [100, 101],
                                    "houseImpacts": [
                                        {"index": 100, "houses": []},
                                        {"index": 101, "houses": [18]},
                                    ],
                                }],
                            }],
                        }],
                    },
                    {"type": "next_subphase"},
                ],
            },
        }

        actions = AcceptanceCommand._pick_actions(view)
        self.assertEqual(actions[0]["type"], "marketing")
        self.assertEqual(actions[0]["index"], 101)

    def test_production_matches_the_burger_used_by_the_marketing_policy(self):
        view = {
            "state": {
                "phase": 5, "subphase": 4, "mySeat": 0,
                "players": [{"employees": [27], "beach": []}],
            },
            "legalActions": {
                "actions": [
                    {
                        "type": "produce",
                        "producers": [{"id": 27, "goods": [3, 4]}],
                    },
                    {"type": "next_subphase"},
                ],
            },
        }

        actions = AcceptanceCommand._pick_actions(view)
        self.assertEqual(actions[0], {
            "type": "produce", "producer": 27, "item": 4, "amount": 1,
        })


class FCMAgentAPITestCase(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username="agent_alice", password="pw")
        self.bob = User.objects.create_user(username="agent_bob", password="pw")
        self.outsider = User.objects.create_user(username="agent_outsider", password="pw")
        self.game = Game.objects.create(
            gameCode="FCM",
            gameName="Agent test",
            gameDescription="contract fixture",
            creator=self.alice,
            host=self.alice,
            gameStatus="ACTIVE",
            maxPlayers=2,
            turn=3,
            phase=5,
            created="1000",
            latestUpdate="123456",
            startingOptions="[]",
            startingMap="[1,2,3]",
            gameData="opaque-blob",
        )
        GamePlayer.objects.create(
            game=self.game, player=self.alice, seat_order=0, is_current=True,
        )
        GamePlayer.objects.create(
            game=self.game, player=self.bob, seat_order=1, is_current=False,
        )

    def test_agent_api_requires_authentication_with_json_401(self):
        response = self.client.get("/FCM/agent/v1/games/")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "AUTH_REQUIRED")

    def test_list_games_is_paginated_and_does_not_leak_private_unrelated_games(self):
        Game.objects.create(
            gameCode="FCM",
            gameName="Someone else's private game",
            creator=self.outsider,
            host=self.outsider,
            gameStatus="PRIVATE",
            maxPlayers=2,
        )
        self.client.force_login(self.alice)
        response = self.client.get("/FCM/agent/v1/games/?limit=1&offset=0")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["games"][0]["id"], self.game.id)
        self.assertNotIn("gameData", payload["games"][0])

    def test_list_games_rejects_hostile_pagination_values(self):
        self.client.force_login(self.alice)
        for query in ("limit=0", "limit=101", "limit=abc", "offset=-1"):
            with self.subTest(query=query):
                response = self.client.get(f"/FCM/agent/v1/games/?{query}")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "INVALID_ARGUMENTS")

    def test_snapshot_rejects_authenticated_non_player(self):
        self.client.force_login(self.outsider)
        response = self.client.get(
            f"/FCM/agent/v1/games/{self.game.id}/snapshot/",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "NOT_A_PLAYER")

    def test_snapshot_returns_ordered_player_scoped_contract(self):
        AgentIdentity.objects.create(
            owner=self.outsider, actor_user=self.bob, label="Blue Bot",
        )
        self.client.force_login(self.alice)
        response = self.client.get(
            f"/FCM/agent/v1/games/{self.game.id}/snapshot/",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], self.game.id)
        self.assertEqual(payload["latestUpdate"], "123456")
        self.assertEqual(payload["playerNames"], ["agent_alice", "agent_bob"])
        self.assertEqual(payload["displayNames"], ["agent_alice", "Blue Bot"])
        self.assertEqual(payload["mySeat"], 0)
        self.assertEqual(payload["gameData"], "opaque-blob")
        self.assertEqual(payload["startingMap"], [1, 2, 3])

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_actions_are_computed_server_side_for_authenticated_member(self, run_engine):
        run_engine.return_value = {
            "protocolVersion": "fcm-engine-v1",
            "rulesetHash": "a" * 64,
            "gameID": self.game.id,
            "version": "123456",
            "state": {"mySeat": 1},
            "legalActions": {"yourTurn": True, "actions": [{"type": "hire"}]},
        }
        self.client.force_login(self.bob)

        response = self.client.get(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["rulesetHash"], "a" * 64)
        command = run_engine.call_args.args[0]
        self.assertEqual(command["operation"], "inspect")
        self.assertEqual(command["payload"]["actor"], {"name": "agent_bob", "seat": 1})
        self.assertEqual(command["payload"]["snapshot"]["gameData"], "opaque-blob")

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_actions_reject_non_member_before_starting_engine(self, run_engine):
        self.client.force_login(self.outsider)
        response = self.client.get(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "NOT_A_PLAYER")
        run_engine.assert_not_called()

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_command_commits_only_engine_generated_canonical_state(self, run_engine):
        key = str(uuid.uuid4())
        run_engine.return_value = {
            "protocolVersion": "fcm-engine-v1",
            "rulesetHash": "c" * 64,
            "gameID": self.game.id,
            "beforeVersion": "123456",
            "actions": [{"type": "next_subphase"}],
            "canonicalSave": {
                "action": "saveNormal",
                "gameID": self.game.id,
                "gameData": "engine-owned-blob",
                "phase": 5,
                "turn": 3,
                "nextPlayer": ["agent_alice"],
                "status": "ACTIVE",
            },
            "simultaneousSubmission": None,
            "state": {"phase": 5, "turn": 3, "subphase": 2},
            "legalActions": {"yourTurn": True, "actions": [{"type": "train"}]},
        }
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456",
                "idempotencyKey": key,
                "actions": [{"type": "next_subphase"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.game.refresh_from_db()
        self.assertEqual(self.game.gameData, "engine-owned-blob")
        self.assertNotEqual(self.game.latestUpdate, "123456")
        self.assertEqual(response.json()["version"], self.game.latestUpdate)
        self.assertNotIn("canonicalSave", response.json())
        receipt = AgentActionReceipt.objects.get(idempotency_key=key)
        self.assertEqual(receipt.actor, self.alice)
        self.assertEqual(receipt.before_version, "123456")
        self.assertEqual(receipt.after_version, self.game.latestUpdate)
        transport = run_engine.call_args.args[0]["payload"]["transportContext"]
        side_data = json.loads(gzip.decompress(base64.b64decode(transport["sideData"])))
        self.assertEqual([entry[0] for entry in side_data], ["agent_alice", "agent_bob"])

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_entering_restructuring_clears_previous_simultaneous_move_data(self, run_engine):
        self.game.FCMplayersMoveData = json.dumps([
            ["agent_alice", [5, 6, 7, 8, 9], "1", [[[-8], []], [-9]]],
            ["agent_bob", [5, 6, 7, 8, 9], "1", [[[-8], []], [-9]]],
        ])
        self.game.save(update_fields=["FCMplayersMoveData"])
        run_engine.return_value = {
            "protocolVersion": "fcm-engine-v1",
            "rulesetHash": "e" * 64,
            "gameID": self.game.id,
            "beforeVersion": "123456",
            "actions": [{"type": "end_turn"}],
            "canonicalSave": {
                "action": "saveNormal", "gameID": self.game.id,
                "gameData": "next-round-blob", "phase": 3, "turn": 4,
                "nextPlayer": ["agent_alice", "agent_bob"], "status": "ACTIVE",
            },
            "simultaneousSubmission": None,
            "state": {"phase": 3, "turn": 4},
            "legalActions": {"yourTurn": True, "actions": []},
        }
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456", "idempotencyKey": str(uuid.uuid4()),
                "actions": [{"type": "end_turn"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.game.refresh_from_db()
        self.assertEqual(self.game.FCMplayersMoveData, "")

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_stale_command_is_rejected_before_engine_execution(self, run_engine):
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123455",
                "idempotencyKey": str(uuid.uuid4()),
                "actions": [{"type": "next_subphase"}],
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "STALE_STATE")
        run_engine.assert_not_called()

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_illegal_action_is_a_client_error_not_an_engine_outage(self, run_engine):
        run_engine.side_effect = AuthoritativeEngineError(
            "ILLEGAL_ACTION", "The requested move is not legal in this state",
        )
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456",
                "idempotencyKey": str(uuid.uuid4()),
                "actions": [{"type": "next_subphase"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "ILLEGAL_ACTION")

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_engine_cannot_select_an_unknown_next_player(self, run_engine):
        run_engine.return_value = {
            "protocolVersion": "fcm-engine-v1",
            "rulesetHash": "c" * 64,
            "gameID": self.game.id,
            "beforeVersion": "123456",
            "actions": [{"type": "next_subphase"}],
            "canonicalSave": {
                "action": "saveNormal",
                "gameID": self.game.id,
                "gameData": "engine-owned-blob",
                "phase": 5,
                "turn": 3,
                "nextPlayer": ["unknown-player"],
                "status": "ACTIVE",
            },
            "simultaneousSubmission": None,
            "state": {"phase": 5, "turn": 3},
            "legalActions": {"yourTurn": False, "actions": []},
        }
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456",
                "idempotencyKey": str(uuid.uuid4()),
                "actions": [{"type": "next_subphase"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "ENGINE_FAILURE")
        self.game.refresh_from_db()
        self.assertEqual(self.game.gameData, "opaque-blob")

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_engine_timeout_never_mutates_the_game_or_creates_a_receipt(self, run_engine):
        run_engine.side_effect = AuthoritativeEngineError(
            "ENGINE_TIMEOUT", "Engine exceeded its execution deadline",
        )
        self.client.force_login(self.alice)
        key = str(uuid.uuid4())
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456",
                "idempotencyKey": key,
                "actions": [{"type": "next_subphase"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "ENGINE_TIMEOUT")
        self.game.refresh_from_db()
        self.assertEqual(self.game.gameData, "opaque-blob")
        self.assertEqual(self.game.latestUpdate, "123456")
        self.assertFalse(AgentActionReceipt.objects.filter(idempotency_key=key).exists())

    @patch("FCM.agent_api.run_authoritative_engine")
    def test_nonfinal_simultaneous_command_stores_only_the_generated_move(self, run_engine):
        key = str(uuid.uuid4())
        generated_moves = [
            ["agent_alice", [3, 4], "1", [[10], [], 0]],
            ["agent_bob", [-1], "", []],
        ]
        run_engine.return_value = {
            "protocolVersion": "fcm-engine-v1",
            "rulesetHash": "d" * 64,
            "gameID": self.game.id,
            "beforeVersion": "123456",
            "actions": [{"type": "place_employees", "slots": [0], "employees": [10]}],
            "canonicalSave": None,
            "simultaneousSubmission": {
                "moves": generated_moves,
                "playersToMove": ["agent_bob"],
            },
            "state": {"phase": 3, "turn": 3},
            "legalActions": {"yourTurn": False, "actions": []},
        }
        self.client.force_login(self.alice)
        response = self.client.post(
            f"/FCM/agent/v1/games/{self.game.id}/actions/",
            data=json.dumps({
                "expectedVersion": "123456",
                "idempotencyKey": key,
                "actions": [{"type": "place_employees", "slots": [0], "employees": [10]}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.game.refresh_from_db()
        self.assertEqual(self.game.gameData, "opaque-blob")
        self.assertEqual(json.loads(self.game.FCMplayersMoveData), generated_moves)
        self.assertEqual(response.json()["pendingPlayers"], ["agent_bob"])

    def test_change_probe_is_member_only_and_compares_versions_as_strings(self):
        url = f"/FCM/agent/v1/games/{self.game.id}/changes/"
        self.client.force_login(self.alice)
        same = self.client.get(url, {"afterVersion": "123456"})
        old = self.client.get(url, {"afterVersion": "123455"})
        self.assertFalse(same.json()["changed"])
        self.assertTrue(old.json()["changed"])
        self.assertEqual(old.json()["version"], "123456")

        self.client.force_login(self.outsider)
        denied = self.client.get(url, {"afterVersion": "123455"})
        self.assertEqual(denied.status_code, 403)

    def test_command_receipt_is_actor_scoped_and_machine_readable(self):
        self.client.force_login(self.alice)
        key = str(uuid.uuid4())
        AgentActionReceipt.objects.create(
            actor=self.alice,
            game=self.game,
            idempotency_key=key,
            request_hash="b" * 64,
            command_hash="b" * 64,
            transport_action="authoritativeBatch",
            agent_action="next_subphase",
            before_version="123456",
            after_version="123457",
            outcome=AgentActionReceipt.Outcome.SUCCEEDED,
            http_status=200,
            response_json={"ok": True},
        )

        url = f"/FCM/agent/v1/games/{self.game.id}/commands/{key}/"
        found = self.client.get(url)
        self.assertEqual(found.status_code, 200)
        self.assertEqual(found.json()["command"]["idempotencyKey"], key)
        self.assertEqual(found.json()["command"]["commandHash"], "b" * 64)
        self.assertEqual(found.json()["command"]["outcome"], "SUCCEEDED")
        self.assertIn("rulesetHash", found.json()["command"])
        self.assertIn("durationMs", found.json()["command"])

        self.client.force_login(self.bob)
        hidden = self.client.get(url)
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(hidden.json()["error"]["code"], "COMMAND_NOT_FOUND")

class FCMAgentCreateJoinTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username="creator_agent", password="pw")
        self.bob = User.objects.create_user(username="joining_agent", password="pw")
        self.mallory = User.objects.create_user(username="mallory_agent", password="pw")
        self.charlie = User.objects.create_user(username="third_agent", password="pw")

    def test_create_base_game_uses_authenticated_actor_and_strict_fields(self):
        self.client.force_login(self.alice)
        response = self.client.post(
            "/FCM/agent/v1/games/",
            data=json.dumps({
                "gameName": "Agent-created game",
                "gameDescription": "base game",
                "maxPlayers": 4,
                "invitedUsernames": [self.bob.username, self.mallory.username],
            }),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        game = Game.objects.get(id=response.json()["game"]["id"])
        self.assertEqual(game.creator, self.alice)
        self.assertEqual(game.gameStatus, "WAITING")
        self.assertEqual(game.maxPlayers, 4)
        self.assertEqual(
            response.json()["game"]["gameURL"],
            f"http://testserver/FCM/{game.id}/show/",
        )
        self.assertEqual(
            response.json()["game"]["inviteURL"],
            f"http://testserver/join/FCM{game.id}/",
        )
        self.assertEqual(list(game.players.values_list("player__username", flat=True)), [self.alice.username])
        self.assertTrue(game.invitedPlayers.filter(id=self.bob.id).exists())
        self.assertTrue(game.invitedPlayers.filter(id=self.mallory.id).exists())

    def test_create_rejects_actor_and_ruleset_smuggling(self):
        self.client.force_login(self.alice)
        hostile_payloads = [
            {"gameName": "x", "creator": self.mallory.username},
            {"gameName": "x", "maxPlayers": 1},
            {"gameName": "x", "maxPlayers": 7},
            {"gameName": "x", "startingOptions": [46]},
            {"gameName": "x", "invitedUsernames": [self.alice.username]},
            {"gameName": "x", "invitedUsernames": [self.bob.username, self.bob.username]},
            {
                "gameName": "x",
                "maxPlayers": 2,
                "invitedUsernames": [self.bob.username, self.mallory.username],
            },
        ]
        for payload in hostile_payloads:
            with self.subTest(payload=payload):
                response = self.client.post(
                    "/FCM/agent/v1/games/",
                    data=json.dumps(payload),
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(Game.objects.count(), 0)

    def _waiting_game(self, *, private=False, invite_bob=True):
        game = Game.objects.create(
            gameCode="FCM",
            gameName="Join target",
            creator=self.alice,
            host=self.alice,
            gameStatus="PRIVATE" if private else "WAITING",
            maxPlayers=2,
            startingOptions="[]",
            FCMnotificationSuppression="00",
        )
        GamePlayer.objects.create(game=game, player=self.alice, seat_order=0)
        if invite_bob:
            game.invitedPlayers.add(self.bob)
        return game

    def test_uninvited_actor_cannot_bypass_private_or_reserved_game(self):
        for private in (False, True):
            with self.subTest(private=private):
                game = self._waiting_game(private=private)
                self.client.force_login(self.mallory)
                response = self.client.post(
                    f"/FCM/agent/v1/games/{game.id}/join/",
                    data="{}",
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 403)
                self.assertFalse(game.players.filter(player=self.mallory).exists())

    @patch("Lobby.presenters.FCMpresenter._sendStartGameNotification")
    def test_invited_second_player_joins_once_and_starts_game(self, _notify):
        game = self._waiting_game()
        self.client.force_login(self.bob)
        first = self.client.post(
            f"/FCM/agent/v1/games/{game.id}/join/",
            data="{}",
            content_type="application/json",
        )
        second = self.client.post(
            f"/FCM/agent/v1/games/{game.id}/join/",
            data="{}",
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.json()["alreadyJoined"])
        self.assertEqual(game.players.filter(player=self.bob).count(), 1)
        game.refresh_from_db()
        self.assertEqual(game.gameStatus, "ACTIVE")

    def test_full_game_returns_conflict_without_mutation(self):
        game = self._waiting_game(invite_bob=False)
        GamePlayer.objects.create(game=game, player=self.mallory, seat_order=1)
        self.client.force_login(self.bob)
        response = self.client.post(
            f"/FCM/agent/v1/games/{game.id}/join/",
            data="{}",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "GAME_FULL")
        self.assertFalse(game.players.filter(player=self.bob).exists())

    @patch("Lobby.presenters.FCMpresenter._sendStartGameNotification")
    def test_multiple_independent_agent_accounts_can_fill_a_four_player_game(self, _notify):
        self.client.force_login(self.alice)
        created = self.client.post(
            "/FCM/agent/v1/games/",
            data=json.dumps({"gameName": "All agents", "maxPlayers": 4}),
            content_type="application/json",
        )
        game_id = created.json()["game"]["id"]

        for index, user in enumerate((self.bob, self.mallory, self.charlie), start=2):
            self.client.force_login(user)
            response = self.client.post(
                f"/FCM/agent/v1/games/{game_id}/join/",
                data="{}",
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 201)
            expected_status = "ACTIVE" if index == 4 else "AVAILABLE"
            self.assertEqual(response.json()["status"], expected_status)

        game = Game.objects.get(id=game_id)
        self.assertEqual(game.players.filter(is_kicked=False).count(), 4)
        self.assertEqual(game.gameStatus, "ACTIVE")


class FCMAgentIdentityTokenTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="human_owner", password="pw")
        self.other = User.objects.create_user(username="other_owner", password="pw")

    def _create_identity(self, *, label="My Red Bot"):
        self.client.force_login(self.owner)
        body = {"label": label}
        return self.client.post(
            "/FCM/agent/v1/identities/",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_owner_creates_passwordless_agent_identity_and_one_time_pat(self):
        response = self._create_identity()
        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertRegex(payload["token"], r"^obg_pat_[A-Za-z0-9_-]+$")
        identity = AgentIdentity.objects.get(id=payload["identity"]["id"])
        self.assertEqual(identity.owner, self.owner)
        self.assertFalse(identity.actor_user.has_usable_password())
        self.assertNotIn("secretHash", json.dumps(payload))
        credential = identity.credentials.get()
        self.assertEqual(
            credential.scopes,
            ["fcm:games:create", "fcm:play", "fcm:read"],
        )
        self.assertIsNone(credential.expires_at)

    def test_bootstrap_requires_an_agent_token_not_an_owner_session(self):
        anonymous = self.client.get("/FCM/agent/v1/bootstrap/")
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(anonymous.json()["error"]["code"], "AGENT_TOKEN_REQUIRED")
        self.assertIn("Authorization", anonymous.json()["error"]["message"])

        self.client.force_login(self.owner)
        owner_session = self.client.get("/FCM/agent/v1/bootstrap/")
        self.assertEqual(owner_session.status_code, 403)
        self.assertEqual(owner_session.json()["error"]["code"], "AGENT_TOKEN_REQUIRED")

    def test_bootstrap_rejects_a_token_that_cannot_complete_the_play_workflow(self):
        created = self._create_identity().json()
        identity = AgentIdentity.objects.get(id=created["identity"]["id"])
        _credential, read_only_token = issue_agent_token(identity, scopes=["fcm:read"])
        self.client.logout()

        response = self.client.get(
            "/FCM/agent/v1/bootstrap/",
            HTTP_AUTHORIZATION=f"Bearer {read_only_token}",
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "INSUFFICIENT_SCOPE")
        self.assertIn("fcm:play", response.json()["error"]["message"])

    def test_bootstrap_is_self_describing_and_never_echoes_the_token(self):
        created = self._create_identity().json()
        token = created["token"]
        self.client.logout()

        response = self.client.get(
            "/FCM/agent/v1/bootstrap/",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        rendered = json.dumps(payload)
        self.assertEqual(payload["protocol"], "fcm-agent-v1")
        self.assertEqual(payload["authenticatedAs"], created["identity"]["actorUsername"])
        self.assertEqual([step["action"] for step in payload["workflow"]], [
            "list_games", "join_game", "read_legal_actions", "play",
        ])
        self.assertIn("/FCM/agent/v1/games/", payload["workflow"][0]["url"])
        self.assertNotIn(token, rendered)
        self.assertIn("Never invent an action", rendered)

    def test_identity_creation_rejects_permission_fields_from_the_public_contract(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/v1/identities/",
            data=json.dumps({"label": "No Scope UI", "scopes": []}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "INVALID_ARGUMENTS")
        self.assertFalse(AgentIdentity.objects.exists())

    def test_pat_authenticates_as_agent_seat_without_session_or_password(self):
        created = self._create_identity().json()
        identity = AgentIdentity.objects.get(id=created["identity"]["id"])
        game = Game.objects.create(
            gameCode="FCM", gameName="Token game", creator=self.owner,
            host=self.owner, gameStatus="ACTIVE", maxPlayers=2,
        )
        GamePlayer.objects.create(game=game, player=identity.actor_user, seat_order=1)
        self.client.logout()

        response = self.client.get(
            f"/FCM/agent/v1/games/{game.id}/snapshot/",
            HTTP_AUTHORIZATION=f"Bearer {created['token']}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mySeat"], 0)

        whoami = self.client.get(
            "/FCM/agent/v1/whoami/",
            HTTP_AUTHORIZATION=f"Bearer {created['token']}",
        )
        self.assertEqual(whoami.status_code, 200)
        self.assertEqual(whoami.json()["username"], identity.actor_user.username)
        self.assertEqual(whoami.json()["identity"]["ownerUsername"], self.owner.username)

    def test_read_only_pat_cannot_create_or_join_games(self):
        created = self._create_identity().json()
        identity = AgentIdentity.objects.get(id=created["identity"]["id"])
        _credential, read_only_token = issue_agent_token(identity, scopes=["fcm:read"])
        self.client.logout()
        headers = {"HTTP_AUTHORIZATION": f"Bearer {read_only_token}"}
        response = self.client.post(
            "/FCM/agent/v1/games/",
            data=json.dumps({"gameName": "forbidden"}),
            content_type="application/json",
            **headers,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "INSUFFICIENT_SCOPE")
        self.assertFalse(Game.objects.exists())

    def test_revoked_pat_and_cross_owner_revocation_are_rejected(self):
        created = self._create_identity().json()
        credential = AgentCredential.objects.get(identity_id=created["identity"]["id"])

        self.client.force_login(self.other)
        forbidden = self.client.delete(f"/FCM/agent/v1/tokens/{credential.id}/")
        self.assertEqual(forbidden.status_code, 404)

        self.client.force_login(self.owner)
        revoked = self.client.delete(f"/FCM/agent/v1/tokens/{credential.id}/")
        self.assertEqual(revoked.status_code, 204)
        self.client.logout()

        denied = self.client.get(
            "/FCM/agent/v1/games/",
            HTTP_AUTHORIZATION=f"Bearer {created['token']}",
        )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(denied.json()["error"]["code"], "INVALID_TOKEN")

    def test_agent_can_restart_with_the_same_pat_without_session_state(self):
        created = self._create_identity().json()
        headers = {"HTTP_AUTHORIZATION": f"Bearer {created['token']}"}
        first_process = self.client_class()
        second_process = self.client_class()

        first = first_process.get("/FCM/agent/v1/whoami/", **headers)
        restarted = second_process.get("/FCM/agent/v1/whoami/", **headers)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(restarted.status_code, 200)
        self.assertEqual(first.json()["username"], restarted.json()["username"])
        self.assertNotIn("sessionid", first_process.cookies)
        self.assertNotIn("sessionid", second_process.cookies)

    def test_refresh_keeps_agent_identity_and_replaces_its_only_token(self):
        created = self._create_identity(label="Persistent Bot").json()
        identity = AgentIdentity.objects.get(id=created["identity"]["id"])
        actor_id = identity.actor_user_id
        old_token = created["token"]

        response = self.client.post(
            f"/FCM/agent/v1/identities/{identity.id}/tokens/",
            data="{}",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(identity.credentials.count(), 1)
        self.assertNotEqual(response.json()["token"], old_token)
        identity.refresh_from_db()
        self.assertEqual(identity.actor_user_id, actor_id)
        self.client.logout()
        self.assertEqual(
            self.client.get(
                "/FCM/agent/v1/whoami/",
                HTTP_AUTHORIZATION=f"Bearer {old_token}",
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.get(
                "/FCM/agent/v1/whoami/",
                HTTP_AUTHORIZATION=f"Bearer {response.json()['token']}",
            ).status_code,
            200,
        )

    def test_two_named_agents_have_distinct_accounts_and_tokens(self):
        first = self._create_identity(label="Red Bot").json()
        second = self._create_identity(label="Blue Bot").json()
        self.assertNotEqual(first["identity"]["actorUsername"], second["identity"]["actorUsername"])
        self.assertNotEqual(first["token"], second["token"])
        self.assertEqual(AgentIdentity.objects.filter(owner=self.owner).count(), 2)
        self.assertEqual(AgentCredential.objects.filter(identity__owner=self.owner).count(), 2)

    def test_expired_pat_and_disabled_identity_are_rejected(self):
        created = self._create_identity().json()
        identity = AgentIdentity.objects.get(id=created["identity"]["id"])
        credential = identity.credentials.get()
        credential.expires_at = timezone.now() - timedelta(seconds=1)
        credential.save(update_fields=["expires_at"])
        self.client.logout()
        expired = self.client.get(
            "/FCM/agent/v1/games/",
            HTTP_AUTHORIZATION=f"Bearer {created['token']}",
        )
        self.assertEqual(expired.status_code, 401)

        renewed = issue_agent_token(identity)[1]
        self.client.force_login(self.owner)
        disabled = self.client.delete(f"/FCM/agent/v1/identities/{identity.id}/")
        self.assertEqual(disabled.status_code, 204)
        identity.refresh_from_db()
        identity.actor_user.refresh_from_db()
        self.assertIsNotNone(identity.disabled_at)
        self.assertFalse(identity.actor_user.is_active)
        self.client.logout()
        denied = self.client.get(
            "/FCM/agent/v1/games/",
            HTTP_AUTHORIZATION=f"Bearer {renewed}",
        )
        self.assertEqual(denied.status_code, 401)

    @patch("Lobby.presenters.FCMpresenter._sendStartGameNotification")
    def test_fresh_human_agent_game_executes_first_turn_in_authoritative_engine(self, _notify):
        created_identity = self._create_identity(label="Opening Bot").json()
        self.client.force_login(self.owner)
        created_game = self.client.post(
            "/FCM/agent/v1/games/",
            data=json.dumps({"gameName": "Fresh authoritative", "maxPlayers": 2}),
            content_type="application/json",
        ).json()["game"]
        self.client.logout()
        joined = self.client.post(
            f"/FCM/agent/v1/games/{created_game['id']}/join/",
            data="{}",
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {created_identity['token']}",
        )
        self.assertEqual(joined.status_code, 201)

        self.client.logout()
        agent_header = {"HTTP_AUTHORIZATION": f"Bearer {created_identity['token']}"}
        actions_response = self.client.get(
            f"/FCM/agent/v1/games/{created_game['id']}/actions/",
            **agent_header,
        )
        self.assertEqual(actions_response.status_code, 200)
        inspected = actions_response.json()
        command_header = agent_header
        if not inspected["legalActions"]["yourTurn"]:
            self.client.force_login(self.owner)
            actions_response = self.client.get(
                f"/FCM/agent/v1/games/{created_game['id']}/actions/",
            )
            self.assertEqual(actions_response.status_code, 200)
            inspected = actions_response.json()
            command_header = {}
        self.assertTrue(inspected["legalActions"]["yourTurn"])
        placement = next(
            action for action in inspected["legalActions"]["actions"]
            if action["type"] == "place_restaurant"
        )
        command = self.client.post(
            f"/FCM/agent/v1/games/{created_game['id']}/actions/",
            data=json.dumps({
                "expectedVersion": inspected["version"],
                "idempotencyKey": str(uuid.uuid4()),
                "actions": [
                    {"type": "place_restaurant", "index": placement["legalSquares"][0]},
                    {"type": "end_turn"},
                ],
            }),
            content_type="application/json",
            **command_header,
        )
        self.assertEqual(command.status_code, 200, command.content)
        game = Game.objects.get(id=created_game["id"])
        self.assertTrue(game.gameData)
        self.assertNotEqual(game.startingMap, "")
        self.assertEqual(command.json()["rulesetHash"], AgentActionReceipt.objects.get().ruleset_hash)

    @patch("Lobby.presenters.FCMpresenter._sendStartGameNotification")
    def test_human_and_two_token_agents_complete_setup_and_simultaneous_phases(self, _notify):
        first = self._create_identity(label="Agent One").json()
        second = self._create_identity(label="Agent Two").json()
        self.client.force_login(self.owner)
        game_id = self.client.post(
            "/FCM/agent/v1/games/",
            data=json.dumps({"gameName": "Human plus two agents", "maxPlayers": 3}),
            content_type="application/json",
        ).json()["game"]["id"]

        actor_clients = []
        human = self.client_class()
        human.force_login(self.owner)
        actor_clients.append(human)
        for identity in (first, second):
            client = self.client_class()
            headers = {"HTTP_AUTHORIZATION": f"Bearer {identity['token']}"}
            joined = client.post(
                f"/FCM/agent/v1/games/{game_id}/join/",
                data="{}", content_type="application/json", **headers,
            )
            self.assertEqual(joined.status_code, 201)
            client.defaults.update(headers)
            actor_clients.append(client)

        saw_partial_simultaneous = False
        for _step in range(40):
            game = Game.objects.get(id=game_id)
            if game.phase >= fcm_constants.PHASE_WORKING_DAY:
                break
            progressed = False
            for client in actor_clients:
                inspected_response = client.get(f"/FCM/agent/v1/games/{game_id}/actions/")
                self.assertEqual(inspected_response.status_code, 200)
                inspected = inspected_response.json()
                legal = inspected["legalActions"]
                if not legal["yourTurn"]:
                    continue
                state = inspected["state"]
                by_type = {action["type"]: action for action in legal["actions"]}
                me = state["players"][state["mySeat"]]
                phase = state["phase"]
                if phase >= fcm_constants.PHASE_WORKING_DAY:
                    progressed = True
                    break
                if phase in (0, 1):
                    if me["restaurants"]:
                        actions = [{"type": "end_turn"}]
                    else:
                        place = by_type["place_restaurant"]
                        actions = [
                            {"type": "place_restaurant", "index": place["legalSquares"][0]},
                            {"type": "end_turn"},
                        ]
                elif phase == 2:
                    actions = [{"type": "choose_reserve_card", "cardValue": 3}]
                elif phase == 3:
                    structure = by_type["place_employees"]
                    count = min(len(structure["beach"]), len(structure["slots"]))
                    actions = [{
                        "type": "place_employees",
                        "employees": structure["beach"][:count],
                        "slots": structure["slots"][:count],
                    }] if count else [{"type": "end_turn"}]
                elif phase == 4:
                    order = by_type["choose_turn_order"]
                    actions = [{
                        "type": "choose_turn_order",
                        "turnOrderPosition": order["positions"][0],
                    }]
                else:
                    self.fail(f"unexpected setup phase {phase}")

                result = client.post(
                    f"/FCM/agent/v1/games/{game_id}/actions/",
                    data=json.dumps({
                        "expectedVersion": inspected["version"],
                        "idempotencyKey": str(uuid.uuid4()),
                        "actions": actions,
                    }),
                    content_type="application/json",
                )
                self.assertEqual(result.status_code, 200, result.content)
                if phase in (2, 3) and not result.json()["resolved"]:
                    saw_partial_simultaneous = True
                    self.assertTrue(result.json()["pendingPlayers"])
                progressed = True
            if not progressed:
                self.fail("no authenticated actor could progress the setup")
        else:
            self.fail("setup exceeded the safety step limit")

        game = Game.objects.get(id=game_id)
        self.assertEqual(game.phase, fcm_constants.PHASE_WORKING_DAY)
        self.assertTrue(saw_partial_simultaneous)
        self.assertEqual(game.players.filter(is_kicked=False).count(), 3)
