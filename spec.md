# OBG / FCM Agent Integration Specification

Status: base-game integration rebased on upstream and saved to the owner's fork; strategy follow-up active
Version: 7
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
6. Search and diff review show no optional-module code, unrelated generated assets, secrets or
   local probes. If the deployment does not build Vue, the cleanly rebuilt tracked runtime bundle
   is a required artifact rather than an unrelated generated asset.
7. The full project suite introduces no failures beyond failures reproducible on the current
   upstream base; any upstream failures are reported rather than hidden or changed in this PR.

Latest post-migration acceptance evidence: fresh isolated SQLite database, one human Session plus
two independent permanent-Token Agents, Game Over at turn 17 after 321 audited commands on the
final controller/runtime changes. Earlier isolated runs also reached Game Over at turn 15 after
276 commands and turn 16 after 293 commands. The full Django suite ran 220 tests; the only two
failures are unchanged upstream defects in `Lobby.tests` (missing imported helper) and the
explicitly named RNB `test_F_FAILING_...` test. The final targeted Agent suites pass 51/51.

## 9. Explicitly excluded from this change

- the private Temporary Worker module and all of its assets, rules and tests;
- unrelated UI, LAN, notification, replay or historical-game fixes;
- unrelated generated Vue assets and one-off diagnostic scripts; the two tracked runtime bundles
  may be included when required by the upstream deployment path;
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
| Read decision information | Base-game state exposes the visible board, demands, public supply, bank/order, public player assets, history/chat and a rules catalog. Private temporary simultaneous choices are deliberately excluded. | Implemented; 35 immutable phase/subphase fixtures verify the official engine contract |
| Perform human operations | Base-game choices are exposed only through the action registry and are executed through existing FCM controller/rules functions. Automatic dinner/scoring phases are not rewritten. | Implemented; post-game-69 fix mixed acceptance reached Game Over after 276 commands |
| Human/Agent rule parity | Hire candidates and execution both use official `HIREABLE_EMPLOYEES`; legal-action output advertises public `end_turn`, never the rejected internal sentinel. | Implemented after game 69; adversarial bypass tests and full acceptance pass |
| Training parity | Training exposes beach, permitted at-work staff and the human UI's synthetic hire-and-train source (`origin=1`) only while both recruiting and training points remain. | Implemented and adversarially tested |
| Restructuring hierarchy parity | One atomic structure command may place a manager and then use subordinate slots created by that manager. Validation simulates the ordered official mutations while still rejecting cloning and out-of-range slots. | Implemented after public-history replay exposed the gap |
| Expansion support | Authentication, transport, state envelope and registry are reusable. Expansion-only decisions are rejected unless they have their own legal-action adapter, executor and adversarial tests. | TODO after base-game release |
| Connection method clarity | HTTP JSON API is canonical. The HTML page is only the human owner's control panel. MCP is an optional tool adapter; CLI is a maintainer/debug reference client. | Documented |
| DeepSeek changes | The only unrelated detected change is local host configuration in `OnlineBoardGamers/settings.py`. It does not change FCM rules or Agent behavior and is intentionally excluded from the Agent commit. | Reviewed; preserve locally, do not submit |

### Remaining release tasks

1. Review the final branch diff for Temporary Worker code, local host settings, secrets and
   unrelated generated assets, then save the verified commits to the owner's fork.
2. Keep strategy-AI policy code in `/home/vincent/fcm-ai`; the reusable offline official-engine
   adapter remains beside the server engine and is independently tested.
3. Open an upstream pull request only after the owner chooses to do so; this checkpoint targets
   the owner's fork first.

### Deferred expansion work

For each optional module, inventory its extra phases, visible state and human controls; then add
registry actions, legal candidates, official controller execution, serialization/resume tests and
forged-input tests. Do not advertise a module until an equivalent human/Agent phase fixture passes.

## 12. Strategy-capable FCM AI follow-up

The Agent API and MCP solve **safe observation and legal execution**. They do not by themselves
provide a winning policy. A client that selects the first legal action can complete a game while
showing no understanding of milestones, engine building, price wars, demand creation, turn order,
game length or opponent threats.

The base-game wire surface contains most public raw facts needed to construct a strategy engine,
but several facts remain opaque or expensive for an LLM to derive repeatedly: organization-chart
semantics encoded in the flat employee array, decoded board topology, current effective prices and
salary obligations, house-by-house supplier competition, predicted dinner allocation, milestone
races, and the consequences of complete multi-action turn plans. Raw history codes are also not a
usable long-term strategic memory.

