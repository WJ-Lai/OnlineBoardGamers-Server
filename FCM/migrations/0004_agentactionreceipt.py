import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("FCM", "0003_fcmmaintournament_fcmminitournament"),
        ("Lobby", "0114_gameplayer_availabilityanchor"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AgentActionReceipt",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("idempotency_key", models.UUIDField()),
                ("request_hash", models.CharField(max_length=64)),
                ("command_hash", models.CharField(blank=True, max_length=64)),
                ("transport_action", models.CharField(max_length=64)),
                ("agent_action", models.CharField(blank=True, max_length=64)),
                ("before_version", models.CharField(blank=True, max_length=32)),
                ("after_version", models.CharField(blank=True, max_length=32)),
                ("outcome", models.CharField(choices=[("SUCCEEDED", "Succeeded"), ("REJECTED", "Rejected")], max_length=16)),
                ("http_status", models.PositiveSmallIntegerField()),
                ("response_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("actor", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="fcm_agent_action_receipts", to=settings.AUTH_USER_MODEL)),
                ("game", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="fcm_agent_action_receipts", to="Lobby.game")),
            ],
            options={
                "indexes": [models.Index(fields=["game", "created_at"], name="fcm_receipt_game_created_idx")],
                "constraints": [models.UniqueConstraint(fields=("actor", "game", "idempotency_key"), name="fcm_agent_receipt_actor_game_key_uniq")],
            },
        ),
    ]
