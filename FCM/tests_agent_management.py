from django.test import TestCase, override_settings

from FCM.agent_auth import DEFAULT_AGENT_SCOPES, authenticate_agent_token, issue_agent_token
from FCM.models import AgentCredential, AgentIdentity
from Lobby.models import Game, GamePlayer, User


TEST_STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}


@override_settings(STORAGES=TEST_STORAGES)
class AgentManagementPageTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pw")
        self.other_owner = User.objects.create_user(username="other", password="pw")

    def _identity(self, owner=None, label="Red Bot"):
        owner = owner or self.owner
        actor = User.objects.create_user(username=f"agent-{owner.id}-{label}", password=None)
        identity = AgentIdentity.objects.create(owner=owner, actor_user=actor, label=label)
        credential, token = issue_agent_token(identity)
        return identity, credential, token

    def test_page_requires_a_human_session(self):
        response = self.client.get("/FCM/agent/manage/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("login", response.headers["Location"].lower())

    def test_management_page_is_private_never_cached_and_simple(self):
        self.client.force_login(self.owner)
        response = self.client.get("/FCM/agent/manage/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-cache", response.headers["Cache-Control"])
        self.assertIn("private", response.headers["Cache-Control"])
        self.assertContains(response, "Create an AI player")
        self.assertContains(response, "Your AI players")
        for forbidden in ("npm ci", "Expiry", "Scopes", "Revoke", "Disable"):
            self.assertNotContains(response, forbidden)

    def test_authenticated_navigation_exposes_agent_access(self):
        self.client.force_login(self.owner)
        response = self.client.get("/")
        self.assertContains(response, 'href="/FCM/agent/manage/"')
        self.assertContains(response, "AI Agents")

    def test_owner_creates_one_permanent_full_access_token(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/", data={"action": "create", "label": "Red Bot"},
        )
        self.assertEqual(response.status_code, 302)
        identity = AgentIdentity.objects.get(owner=self.owner)
        credential = identity.credentials.get()
        self.assertFalse(identity.actor_user.has_usable_password())
        self.assertTrue(identity.actor_user.username.startswith("ai-red-bot-"))
        self.assertEqual(credential.scopes, list(DEFAULT_AGENT_SCOPES))
        self.assertIsNone(credential.expires_at)
        self.assertIn(f"agent={identity.id}", response.headers["Location"])

    def test_token_is_masked_in_html_but_owner_can_reveal_and_copy_message(self):
        identity, _credential, token = self._identity()
        self.client.force_login(self.owner)
        page = self.client.get("/FCM/agent/manage/")
        self.assertNotContains(page, token)
        self.assertContains(page, "Copy Token")
        self.assertContains(page, "Copy message for AI")
        reveal = self.client.get(f"/FCM/agent/manage/{identity.id}/token/")
        self.assertEqual(reveal.status_code, 200)
        self.assertEqual(reveal.json()["token"], token)
        self.assertIn("Authorization: Bearer", reveal.json()["connectionMessage"])
        self.assertIn("Use only the Agent API", reveal.json()["connectionMessage"])
        self.assertIn("no-cache", reveal.headers["Cache-Control"])

    def test_another_owner_and_pat_cannot_reveal_or_open_control_plane(self):
        identity, _credential, token = self._identity()
        self.client.force_login(self.other_owner)
        self.assertEqual(
            self.client.get(f"/FCM/agent/manage/{identity.id}/token/").status_code, 404,
        )
        self.client.logout()
        response = self.client.get(
            "/FCM/agent/manage/", HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(response.status_code, 302)

    def test_refresh_preserves_identity_and_games_but_invalidates_old_token(self):
        identity, old_credential, old_token = self._identity()
        game = Game.objects.create(
            gameCode="FCM", gameName="Ongoing", creator=self.owner, host=self.owner,
            gameStatus="ACTIVE", maxPlayers=3,
        )
        membership = GamePlayer.objects.create(game=game, player=identity.actor_user, seat_order=1)
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/", data={"action": "refresh", "identity_id": identity.id},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(identity.credentials.count(), 1)
        replacement = identity.credentials.get()
        self.assertNotEqual(replacement.id, old_credential.id)
        self.assertIsNone(authenticate_agent_token(old_token))
        self.assertEqual(GamePlayer.objects.get(pk=membership.pk).player, identity.actor_user)
        reveal = self.client.get(f"/FCM/agent/manage/{identity.id}/token/")
        self.assertIsNotNone(authenticate_agent_token(reveal.json()["token"]))
        page = self.client.get(f"/FCM/agent/manage/?agent={identity.id}")
        self.assertContains(page, "Red Bot")
        self.assertContains(page, "Ongoing")
        self.assertContains(page, f'/FCM/{game.id}/show/')
        self.assertNotContains(page, identity.actor_user.username)

    def test_legacy_non_revealable_token_requests_one_refresh(self):
        identity, _credential, _token = self._identity()
        credential = identity.credentials.get()
        credential.secret_hash = "0" * 64
        credential.save(update_fields=["secret_hash"])
        self.client.force_login(self.owner)
        response = self.client.get(f"/FCM/agent/manage/{identity.id}/token/")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Refresh", response.json()["error"])

    def test_delete_hides_agent_and_revokes_token_without_deleting_game_history(self):
        identity, _credential, token = self._identity()
        game = Game.objects.create(
            gameCode="FCM", gameName="Historical game", creator=self.owner,
            host=self.owner, gameStatus="FINISHED", maxPlayers=2,
        )
        membership = GamePlayer.objects.create(game=game, player=identity.actor_user, seat_order=1)
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/", data={"action": "delete", "identity_id": identity.id},
        )
        self.assertEqual(response.status_code, 302)
        identity.refresh_from_db()
        identity.actor_user.refresh_from_db()
        self.assertIsNotNone(identity.disabled_at)
        self.assertFalse(identity.actor_user.is_active)
        self.assertFalse(AgentCredential.objects.filter(identity=identity).exists())
        self.assertIsNone(authenticate_agent_token(token))
        self.assertTrue(GamePlayer.objects.filter(pk=membership.pk).exists())
        page = self.client.get("/FCM/agent/manage/")
        self.assertEqual(page.context["agent_cards"], [])