This is a separate client-side AI project, not a reason to put strategy or a second rules engine in
the OBG server. The detailed design is maintained in
`/home/vincent/fcm-ai/docs/fcm-ai-architecture.md`.

### AI readiness backlog

1. Keep the captured machine-readable fixtures for every base-game phase: visible inputs, derived
   features, legal candidates, hidden information and expected consequences.
2. Extract an early fast, cloneable offline environment around the official JS engine; benchmark
   and candidate evaluation must not depend on HTTP/Django/SQLite.
3. Expose or compute a semantic `DecisionView`: decoded company structure and board graph,
   effective price/salary, reachability, supplier scores, projected sales and milestone threats.
4. Build a deterministic baseline Agent with persistent per-game strategy memory and bounded,
   phase-local candidate generation. Use explicit expansion budgets, dominance pruning and a safe
   fallback before composing one-turn or multi-turn plans.
5. Add fixed scenario tests plus a league benchmark against random, first-legal, built-in OBG AI,
   scripted strategies and historical versions. Measure rule violations, win/rank rate, seat bias,
   decision latency and robustness—not just whether a game finishes.
6. Separate `observed`, official-engine `derived` and opponent-model `believed` fields. A frozen
   public-state dinner projection is deterministic; future opponent reactions are not.
7. Import consented human trajectories as seat-visible examples for playbooks and opponent-model
   calibration; never ingest credentials or unrevealed simultaneous choices.
8. Use the LLM only as a selector over validated near-tie candidates. Require paired-seed/seat A/B
   evidence of win/rank lift after cost and latency; remove it if it adds no measurable value.
9. Only after the simulator and baselines are reliable, evaluate imitation learning and self-play.

Current checkpoint: item 2 is implemented for the base game. The in-memory environment supports
`reset/observe/legal/step/clone`, official simultaneous-move resolution and terminal persistence.
Seeded `safe-first-legal-v1` runs reached Game Over with two and three players; the first two
`random-legal-v1` two-player seeds also completed with zero rejected actions. The randomized run
found and closed an inherited simultaneous-phase edge case: seats automatically skipped by the
official controller during restructuring/payday no longer leave an undecodable empty move, and
the runtime now fails closed if a final simultaneous submission produces no canonical save.
Item 3's dinner projection is implemented. The original state-mutating 1v1 `FcmAI` now has a
dedicated seeded offline benchmark adapter and a separate source `policyHash`; ordinary external
Agent steps suppress the browser's implicit auto-run only inside the offline environment, while
online behavior is unchanged. A two-map/four-game paired-seat smoke league completed 4/4 with zero
violations and revealed severe seat bias (seat 0 won all four), so a larger paired league remains
required before comparing policy strength. The semantic `DecisionView` now includes public market
competition and milestone threats. The strategy repository now implements the
human-data import/review trust boundary: one-seat anonymous provenance, explicit consent/license,
content hashing and three independent approval attestations; hidden choices, beliefs, credentials,
unadvertised actions and prose fail closed. A trusted live human-UI exporter is still open, so no
ordinary prose report is treated as a training trajectory.
The authoritative state now also exposes `decisionSupport.economyPlayers`, calculated only through
the loaded official player/rules/controller functions. It decodes CEO/shared subordinate slots,
free slots, salary liabilities, effective price/discount and recruiting, training, production,
marketing and restaurant-building capacity. All 35 base phase fixtures verify the projection is
present and structurally valid; the adapter fails closed if a required official calculation is
missing.
The authoritative state also exposes `decisionSupport.strategicThreats`. Milestone entries
distinguish unclaimed open, same-turn shared and closed windows directly from the public official
store. Per-house entries use official demand priority, reachability, milestone-distance, inventory,
price and tie-break inputs to list current suppliers. This view is deliberately independent per
house: it neither predicts a winner nor models sequential inventory consumption. Exact dinner
resolution remains exclusively in the isolated official `projectDinner` operation. Missing
official functions fail closed, and hidden simultaneous choices are never inspected.

The public-human replay ladder in `/home/vincent/fcm-ai` has reached 100 base-standard games.
Across 14,078 seat decision boundaries, 10,001 labels execute exactly through this adapter and the
official controller. Lossy production/payday histories and 536 known legacy-version mismatches are
quarantined rather than taught as actions. This validates the base action surface at scale; it does
not add expansion actions or replace the still-pending consented live-human exporter.

PPO is an experiment, not the default architecture; its viability depends on hierarchical
   action masking, stable observations, a well-designed reward and a population of opponents. If
   potential-difference shaping is used, its evaluator must be frozen and held-out calibrated, and
   promotion still uses raw win/rank metrics.
