# FCM Agent integration

This package lets external agents play Online Board Gamers' Food Chain Magnate
through HTTP, a CLI, or stdio MCP. Agents submit high-level moves; the Django
server runs the existing FCM JavaScript rules in an isolated worker and is the
only component allowed to produce the next game state. The integration does not
replace dinner resolution, turn order, scoring, or any other game rule.

## One-message setup

Agents do **not** register normal OBG accounts and must never receive the host's
password. A signed-in human host clicks **AI Agents**, creates one passwordless
identity per bot, then clicks **Copy message for AI**. Paste that connection message
only into the trusted Agent that will use the credential.

The Agent first calls `GET /FCM/agent/v1/bootstrap/` with the supplied Bearer
Token. The response describes the complete join and play workflow in machine-readable
JSON. No repository checkout, CLI installation, browser automation, or ordinary OBG
account or downloaded configuration file is required for an Agent that can make HTTP requests.

Each AI has one permanent Token, masked by default on its card. **Refresh Token**
invalidates the old value while preserving the identity and its games. **Delete AI**
stops access while preserving historical game records.

HTTP is the canonical integration. MCP is an optional adapter over the same API;
the CLI is a maintainer/debugging client rather than an end-user onboarding step.

## Advanced CLI setup

Install dependencies once from the repository root:

```bash
cd FCM/vueFCM && npm ci
cd ../../mcp-server && npm ci
```

Load the host-provided configuration and verify it:

```bash
cd mcp-server
set -a
. /safe/path/fcm-agent.env
set +a
npm run cli -- doctor
```

The result should contain `ok: true`, the Agent username, its scopes and its
visible game count. It never prints the token. The basic play loop is:

```bash
npm run cli -- games
npm run cli -- join GAME_ID
npm run cli -- actions GAME_ID
```

Always choose from the latest `legalActions.actions`. Never invent action
parameters or upload a client-built game state.

## MCP configuration

Start one server process for each Agent identity:

```bash
FCM_BASE_URL=http://127.0.0.1:8000 \
FCM_AGENT_TOKEN='read-from-a-secret-store' \
bash ./run.sh
```

For Codex, Claude, or another MCP client, configure `bash` as the command and
the absolute path to `mcp-server/run.sh` as its argument. Inject
`FCM_BASE_URL` and `FCM_AGENT_TOKEN` through the client's secret environment;
do not put tokens in prompts or source control.

The main tools are:

| Tool | Purpose |
|---|---|
| `fcm_whoami` | Check identity and scopes |
| `fcm_list_games` | List visible games |
| `fcm_create_game` / `fcm_join_game` | Create or join a 2–6 player game |
| `fcm_get_state` | Read structured state |
| `fcm_list_legal_actions` | Get authoritative legal actions and version |
| `fcm_execute_actions` | Submit an atomic action batch |
| `fcm_wait_for_change` | Wait for another player or Agent |

## Security and recovery

Each Agent has exactly one permanent full-FCM Personal Agent Token. It is masked
by default and can be revealed or copied only by the signed-in owner. The database
stores its digest; refreshing it immediately invalidates the previous value.

Every write uses an `expectedVersion` and a UUID idempotency key. On an
uncertain network result, retry the identical request with the same UUID. On
`STALE_STATE`, read legal actions again, make a new decision, and use a new
UUID. Refresh a leaked or forgotten token from `/FCM/agent/manage/`; the Agent
identity and game seat do not need to be recreated.

The API boundary prevents a remote Agent from bypassing game rules. It cannot
protect a host that gives an untrusted Agent server shell access, database
credentials, or source-code write access. Run third-party Agents as network-only
clients with only their PAT.

Base-game state and actions are covered. The identity, transport, versioning, and
action registry are reusable for expansions, but every expansion-only decision still
needs an explicit legal-action adapter, official executor mapping, and adversarial
parity tests before it is advertised; unknown expansion actions are rejected.

See [`README.md`](./README.md) for the complete HTTP contract, action catalogue,
error codes, examples, migrations, and test commands.
