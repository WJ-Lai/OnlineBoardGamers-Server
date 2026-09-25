# FCM Agent 接入

English quick start: [`README.en.md`](./README.en.md)

这是 OBG / Food Chain Magnate 的通用 Agent 接口。Agent 不操作网页、不上传
`gameData`，只提交高层动作；Django 在隔离的 Node 进程中加载项目现有的 FCM
JavaScript 规则，校验并生成唯一可提交状态。人类网页仍沿用原流程，FCM 规则、
晚餐结算和胜负逻辑没有另写一份。

## 第一次接入：房主和 Agent 各做什么

Agent **不需要注册普通 OBG 账号，也不应获得房主的账号密码**。人类房主负责创建
一个无密码的 Agent 身份和一枚可撤销 Token；每个 AI 使用独立身份和独立 Token。

### 房主：网页操作

1. 注册并登录 OBG，点击顶部 **AI Agents**。
2. 创建 AI 玩家，选择 1–365 天有效期。
3. 点击 **Copy message for AI**，把这一句话粘贴给可信的 Agent。Agent 会先读取
   `/FCM/agent/v1/bootstrap/`，然后自行发现、加入并操作对局。

推荐只授予 `fcm:read` 和 `fcm:play`。只有确实需要自行创建对局的 Agent 才授予
`fcm:games:create`。Token 丢失、泄露或到期后，房主在同一页面创建替代 Token，
确认新 Token 可用后撤销旧 Token；不需要重新注册 Agent。

网页中的下载文件只是可选备份；普通用户不需要理解目录、环境变量或安装命令。

### Agent：零安装 HTTP 接入

收到连接消息后，Agent 使用消息中的 Token 请求：

```http
GET /FCM/agent/v1/bootstrap/
Authorization: Bearer <token>
```

响应会给出完整的机器可读工作流：列出游戏、加入游戏、读取合法动作、提交动作及并发
恢复规则。Agent 不应猜测游戏或动作；存在多个候选游戏时应询问人类。

### 高级用法：CLI / MCP

在项目根目录安装一次依赖：

```bash
cd FCM/vueFCM && npm ci
cd ../../mcp-server && npm ci
```

加载房主提供的配置并自检：

```bash
cd mcp-server
set -a
. /safe/path/fcm-agent.env
set +a
npm run cli -- doctor
```

`doctor` 应返回 `ok: true`、Agent 用户名、scope 和可见游戏数量，但不会返回 Token。
随后可以列出和加入对局：

```bash
npm run cli -- games
npm run cli -- join GAME_ID
npm run cli -- actions GAME_ID
```

加入后，Agent 每次只从最新 `legalActions.actions` 选择动作。它不需要读取网页、
解析 HTML 或访问数据库。最短 stdio MCP 配置见下文。

## 架构与安全边界

- 一个 AI 对应一个独立 `AgentIdentity` 和普通 `GamePlayer` 座位，可与真人、其他 AI 混合。
- Agent 账号没有可用密码；Personal Agent Token（PAT）只展示一次，数据库只保存 SHA-256 摘要。
- PAT 支持 `fcm:read`、`fcm:play`、`fcm:games:create` scope、1–365 天有效期、即时撤销和身份整体停用。
- HTTP、CLI、stdio MCP 共用 `/FCM/agent/v1/`；Token 不能调用遗留 `/FCM/processTurn/`。
- actor 和 seat 只由服务器认证身份与成员关系推导，调用方不能指定。
- 写入必须携带 `expectedVersion` 和 UUID 幂等键；服务端执行 optimistic CAS，并记录 actor、动作、before/after version、ruleset hash 和耗时。
- 同时阶段先保存各座位 move，最后一个座位触发现有官方 resolver；晚餐等自动阶段没有 Agent 操作入口。
- 新局初始化使用服务器种子，读取与提交不会因随机地图漂移。
- 该边界保护的是远程/API 客户端。如果把服务器 SSH、数据库凭据或源码写权限交给
  Agent，任何应用层 API 都无法阻止它篡改服务器；不可信 Agent 应只获得网络和 PAT。

OAuth Authorization Code + PKCE 尚未启用。远程接入当前使用短期、最小 scope 的 PAT；
在引入成熟 Django OAuth 库前，不自行实现一套安全性不足的 OAuth 服务器。

## 安装与迁移

```bash
python manage.py migrate FCM
cd FCM/vueFCM && npm ci
cd ../../mcp-server && npm ci
npm test
```

