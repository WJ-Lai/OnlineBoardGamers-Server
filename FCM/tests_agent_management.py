from django.test import TestCase, override_settings

from FCM.agent_auth import issue_agent_token
from FCM.models import AgentIdentity
from Lobby.models import User

TEST_STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}


@override_settings(STORAGES=TEST_STORAGES)
class AgentManagementPageTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pw")
        self.other_owner = User.objects.create_user(username="other", password="pw")

    def test_page_requires_a_human_session(self):
        response = self.client.get("/FCM/agent/manage/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("login", response.headers["Location"].lower())

    def test_management_page_is_never_cached(self):
        self.client.force_login(self.owner)

        response = self.client.get("/FCM/agent/manage/")

        self.assertIn("no-cache", response.headers["Cache-Control"])
        self.assertIn("private", response.headers["Cache-Control"])

    def test_authenticated_navigation_exposes_agent_access(self):
        self.client.force_login(self.owner)

        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'href="/FCM/agent/manage/"')
        self.assertContains(response, "AI Agents")

    def test_management_page_contains_first_time_setup_guide(self):
        self.client.force_login(self.owner)

        response = self.client.get("/FCM/agent/manage/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Connect an AI in three steps")
        self.assertContains(response, "Paste that message into your AI Agent")
        self.assertContains(response, "Existing AI players")
        self.assertNotContains(response, "npm ci")
        self.assertNotContains(response, "/safe/path/")

    def test_owner_can_create_agent_and_receive_one_time_connection_config(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/",
            data={
                "action": "create",
                "label": "Red Bot",
                "expires_in_days": "30",
                "scopes": ["fcm:read", "fcm:play"],
            },
        )

        self.assertEqual(response.status_code, 201)
        identity = AgentIdentity.objects.get(owner=self.owner)
        credential = identity.credentials.get()
        self.assertFalse(identity.actor_user.has_usable_password())
        self.assertContains(response, "obg_pat_", status_code=201)
        self.assertContains(response, "FCM_BASE_URL=", status_code=201)
        self.assertContains(response, "FCM_AGENT_TOKEN=", status_code=201)
        self.assertContains(response, "Copy message for AI", status_code=201)
        self.assertContains(response, "/FCM/agent/v1/bootstrap/", status_code=201)
        self.assertContains(response, "Use only the Agent API", status_code=201)
        self.assertContains(response, identity.actor_user.username, status_code=201)
        self.assertEqual(credential.scopes, ["fcm:play", "fcm:read"])

        refreshed = self.client.get("/FCM/agent/manage/")
        self.assertNotContains(refreshed, "obg_pat_")

    def test_invalid_expiry_does_not_create_an_identity(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/",
            data={
                "action": "create",
                "label": "Bad Bot",
                "expires_in_days": "366",
                "scopes": ["fcm:read"],
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertContains(response, "1 and 365", status_code=400)
        self.assertFalse(AgentIdentity.objects.exists())

    def test_empty_scope_selection_is_rejected_instead_of_granting_every_scope(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            "/FCM/agent/manage/",
            data={
                "action": "create",
                "label": "No Scope Bot",
                "expires_in_days": "30",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertContains(response, "at least one", status_code=400)
        self.assertFalse(AgentIdentity.objects.exists())

    def test_owner_can_rotate_and_revoke_a_token(self):
        actor = User.objects.create_user(username="agent", password=None)
        identity = AgentIdentity.objects.create(
            owner=self.owner, actor_user=actor, label="Agent",
        )
        old_credential, _old_token = issue_agent_token(identity)
        self.client.force_login(self.owner)

        rotated = self.client.post(
            "/FCM/agent/manage/",
            data={
                "action": "rotate",
                "identity_id": identity.id,
                "token_name": "replacement",
                "expires_in_days": "7",
                "scopes": ["fcm:read", "fcm:play"],
            },
        )
        self.assertEqual(rotated.status_code, 201)
        self.assertContains(rotated, "obg_pat_", status_code=201)
        replacement = identity.credentials.exclude(pk=old_credential.pk).get()

        revoked = self.client.post(
            "/FCM/agent/manage/",
            data={"action": "revoke", "credential_id": replacement.id},
        )
        self.assertEqual(revoked.status_code, 302)
        replacement.refresh_from_db()
        self.assertIsNotNone(replacement.revoked_at)

    def test_owner_cannot_manage_another_owners_credentials(self):
        actor = User.objects.create_user(username="foreign-agent", password=None)
        identity = AgentIdentity.objects.create(
            owner=self.other_owner, actor_user=actor, label="Foreign",
        )
        credential, _token = issue_agent_token(identity)
        self.client.force_login(self.owner)

        response = self.client.post(
            "/FCM/agent/manage/",
            data={"action": "revoke", "credential_id": credential.id},
        )
        self.assertEqual(response.status_code, 404)
        credential.refresh_from_db()
        self.assertIsNone(credential.revoked_at)

    def test_pat_cannot_open_the_owner_control_plane(self):
        actor = User.objects.create_user(username="token-agent", password=None)
        identity = AgentIdentity.objects.create(
            owner=self.owner, actor_user=actor, label="Token Agent",
        )
        _credential, token = issue_agent_token(identity)

        response = self.client.get(
            "/FCM/agent/manage/",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(response.status_code, 302)
