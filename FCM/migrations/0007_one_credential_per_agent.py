from django.db import migrations, models


def keep_newest_credential(apps, schema_editor):
    AgentCredential = apps.get_model("FCM", "AgentCredential")
    identity_ids = AgentCredential.objects.values_list("identity_id", flat=True).distinct()
    for identity_id in identity_ids.iterator():
        credentials = list(
            AgentCredential.objects.filter(identity_id=identity_id)
            .order_by("-created_at", "-id")
            .values_list("id", flat=True)
        )
        if len(credentials) > 1:
            AgentCredential.objects.filter(id__in=credentials[1:]).delete()


class Migration(migrations.Migration):
    dependencies = [("FCM", "0006_agentactionreceipt_audit_metadata")]

    operations = [
        migrations.RunPython(keep_newest_credential, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="agentcredential",
            constraint=models.UniqueConstraint(
                fields=("identity",),
                name="fcm_one_credential_per_agent",
            ),
        ),
    ]
