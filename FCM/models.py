from django.conf import settings
from django.db import models
from django.utils import timezone


class AgentIdentity(models.Model):
    """A passwordless user account that may occupy one FCM player seat."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_fcm_agent_identities",
    )
    actor_user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="fcm_agent_identity",
    )
    label = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)
    disabled_at = models.DateTimeField(null=True, blank=True)

    @property
    def is_active(self):
        return self.disabled_at is None and self.actor_user.is_active


class AgentCredential(models.Model):
    """Revocable, scoped PAT. Only its SHA-256 digest is stored."""

    identity = models.ForeignKey(
        AgentIdentity,
        on_delete=models.CASCADE,
        related_name="credentials",
    )
    name = models.CharField(max_length=80, default="default")
    prefix = models.CharField(max_length=12, unique=True)
    secret_hash = models.CharField(max_length=64)
    scopes = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    @property
    def is_active(self):
        return (
            self.revoked_at is None
            and (self.expires_at is None or self.expires_at > timezone.now())
            and self.identity.is_active
        )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("identity",),
                name="fcm_one_credential_per_agent",
            ),
        ]


class AgentActionReceipt(models.Model):
    """Durable receipt for an Agent write sent through the legacy FCM endpoint."""

    class Outcome(models.TextChoices):
        SUCCEEDED = "SUCCEEDED", "Succeeded"
        REJECTED = "REJECTED", "Rejected"

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="fcm_agent_action_receipts",
    )
    game = models.ForeignKey(
        "Lobby.Game",
        on_delete=models.CASCADE,
        related_name="fcm_agent_action_receipts",
    )
    idempotency_key = models.UUIDField()
    request_hash = models.CharField(max_length=64)
    command_hash = models.CharField(max_length=64, blank=True)
    ruleset_hash = models.CharField(max_length=64, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)
    transport_action = models.CharField(max_length=64)
    agent_action = models.CharField(max_length=64, blank=True)
    before_version = models.CharField(max_length=32, blank=True)
    after_version = models.CharField(max_length=32, blank=True)
    outcome = models.CharField(max_length=16, choices=Outcome.choices)
    http_status = models.PositiveSmallIntegerField()
    response_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("actor", "game", "idempotency_key"),
                name="fcm_agent_receipt_actor_game_key_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=("game", "created_at"),
                name="fcm_receipt_game_created_idx",
            ),
        ]
