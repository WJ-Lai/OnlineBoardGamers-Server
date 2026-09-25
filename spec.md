# OBG / FCM Agent Integration Specification

Status: implementation and acceptance complete; ready for maintainer review
Version: 4
Updated: 2026-09-25
Scope: base-game FCM, 2–6 independent seats, human/Agent mixed games and all-Agent games

## 1. Product goal

Allow a player to connect one or more independently implemented AI Agents to OBG without
browser automation. An Agent can create or join a game, read structured state, inspect its
current legal actions, submit a normal player action and wait for the game to change.

Agent access adds an input channel only. It must not change dinner resolution, house order,
reachability, inventory, pricing, phase progression, victory conditions or any other FCM rule.

## 2. Architecture decision

The server is authoritative:

```text
Agent implementation
      │ HTTP / CLI / stdio MCP (high-level actions only)
      ▼
Django Agent API
      │ identity · scope · membership · version · idempotency
      ▼
isolated Node worker
      │ loads the repository's existing FCM JavaScript
      ▼
canonical save candidate
      │ schema validation · compare-and-swap · transaction
      ▼
OBG database and normal human web UI
```

The client never submits `gameData`, a seat number or an actor name. Django derives the actor
and seat from the credential and active `GamePlayer` membership. The worker receives no token,
cookie, password or database credential and runs once per command.

The MCP server and CLI are thin transports. They do not own a second rules implementation.

## 3. Identity and onboarding

- A human OBG account owns zero or more `AgentIdentity` records.
- Each identity has a passwordless OBG user that occupies one ordinary player seat.
- Each AI must use its own identity and Token; credentials are not shared between seats.
- A Personal Agent Token is displayed once and only its SHA-256 digest is stored.
- Tokens have explicit scopes, expiry, last-use metadata and immediate revocation.
- Disabling an identity deactivates its seat user and revokes all credentials.

Human owners use `/FCM/agent/manage/` to create, rotate and revoke credentials. Immediately after
creation the page produces one self-contained message that can be pasted into a trusted Agent.
The Agent authenticates to `GET /FCM/agent/v1/bootstrap/`, which returns the machine-readable join
and play workflow. A downloadable `fcm-agent.env` remains an optional advanced/backup path rather
than the primary onboarding flow. Agents do not register normal accounts and never receive the
owner's password.

Current scopes:

- `fcm:read`
- `fcm:play`
- `fcm:games:create`

OAuth Authorization Code + PKCE is intentionally deferred until public remote hosting is in
scope. Controlled deployments use short-lived, least-privilege PATs over HTTPS.

## 4. Canonical API

The versioned JSON surface is `/FCM/agent/v1/`:

- `GET /bootstrap/`
- `GET /whoami/`
- `GET|POST /games/`
- `POST /games/{id}/join/`
- `GET /games/{id}/snapshot/`
- `GET|POST /games/{id}/actions/`
- `GET /games/{id}/changes/?afterVersion=...`
- `GET /games/{id}/commands/{uuid}/`
- owner-only identity and credential endpoints

Writes require the latest numeric `expectedVersion`, a UUID idempotency key and a non-empty
action batch. The same UUID and identical request replay the stored response. Reusing a UUID for
a different command is rejected. A stale version never mutates the game.

Every successful write records the internal actor, game, action, before/after version, command
hash, ruleset hash, duration and outcome. Tokens, cookies, full blobs and Agent reasoning are not
logged.

## 5. Rule preservation

The action registry defines names, input schemas and transaction boundaries. Legal values come
from the current server snapshot and the existing FCM controller/rules functions. Unknown fields,
seat spoofing, actor spoofing, forged map positions, unavailable employees, impossible production,
overspending and incomplete phase-ending batches are rejected.

Automatic phases, including dinner, are not exposed as Agent decisions. They continue to execute
through the existing FCM resolver.

One compatibility change is required in the shared FCM serialization: persist the working-day
subphase and reconstruct official producer slots when a saved production subphase is resumed.
Legacy saves without the new field still default to the hiring subphase. This preserves an existing
state that the browser previously kept only in memory; it adds no employee or game rule.

## 6. Security boundary and operational guarantee

PATs are accepted only by `/FCM/agent/v1/` and cannot call the legacy blob save endpoint. An
untrusted Agent should receive only HTTPS access and its PAT. It must not receive SSH, repository
write access, database credentials or an authenticated administrator browser session.

No application API can prevent an Agent that already has operating-system access from modifying
server code or data. Production deployments must run the server under a separate account or
container, keep the checkout read-only to Agent processes and isolate database credentials.

## 7. Compatibility and failure recovery

- Responses carry `protocolVersion` and `rulesetHash`.
- A protocol major-version change requires a client upgrade.
- A ruleset hash change invalidates cached state and legal actions.
- `STALE_STATE` requires a fresh read and a new decision/UUID.
- An uncertain network result is retried only with the same UUID and identical body.
- Engine timeout/crash returns an error without committing state.
- Agent processes may restart from the latest server snapshot; no game authority lives locally.

## 8. Verification gates

Required before merging:

1. Node contract, adversarial, concurrency, schema, worker and snapshot tests pass.
2. Django authentication, scope, ownership, membership, idempotency and atomic-commit tests pass.
3. Token management UI tests prove one-time display and cross-owner isolation.
4. Vue production build and Django migration checks pass.
5. A fresh base-game acceptance run completes with one human Session and at least two PAT Agents.
6. Search and diff review show no optional-module code, generated bundles, secrets or local probes.
7. The full project suite introduces no failures beyond failures reproducible on the current
   upstream base; any upstream failures are reported rather than hidden or changed in this PR.

Latest clean-base acceptance evidence: upstream `d8b2682`, fresh isolated SQLite database, one
human Session plus two independent PAT Agents, Game Over at turn 15 after 278 audited commands.
The full Django suite ran 213 tests; the only two failures are unchanged upstream defects in
`Lobby.tests` (missing imported helper) and the explicitly named RNB `test_F_FAILING_...` test.

## 9. Explicitly excluded from this change

- the private Temporary Worker module and all of its assets, rules and tests;
- unrelated UI, LAN, notification, replay or historical-game fixes;
- generated Vue bundles and one-off diagnostic scripts;
- the existing built-in 1v1 FCM AI;
- public OAuth, Remote MCP, application registration and public hosting operations.

The Temporary Worker module remains in the owner's original working tree and offline recovery
archive. It must be maintained on a separate private branch or fork and rebased independently.

## 10. Follow-up roadmap

Not required for the first controlled-network PAT contribution:

- UI/headless serialized-state parity fixtures for every base-game phase;
- an explicit game allowlist and configurable rate limiting;
- 100-write load tests and operational metrics;
- HTTPS deployment guide and security review;
- mature-library OAuth Authorization Code + PKCE and refresh-token rotation;
- Remote MCP built as another thin client of the canonical HTTP API;
- optional expansions, each gated by its own parity fixtures.
