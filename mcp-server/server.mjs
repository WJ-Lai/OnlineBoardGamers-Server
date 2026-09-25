#!/usr/bin/env node
/** FCM stdio MCP：一个进程固定绑定一个登录身份。 */

import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Ajv from 'ajv'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { FCMAdapter, PHASE_NAMES } from './fcm-adapter.mjs'
import { FCMApiClient } from './api-client.mjs'
import { FCMActionError, FCMSystemError } from './errors.mjs'
import { SerialExecutor } from './serial-executor.mjs'
import { ACTION_INPUT_SCHEMA, actionFinishesTurn } from './action-registry.mjs'

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }
const READ_ONLY = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
}
const WRITE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
}
const IDEMPOTENT_WRITE = { ...WRITE, idempotentHint: true }

export const TOOLS = [
  {
    name: 'fcm_whoami',
    description: '返回本 MCP 进程绑定的 FCM 身份和服务器。凭据不会出现在结果中。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'fcm_list_games',
    description: '分页列出当前登录账号可见的 FCM 游戏 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'fcm_create_game',
    description: '创建一个 2–6 人基础 FCM 游戏，可为多个独立的人类或 AI 账号预留座位；不接受扩展规则或调用者指定 creator。',
    inputSchema: {
      type: 'object',
      properties: {
        gameName: { type: 'string', minLength: 1, maxLength: 120 },
        gameDescription: { type: 'string', maxLength: 120 },
        maxPlayers: { type: 'integer', minimum: 2, maximum: 6, default: 2 },
        invitedUsernames: {
          type: 'array',
          maxItems: 5,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 150 },
        },
        private: { type: 'boolean', default: false },
      },
      required: ['gameName'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: WRITE,
  },
  {
    name: 'fcm_join_game',
    description: '让当前登录账号加入一个可加入或已邀请的 FCM 游戏；重复调用不会重复落座。',
    inputSchema: {
      type: 'object',
      properties: { gameID: { type: 'integer', minimum: 1 } },
      required: ['gameID'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: IDEMPOTENT_WRITE,
  },
  {
    name: 'fcm_get_state',
    description: '载入服务器最新快照并返回结构化局面，其中 version 用于后续写操作。',
    inputSchema: {
      type: 'object',
      properties: { gameID: { type: 'integer', minimum: 1 } },
      required: ['gameID'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'fcm_list_legal_actions',
    description: '返回登录账号在服务器最新局面中的合法动作；座位由账号推导，不能由调用者指定。',
    inputSchema: {
      type: 'object',
      properties: { gameID: { type: 'integer', minimum: 1 } },
      required: ['gameID'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'fcm_execute_action',
    description: '兼容接口：提交单个动作。Token 模式由服务器权威规则引擎执行；多步子阶段请使用 fcm_execute_actions。',
    inputSchema: {
      type: 'object',
      properties: {
        gameID: { type: 'integer', minimum: 1 },
        expectedVersion: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9]+$' },
        idempotencyKey: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        },
        dryRun: { type: 'boolean', default: false },
        action: ACTION_INPUT_SCHEMA,
      },
      required: ['gameID', 'expectedVersion', 'idempotencyKey', 'action'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: WRITE,
  },
  {
    name: 'fcm_execute_actions',
    description: '原子提交一组动作，最后一个动作必须结束回合或推进工作日子阶段；由服务器权威规则引擎校验和提交。',
    inputSchema: {
      type: 'object',
      properties: {
        gameID: { type: 'integer', minimum: 1 },
        expectedVersion: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9]+$' },
        idempotencyKey: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        },
        actions: { type: 'array', minItems: 1, maxItems: 64, items: ACTION_INPUT_SCHEMA },
      },
      required: ['gameID', 'expectedVersion', 'idempotencyKey', 'actions'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: WRITE,
  },
  {
    name: 'fcm_get_phase_info',
    description: '返回 FCM 阶段编号与名称。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'fcm_wait_for_change',
    description: '等待指定游戏的版本发生变化，超时则返回 changed=false；最长等待 30 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        gameID: { type: 'integer', minimum: 1 },
        afterVersion: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9]+$' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 10000 },
      },
      required: ['gameID', 'afterVersion'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
]

const ajv = new Ajv({ allErrors: true, strict: false })
const TOOL_VALIDATORS = new Map(
  TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
)

export function validateToolArguments(name, args = {}) {
  const validate = TOOL_VALIDATORS.get(name)
  if (!validate) {
    throw new FCMSystemError(`未知工具: ${name}`, 'UNKNOWN_TOOL', '重新获取工具列表')
  }
  if (!validate(args)) {
    const summary = (validate.errors ?? [])
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new FCMSystemError(
      `工具参数不符合契约：${summary}`,
      'INVALID_ARGUMENTS',
      '重新读取工具 Schema，并只提交声明过且满足范围约束的字段',
    )
  }
  return args
}

let sessionPromise = null
const commandQueue = new SerialExecutor()

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function commandFingerprint(args) {
  return createHash('sha256').update(canonicalJson({
    gameID: args.gameID,
    expectedVersion: args.expectedVersion,
    dryRun: Boolean(args.dryRun),
    action: args.action,
  })).digest('hex')
}

function requireIdentity() {
  const token = process.env.FCM_AGENT_TOKEN
  if (token) return { token, authentication: 'pat' }
  const username = process.env.FCM_USERNAME
  const password = process.env.FCM_PASSWORD
  if (!username || !password) {
    throw new FCMSystemError(
      'MCP 进程尚未配置 FCM 身份',
      'AUTH_REQUIRED',
      '为该进程设置 FCM_AGENT_TOKEN；旧版可临时使用 FCM_USERNAME/FCM_PASSWORD',
    )
  }
  return { username, password }
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const configured = requireIdentity()
      const api = new FCMApiClient(configured)
      if (configured.token) {
        const identity = await api.whoami()
        return { api, adapter: null, identity, authoritative: true }
      }
      await api.login()
      const adapter = new FCMAdapter(api)
      await adapter.init()
      return {
        api, adapter, authoritative: false,
        identity: { username: api.username, authentication: 'legacy-session' },
      }
    })().catch((error) => {
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

function assertExpectedVersion(expectedVersion, actualVersion) {
  if (String(expectedVersion) !== String(actualVersion)) {
    throw new FCMSystemError(
      `局面版本已变化：期望 ${expectedVersion}，服务器为 ${actualVersion}`,
      'STALE_STATE',
      '重新调用 fcm_get_state 和 fcm_list_legal_actions 后再决定动作',
    )
  }
}

export async function handleTool(name, args = {}) {
  validateToolArguments(name, args)
  switch (name) {
    case 'fcm_whoami': {
      const { identity, authoritative } = await getSession()
      return {
        baseUrl: process.env.FCM_BASE_URL || 'http://127.0.0.1:8000',
        username: identity.username,
        authentication: identity.authentication,
        scopes: identity.scopes,
        identityMode: 'one-token-one-agent-seat',
        mode: authoritative ? 'server-authoritative' : 'legacy-session-migration',
      }
    }
    case 'fcm_list_games': {
      const { api } = await getSession()
      const ids = await api.listGames()
      const offset = Math.max(0, args.offset ?? 0)
      const limit = Math.min(100, Math.max(1, args.limit ?? 25))
      return {
        games: ids.slice(offset, offset + limit), total: ids.length, offset, limit,
        hasMore: offset + limit < ids.length,
      }
    }
    case 'fcm_create_game': {
      const { api } = await getSession()
      return api.createGame(args)
    }
    case 'fcm_join_game': {
      const { api } = await getSession()
      return api.joinGame(args.gameID)
    }
    case 'fcm_get_state': {
      const { api, adapter, authoritative } = await getSession()
      if (authoritative) return (await api.getAuthoritativeActions(args.gameID)).state
      await adapter.loadGame(args.gameID)
      return adapter.getState()
    }
    case 'fcm_list_legal_actions': {
      const { api, adapter, authoritative } = await getSession()
      if (authoritative) {
        const result = await api.getAuthoritativeActions(args.gameID)
        return {
          gameID: result.gameID,
          version: result.version,
          protocolVersion: result.protocolVersion,
          rulesetHash: result.rulesetHash,
          mySeat: result.state?.mySeat,
          ...result.legalActions,
        }
      }
      await adapter.loadGame(args.gameID)
      return {
        gameID: args.gameID,
        version: String(adapter.api.latestUpdate),
        mySeat: adapter.playerIndex,
        ...adapter.getLegalActions(),
      }
    }
    case 'fcm_execute_action': {
      const { api, adapter, authoritative } = await getSession()
      if (authoritative) {
        if (args.dryRun) {
          throw new FCMSystemError(
            '权威批处理接口不接受 dryRun；请读取合法动作后提交',
            'INVALID_ARGUMENTS',
            '调用 fcm_list_legal_actions，或移除 dryRun',
          )
        }
        return api.executeActions(args.gameID, {
          expectedVersion: args.expectedVersion,
          idempotencyKey: args.idempotencyKey,
          actions: [args.action],
        })
      }
      const fingerprint = commandFingerprint(args)
      const previous = await adapter.api.getCommandReceipt(args.gameID, args.idempotencyKey)
      if (previous) {
        if (previous.commandHash !== fingerprint) {
          throw new FCMSystemError(
            '该 idempotencyKey 已用于不同的动作',
            'IDEMPOTENCY_KEY_REUSED',
            '为新动作生成新的 UUID；重试同一动作时必须复用原 UUID',
          )
        }
        if (previous.outcome !== 'SUCCEEDED') {
          throw new FCMSystemError(
            '此前使用该 idempotencyKey 的动作已被服务器拒绝',
            'PREVIOUS_COMMAND_REJECTED',
            '读取最新局面并使用新的 UUID 重新决策',
          )
        }
        return {
          replayed: true,
          saved: true,
          gameID: args.gameID,
          version: previous.afterVersion,
          receipt: previous,
        }
      }
      await adapter.loadGame(args.gameID)
      assertExpectedVersion(args.expectedVersion, adapter.api.latestUpdate)
      globalThis.__fcmIdempotencyKey = args.idempotencyKey
      globalThis.__fcmAgentAction = args.action.type
      globalThis.__fcmCommandHash = fingerprint
      try {
        if (args.action.type === 'end_turn') {
          if (args.dryRun) {
            const legal = adapter.getLegalActions()
            const allowed = legal.actions.some((action) => action.type === 'finish_turn')
            return {
              dryRun: true, legal: allowed,
              reason: allowed ? null : '当前阶段不允许结束回合',
              version: String(adapter.api.latestUpdate),
            }
          }
          const result = await adapter.endTurn(false)
          return { ...result, gameID: args.gameID, version: String(adapter.api.latestUpdate) }
        }
        const phase = adapter.store.gameflow.phase
        const finishesTurn = actionFinishesTurn(args.action.type) &&
          (args.action.type !== 'place_employees' || phase === 3)
        const result = await adapter.doAction(args.action, {
          playerIndex: adapter.playerIndex,
          dryRun: Boolean(args.dryRun),
          save: args.dryRun ? false : !finishesTurn,
        })
        if (finishesTurn && !args.dryRun) {
          const turnResult = await adapter.endTurn(false)
          return {
            ...result,
            saved: true,
            turnResult,
            gameID: args.gameID,
            version: String(adapter.api.latestUpdate),
          }
        }
        return { ...result, gameID: args.gameID, version: String(adapter.api.latestUpdate) }
      } finally {
        delete globalThis.__fcmIdempotencyKey
        delete globalThis.__fcmAgentAction
        delete globalThis.__fcmCommandHash
      }
    }
    case 'fcm_execute_actions': {
      const { api, authoritative } = await getSession()
      if (!authoritative) {
        throw new FCMSystemError(
          '批处理动作只支持 Agent Token 模式',
          'TOKEN_REQUIRED',
          '设置 FCM_AGENT_TOKEN 后重启 MCP',
        )
      }
      return api.executeActions(args.gameID, {
        expectedVersion: args.expectedVersion,
        idempotencyKey: args.idempotencyKey,
        actions: args.actions,
      })
    }
    case 'fcm_get_phase_info':
      return { phases: PHASE_NAMES }
    case 'fcm_wait_for_change': {
      const { api } = await getSession()
      const timeoutMs = args.timeoutMs ?? 10000
      const deadline = Date.now() + timeoutMs
      let result = await api.checkForLatest(args.gameID, args.afterVersion)
      while (!result.changed && Date.now() < deadline) {
        await delay(Math.min(500, Math.max(1, deadline - Date.now())))
        result = await api.checkForLatest(args.gameID, args.afterVersion)
      }
      return { ...result, timedOut: !result.changed }
    }
    default:
      throw new FCMSystemError(`未知工具: ${name}`, 'UNKNOWN_TOOL', '重新获取工具列表')
  }
}

export function toMcpError(error) {
  return {
    error: {
      code: error.code || (error instanceof FCMActionError ? 'ILLEGAL_ACTION' : 'INTERNAL_ERROR'),
      message: error.message || String(error),
      nextAction: error.nextAction || '重新读取游戏状态后再试',
    },
  }
}

export async function createServer() {
  const server = new Server(
    { name: 'fcm-mcp-server', version: '0.3.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    try {
      // 只有 headless engine 工具会触碰全局 window/Pinia；纯 Django API 工具可并发。
      const engineTools = new Set([
        'fcm_get_state', 'fcm_list_legal_actions', 'fcm_execute_action',
      ])
      const result = engineTools.has(name)
        ? await commandQueue.run(() => handleTool(name, args))
        : await handleTool(name, args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      }
    } catch (error) {
      const result = toMcpError(error)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      }
    }
  })
  return server
}

async function main() {
  requireIdentity()
  const server = await createServer()
  await server.connect(new StdioServerTransport())
  console.error('[fcm-mcp] server started (one process / one account)')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(`[fcm-mcp] ${error.code || 'STARTUP_ERROR'}: ${error.message}`)
    process.exitCode = 1
  })
}
