# OBG / FCM Agent Integration Specification

Status: base-game implementation and acceptance complete; final clean commit/push in progress
Version: 5
Updated: 2026-09-27
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
      │ identity · membership · version · idempotency
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
- Each identity has exactly one permanent Personal Agent Token with full FCM access.
- The owner page masks the Token by default, but can reveal or copy the full value after a
  same-origin authenticated request. The database stores only its digest.
- Refresh replaces the sole Token immediately while preserving the same identity, seat and games.
- Delete removes the Token and deactivates the identity while preserving historical game records.

Human owners use `/FCM/agent/manage/` to create, refresh and delete AI players. Each collapsible
card shows that AI's masked Token and current games. **Copy message for AI** produces one
self-contained message that can be pasted into a trusted Agent.
The Agent authenticates to `GET /FCM/agent/v1/bootstrap/`, which returns the machine-readable join
and play workflow. Agents do not register normal accounts, download configuration files or receive
the owner's password.

OAuth Authorization Code + PKCE is intentionally deferred until public remote hosting is in
scope. Controlled deployments use permanent per-Agent PATs over HTTPS; owners refresh a Token when
it is forgotten or suspected to be exposed.

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

`GET /games/{id}/actions/` is the canonical decision view. For the base game it includes the board,
houses, gardens, demands, campaigns, roads, public supply, player money/resources/employees/beach,
restaurants, milestones, turn order, bank, history and chat, plus the caller's legal actions. Chat
and other player-authored text are explicitly untrusted. Other players' simultaneous temporary
choices and reserve-card selections are not exposed before the normal rules reveal them.

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
3. Token management UI tests prove masking/reveal, one-Token identity, refresh invalidation,
   persistence of game memberships and cross-owner isolation.
4. Vue production build and Django migration checks pass.
5. A fresh base-game acceptance run completes with one human Session and at least two PAT Agents.
6. Search and diff review show no optional-module code, generated bundles, secrets or local probes.
7. The full project suite introduces no failures beyond failures reproducible on the current
   upstream base; any upstream failures are reported rather than hidden or changed in this PR.

Latest post-migration acceptance evidence: fresh isolated SQLite database, one human Session plus
two independent permanent-Token Agents, Game Over at turn 16 after 293 audited commands. The
previous clean-base run on upstream `d8b2682` also reached Game Over at turn 15 after 278 commands.
The full Django suite ran 220 tests; the only two failures are unchanged upstream defects in
`Lobby.tests` (missing imported helper) and the explicitly named RNB `test_F_FAILING_...` test.

## 9. Explicitly excluded from this change

- the private Temporary Worker module and all of its assets, rules and tests;
- unrelated UI, LAN, notification, replay or historical-game fixes;
- generated Vue bundles and one-off diagnostic scripts;
- the existing built-in 1v1 FCM AI;
- public OAuth, Remote MCP, application registration and public hosting operations;
- expansion-specific Agent decisions beyond the base-game action registry.

The Temporary Worker module remains in the owner's original working tree and offline recovery
archive. It must be maintained on a separate private branch or fork and rebased independently.

## 10. Follow-up roadmap

Not required for the first controlled-network PAT contribution:

- UI/headless serialized-state parity fixtures for every expansion phase;
- an explicit game allowlist and configurable rate limiting;
- 100-write load tests and operational metrics;
- HTTPS deployment guide and security review;
- mature-library OAuth Authorization Code + PKCE and refresh-token rotation;
- Remote MCP built as another thin client of the canonical HTTP API;
- optional expansions through the same action registry. Shared identity, state, transport,
  versioning and validation infrastructure is reused; each expansion-only decision must add an
  explicit legal-action adapter, executor mapping and adversarial parity fixtures before it can be
  advertised. Unknown expansion actions remain rejected by default.

## 11. Product checklist and remaining work

This checklist is the product acceptance source of truth. “Implemented” still requires the
verification gates in section 8 before release.

| Requirement | Current design / implementation | Status |
|---|---|---|
| Simple owner page | The page lists only AI players owned by the signed-in human. Installation commands, downloads, expiry, permission, revoke and disable controls are absent. | Implemented; live browser smoke passed |
| One card per AI | Each custom-named AI appears as one collapsible card. Internal usernames are not shown to normal users. | Implemented |
| Current games | An expanded card lists that AI's non-finished FCM games; each title links to `/FCM/{id}/show/`. | Implemented |
| Exactly one permanent Token | A database constraint permits one credential per identity. New Tokens have no expiry and full FCM capability. | Implemented and migration added |
| Mask, reveal and copy | The page shows the beginning/end only. Eye reveal and Copy Token fetch the full value through an owner-only, non-cacheable endpoint. Copy works without first revealing it. | Implemented; live reveal/copy smoke passed |
| Refresh forgotten Token | Refresh atomically replaces the sole Token. The old value stops working; identity, player account, game memberships and history remain unchanged. | Implemented and adversarially tested |
| Delete terminology | The UI says Delete AI, not revoke/disable. Internally it is a soft deletion so old game records keep a valid player reference; the Token is removed and login is deactivated. | Implemented |
| No permission UI | Owners do not choose scopes. Newly created/refreshed Tokens receive all FCM API capabilities. Legacy scope checks remain only as server-side compatibility defense. | Implemented |
| Separate Agents | Every AI has a distinct passwordless OBG actor, identity, Token and seat. A Token can act only for its own memberships. | Implemented and tested |
| Create-game handoff | Game creation returns both `gameURL` and `inviteURL`; bootstrap explicitly tells the Agent to return `inviteURL` to the requesting human. | Implemented and tested |
| Friendly names | Human UI, structured Agent state and FCM history resolve internal Agent usernames to the owner's custom label. Engine commits translate presentation labels back to stable internal actors before validation. | Implemented and covered by runtime regression test |
| Read decision information | Base-game state exposes the visible board, demands, public supply, bank/order, public player assets, history/chat and a rules catalog. Private temporary simultaneous choices are deliberately excluded. | Implemented; phase-by-phase parity fixture remains TODO |
| Perform human operations | Base-game choices are exposed only through the action registry and are executed through existing FCM controller/rules functions. Automatic dinner/scoring phases are not rewritten. | Implemented; fresh mixed-game run reached Game Over after 293 commands |
| Expansion support | Authentication, transport, state envelope and registry are reusable. Expansion-only decisions are rejected unless they have their own legal-action adapter, executor and adversarial tests. | TODO after base-game release |
| Connection method clarity | HTTP JSON API is canonical. The HTML page is only the human owner's control panel. MCP is an optional tool adapter; CLI is a maintainer/debug reference client. | Documented |
| DeepSeek changes | The only unrelated detected change is local host configuration in `OnlineBoardGamers/settings.py`. It does not change FCM rules or Agent behavior and is intentionally excluded from the Agent commit. | Reviewed; preserve locally, do not submit |

### Remaining release tasks

1. Re-run Node, targeted Django, migration/build checks and compare full-suite failures with upstream.
2. Review the final diff to exclude Temporary Worker code, local host settings, secrets and
   unrelated generated assets.
3. Commit and push the clean Agent-only change to the owner's fork.

### Deferred expansion work

For each optional module, inventory its extra phases, visible state and human controls; then add
registry actions, legal candidates, official controller execution, serialization/resume tests and
forged-input tests. Do not advertise a module until an equivalent human/Agent phase fixture passes.