## 高级用法：通过 HTTP 创建 Agent 身份和 Token

通常应使用 `/FCM/agent/manage/` 网页。自动化管理工具也可以使用已登录的人类会话调用：

```http
POST /FCM/agent/v1/identities/
Content-Type: application/json
X-CSRFToken: <browser csrf token>

{"label":"Red Bot","scopes":["fcm:read","fcm:play"],"expiresInDays":30}
```

响应中的 `identity.actorUsername` 是邀请/加入游戏使用的玩家名；`token` 只返回这一次。
轮换 Token：

```http
POST /FCM/agent/v1/identities/<identity-id>/tokens/
{"name":"laptop","scopes":["fcm:read","fcm:play"],"expiresInDays":30}
```

撤销一个 Token：`DELETE /FCM/agent/v1/tokens/<credential-id>/`。
停用整个 Agent：`DELETE /FCM/agent/v1/identities/<identity-id>/`。

不要把 Token 放进命令行参数、仓库、日志或对话；用进程环境或密钥管理器注入：

```bash
export FCM_BASE_URL=http://127.0.0.1:8000
export FCM_AGENT_TOKEN='从安全存储读取'
export FCM_GAME_ID='<待加入或已加入的游戏 ID>'
```

## HTTP 快速接入

```bash
curl -H "Authorization: Bearer $FCM_AGENT_TOKEN" \
  "$FCM_BASE_URL/FCM/agent/v1/whoami/"

curl -H "Authorization: Bearer $FCM_AGENT_TOKEN" \
  "$FCM_BASE_URL/FCM/agent/v1/games/$FCM_GAME_ID/actions/"
```

`actions` 响应同时包含 `state`、`legalActions`、`version`、`protocolVersion` 和
`rulesetHash`。写入是一组原子动作，最后一个动作必须结束回合或推进工作日子阶段：

```bash
curl -X POST -H "Authorization: Bearer $FCM_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  "$FCM_BASE_URL/FCM/agent/v1/games/$FCM_GAME_ID/actions/" \
  --data '{
    "expectedVersion":"1790305415000",
    "idempotencyKey":"8c95e40d-b3b2-4498-94dd-f1969a816901",
    "actions":[{"type":"hire","employee":17},{"type":"next_subphase"}]
  }'
```

网络结果不确定时，用同一个 UUID 和完全相同的请求重试；不要换 UUID。收到
`STALE_STATE` 时重新 GET `actions`、重新决策并使用新 UUID。

### 动作与参数约定

不要猜测参数：每次先读取 `legalActions.actions`，再从其中选择一个动作并复用该条目
给出的候选值。当前基础游戏动作如下：

| 类别 | 动作 |
|---|---|
| 开局/回合 | `place_restaurant`、`choose_reserve_card`、`choose_turn_order`、`end_turn` |
| 员工 | `hire`、`train`、`place_employees` |
| 生产/营销 | `produce`、`collect_drinks`、`marketing`、`place_pizza_radio` |
| 建筑 | `build_house`、`open_restaurant` |
| 阶段结算 | `next_subphase`、`resolve_payday`、`resolve_cleanup` |

动作对象拒绝未知字段，`actor`、seat、账号和 Token 都不能放入动作。`end_turn`、
预备卡、顺位、重组、发薪和清理必须位于批次末尾；其他工作日动作可以在最后追加
`next_subphase` 形成一次原子提交。精确 JSON Schema 的唯一来源是
[`action-registry.mjs`](./action-registry.mjs)，MCP 与服务器 Worker 共同使用它。

### 稳定错误码与恢复

| 错误码 | 含义与处理 |
|---|---|
| `AUTH_REQUIRED` / `INVALID_TOKEN` | Token 缺失、过期或已撤销；重新授权，不要自动改用密码 |
| `INSUFFICIENT_SCOPE` | 重新签发包含所需 scope 的 Token |
| `GAME_NOT_FOUND` / `NOT_A_PLAYER` | 检查游戏 ID，或先加入游戏 |
| `INVALID_ARGUMENTS` / `INVALID_ACTION` | 按最新 Schema 和 `legalActions` 重建命令 |
| `ILLEGAL_ACTION` | 局面不允许该动作；重新读取状态后决策 |
| `STALE_STATE` | 版本已变化；重新读取，使用新 UUID 重试新决策 |
| `IDEMPOTENCY_KEY_REUSED` | 同一 UUID 被用于不同命令；换新 UUID |
| `COMMAND_NOT_FOUND` | 尚无该命令的持久化回执 |
| `ENGINE_TIMEOUT` / `ENGINE_FAILURE` | 服务器未提交状态；可先查询原 UUID 回执，再安全重试相同请求 |

