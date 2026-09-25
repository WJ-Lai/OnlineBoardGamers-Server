"""Authentication primitives for scoped FCM Agent personal access tokens."""

import hashlib
import hmac
import re
import secrets

from django.utils import timezone

from .models import AgentCredential

VALID_AGENT_SCOPES = frozenset({"fcm:read", "fcm:play", "fcm:games:create"})
DEFAULT_AGENT_SCOPES = ("fcm:play", "fcm:read")
TOKEN_RE = re.compile(r"^obg_pat_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,})$")


def _digest(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def validate_scopes(scopes):
    if not isinstance(scopes, list) or any(not isinstance(scope, str) for scope in scopes):
        raise ValueError("scopes must be a list of strings")
    if not scopes:
        raise ValueError("scopes must contain at least one permission")
    if len(scopes) != len(set(scopes)) or not set(scopes).issubset(VALID_AGENT_SCOPES):
        raise ValueError("scopes contain duplicates or unsupported values")
    return sorted(scopes)


def issue_agent_token(identity, *, scopes=None, name="default", expires_at=None):
    granted = validate_scopes(list(DEFAULT_AGENT_SCOPES if scopes is None else scopes))
    prefix = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    credential = AgentCredential.objects.create(
        identity=identity,
        name=name,
        prefix=prefix,
        secret_hash=_digest(secret),
        scopes=granted,
        expires_at=expires_at,
    )
    return credential, f"obg_pat_{prefix}_{secret}"


def authenticate_agent_token(raw_token):
    match = TOKEN_RE.fullmatch(raw_token or "")
    if not match:
        return None
    prefix, secret = match.groups()
    credential = AgentCredential.objects.select_related(
        "identity", "identity__actor_user"
    ).filter(prefix=prefix).first()
    if not credential or not credential.is_active:
        return None
    if not hmac.compare_digest(credential.secret_hash, _digest(secret)):
        return None
    AgentCredential.objects.filter(pk=credential.pk).update(last_used_at=timezone.now())
    return credential


class AgentTokenAuthenticationMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        authorization = request.META.get("HTTP_AUTHORIZATION", "")
        if authorization.startswith("Bearer ") and request.path.startswith("/FCM/agent/v1/"):
            # Bearer tokens are not ambient browser credentials, so CSRF does not apply.
            request._dont_enforce_csrf_checks = True
            credential = authenticate_agent_token(authorization[7:])
            if credential is None:
                request.agent_auth_error = "INVALID_TOKEN"
            else:
                request.user = credential.identity.actor_user
                request.agent_credential = credential
        return self.get_response(request)
