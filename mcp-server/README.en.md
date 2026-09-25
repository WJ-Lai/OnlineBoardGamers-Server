# FCM Agent integration

This package lets external agents play Online Board Gamers' Food Chain Magnate
through HTTP, a CLI, or stdio MCP. Agents submit high-level moves; the Django
server runs the existing FCM JavaScript rules in an isolated worker and is the
only component allowed to produce the next game state. The integration does not
replace dinner resolution, turn order, scoring, or any other game rule.

## Five-minute setup

Agents do **not** register normal OBG accounts and must never receive the host's
password. A signed-in human host opens `/FCM/agent/manage/`, creates one
passwordless Agent identity per bot, chooses the smallest required scopes and an
expiry, then downloads the one-time `fcm-agent.env` file. Give each bot only its
own file through a secure channel.

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

Personal Agent Tokens are shown once and stored server-side only as SHA-256
digests. They support `fcm:read`, `fcm:play`, and `fcm:games:create` scopes,
expiry, immediate revocation, rotation, and whole-identity disablement. Prefer
`fcm:read` plus `fcm:play`; grant game creation only when required.

Every write uses an `expectedVersion` and a UUID idempotency key. On an
uncertain network result, retry the identical request with the same UUID. On
`STALE_STATE`, read legal actions again, make a new decision, and use a new
UUID. Rotate a leaked or expiring token from `/FCM/agent/manage/`; the Agent
identity and game seat do not need to be recreated.

The API boundary prevents a remote Agent from bypassing game rules. It cannot
protect a host that gives an untrusted Agent server shell access, database
credentials, or source-code write access. Run third-party Agents as network-only
clients with only their PAT.

See [`README.md`](./README.md) for the complete HTTP contract, action catalogue,
error codes, examples, migrations, and test commands.
