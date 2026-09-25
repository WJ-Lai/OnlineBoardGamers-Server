from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("FCM", "0005_agentidentity_agentcredential")]

    operations = [
        migrations.AddField(
            model_name="agentactionreceipt",
            name="ruleset_hash",
            field=models.CharField(blank=True, max_length=64),
        ),
        migrations.AddField(
            model_name="agentactionreceipt",
            name="duration_ms",
            field=models.PositiveIntegerField(default=0),
        ),
    ]