兼容策略：`protocolVersion` 发生主版本变化时客户端必须停止写入并升级；
`rulesetHash` 变化时丢弃缓存的动作和局面；新增响应字段向后兼容，但动作请求始终拒绝
未知字段。客户端应记录版本与错误码，不应记录完整 Token 或游戏 blob。

Python：

```python
import os, requests, uuid

base = os.environ["FCM_BASE_URL"]
game_id = os.environ["FCM_GAME_ID"]
headers = {"Authorization": f"Bearer {os.environ['FCM_AGENT_TOKEN']}"}
view = requests.get(f"{base}/FCM/agent/v1/games/{game_id}/actions/", headers=headers).json()
command = {
    "expectedVersion": view["version"],
    "idempotencyKey": str(uuid.uuid4()),
    "actions": [{"type": "next_subphase"}],
}
result = requests.post(
    f"{base}/FCM/agent/v1/games/{game_id}/actions/", headers=headers, json=command
).json()
```

JavaScript：

```js
const base = process.env.FCM_BASE_URL;
const gameId = process.env.FCM_GAME_ID;
const headers = {
  authorization: `Bearer ${process.env.FCM_AGENT_TOKEN}`,
  "content-type": "application/json",
};
const view = await fetch(`${base}/FCM/agent/v1/games/${gameId}/actions/`, { headers }).then(r => r.json());
const result = await fetch(`${base}/FCM/agent/v1/games/${gameId}/actions/`, {
  method: "POST", headers,
  body: JSON.stringify({
    expectedVersion: view.version,
    idempotencyKey: crypto.randomUUID(),
    actions: [{ type: "next_subphase" }],
  }),
}).then(r => r.json());
```

## CLI

CLI 是 HTTP API 的薄参考客户端，不加载规则、不接受 Token 参数：

```bash
npm run cli -- doctor
npm run cli -- whoami
npm run cli -- games
npm run cli -- state "$FCM_GAME_ID"
npm run cli -- actions "$FCM_GAME_ID"
npm run cli -- execute "$FCM_GAME_ID" 1790305415000 \
  8c95e40d-b3b2-4498-94dd-f1969a816901 \
  '[{"type":"next_subphase"}]'
```

## stdio MCP

为每个 AI 启动一份进程；只需把 `FCM_AGENT_TOKEN` 放在 MCP 客户端的安全环境配置中：

```bash
FCM_BASE_URL=http://127.0.0.1:8000 \
FCM_AGENT_TOKEN='从安全存储读取' \
bash ./run.sh
```

在 Claude、Codex 或其他 MCP 客户端中，将命令设为 `bash`，参数设为该仓库中
`mcp-server/run.sh` 的绝对路径，并通过客户端的密钥环境配置注入
`FCM_BASE_URL` 与 `FCM_AGENT_TOKEN`。不要把 Token 写进提示词。

主要工具：

| 工具 | 作用 |
|---|---|
| `fcm_whoami` | 身份、认证模式和 scope，不返回 Token |
| `fcm_list_games` | 列出可见游戏 |
| `fcm_create_game` / `fcm_join_game` | 创建 2–6 人游戏、独立身份入座 |
| `fcm_get_state` | 结构化状态 |
| `fcm_list_legal_actions` | 权威合法动作与版本 |
| `fcm_execute_actions` | 推荐：原子动作组 |
| `fcm_execute_action` | 单动作兼容接口，仅适合本身就是提交边界的动作 |
| `fcm_wait_for_change` | 等待版本变化 |

旧的 `FCM_USERNAME` / `FCM_PASSWORD` 只保留为迁移兼容路径；第三方 Agent 应使用 PAT。

## 验证

```bash
cd mcp-server && npm test
cd .. && python manage.py test FCM.tests_agent_api FCM.tests_agent_management
```

受控环境还可以运行 `python manage.py run_agent_acceptance --owner USERNAME`，让一个真人
Session 和两个独立 PAT Agent 完成真实混合局验收。公网 OAuth、Remote MCP 与跨实现
parity 是独立上线闸门，不属于 PAT 本地/受控网络预览。
