/**
 * FCM HTTP API 客户端
 *
 * 直接和 Django 后端对话（复用官网的接口契约）。
 * 契约来源（实测确认，2026-09-24）：
 *   POST /login/                      登录
 *   POST /joinGame/<code>/            {gameID, action, source} JSON
 *   POST /FCM/processTurn/            {action:"loadNew"|"saveAndUpdateNotifictions", ...}
 *   POST /FCM/data/3/                 {gameID, latestUpdate} 轮询检查更新
 *   GET  /FCM/<id>/show/              游戏页（含 initData）
 */

import { CookieJar } from './cookie-jar.mjs'
import zlib from 'node:zlib'

const DEFAULT_BASE = process.env.FCM_BASE_URL || 'http://127.0.0.1:8000'

/** 解码 HTML 实体（游戏名等字段在 HTML 里是转义过的） */
function decodeEntities(s) {
  if (typeof s !== 'string') return s
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export class FCMApiClient {
  constructor({ base = DEFAULT_BASE, username, password, token } = {}) {
    this.base = base.replace(/\/$/, '')
    this.jar = new CookieJar()
    this.username = username ?? process.env.FCM_USERNAME ?? null
    this.password = password ?? process.env.FCM_PASSWORD ?? null
    this.token = token ?? process.env.FCM_AGENT_TOKEN ?? null
    this.gameID = null
    this.latestUpdate = '0'
  }

  _url(p) {
    return `${this.base}${p}`
  }

  async _fetch(path, { method = 'GET', body, headers = {}, form } = {}) {
    const h = { ...headers }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    const cookies = this.jar.header()
    if (cookies) h['Cookie'] = cookies

    let payload
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(form).toString()
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json'
      h['X-CSRFToken'] = this.jar.get('csrftoken') ?? ''
      h['X-Requested-With'] = 'XMLHttpRequest'
      payload = JSON.stringify(body)
    }

    // ★ 诊断：追踪发往 /FCM/processTurn/ 的请求体（排查空 move 问题）
    if (process.env.FCM_TRACE_HTTP === '1' && path.includes('processTurn') && payload) {
      try {
        const b = JSON.parse(payload)
        const mv = b.moveData
          ? (() => {
              try {
                const raw = Buffer.from(b.moveData, 'base64')
                return JSON.parse(zlib.gunzipSync(raw).toString('utf-8'))
              } catch {
                return `<${String(b.moveData).slice(0, 40)}>`
              }
            })()
          : undefined
        console.error(
          `[TRACE HTTP ${this.username}] action=${b.action} phase=${b.phase} turn=${b.turn} ` +
            `latestUpdate=${b.latestUpdate} BKSN=${b.BKSN} moveData=${JSON.stringify(mv)}`,
        )
      } catch (e) {
        console.error(`[TRACE HTTP ${this.username}] 解析失败: ${e.message}`)
      }
    }

    const res = await fetch(this._url(path), {
      method,
      headers: h,
      body: payload,
      redirect: 'manual',
    })

    this.jar.absorb(res.headers.getSetCookie?.() ?? [])
    return res
  }

  async _json(res, context) {
    let payload
    try {
      payload = await res.json()
    } catch {
      const error = new Error(`${context} 返回了非 JSON 响应`)
      error.code = 'INVALID_SERVER_RESPONSE'
      error.nextAction = '检查 Django Agent API 和服务器日志'
      throw error
    }
    if (!res.ok) {
      const details = payload?.error ?? {}
      const error = new Error(details.message ?? `${context} 失败 (HTTP ${res.status})`)
      error.code = details.code ?? 'HTTP_ERROR'
      error.nextAction = details.nextAction ?? '检查身份、游戏状态和请求参数后重试'
      throw error
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error(`${context} 返回的 JSON 结构无效`)
      error.code = 'INVALID_SERVER_RESPONSE'
      throw error
    }
    return payload
  }

  /** 登录（拿 session + csrftoken） */
  async login(username = this.username, password = this.password) {
    if (this.token) return this.whoami()
    if (!username || !password) throw new Error('FCM 用户名/密码未提供')

    // 1. 取登录页拿 csrf
    const page = await this._fetch('/login/')
    const html = await page.text()
    const m = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)
    if (!m) throw new Error('登录页拿不到 csrf token')

    // 2. 提交登录
    const res = await this._fetch('/login/', {
      method: 'POST',
      form: {
        csrfmiddlewaretoken: m[1],
        username,
        password,
      },
      headers: { Referer: this._url('/login/') },
    })

    if (!this.jar.get('sessionid')) throw new Error('登录失败：没有拿到 sessionid')
    this.username = username
    return { ok: true, username }
  }

  async whoami() {
    const res = await this._fetch('/FCM/agent/v1/whoami/')
    const payload = await this._json(res, '读取 Agent 身份')
    this.username = payload.username
    return payload
  }

  /**
   * 拉取游戏完整数据
   *
   * 数据来源（实测确认 2026-09-24）：
   *   - 游戏页 HTML 的 initData 里有【全部】字段：
   *       gameData（blob）、startingOptions、startingMap、playerNames、turn
   *   - /FCM/processTurn/ {action:loadNew} 只返回 gameData + latestUpdate + currentPlayers
   *
   * 所以优先走 HTML（一次拿全），loadNew 仅作补充（拿 latestUpdate）。
   */
  async getGameData(gameID) {
    this.gameID = gameID
    const res = await this._fetch(`/FCM/agent/v1/games/${gameID}/snapshot/`)
    const data = await this._json(res, `读取游戏 ${gameID}`)
    const latestUpdate = String(data.latestUpdate ?? '0')
    this.latestUpdate = latestUpdate

    return {
      id: data.id ?? gameID,
      gameName: data.gameName ?? `Game ${gameID}`,
      blob: String(data.gameData ?? ''),
      startingMap: data.startingMap ?? [],
      startingOptions: Array.isArray(data.startingOptions)
        ? data.startingOptions
        : Object.entries(data.startingOptions ?? {})
            .filter(([, v]) => v)
            .map(([k]) => k),
      startingOptionsRaw: data.startingOptions,
      playerNames: data.playerNames ?? [],
      currentPlayers: data.currentPlayers ?? [],
      turn: data.turn,
      latestUpdate,
      moveData: data.moveData ?? '',
      chatData: data.chatData ?? '',
      displayNames: data.displayNames ?? [],
      gameCreationTimestamp: data.gameCreationTimestamp,
    }
  }

  /** 兼容旧接口名 */
  async getGameBlob(gameID) {
    const d = await this.getGameData(gameID)
    return d.blob
  }

  /** 拉取游戏元信息（游戏名等，从页面/DB 可见字段） */
  async getGameMeta(gameID) {
    this.gameID = gameID
    const d = await this.getGameData(gameID)
    return {
      id: gameID,
      gameName: `Game ${gameID}`,
      startingOptions: d.startingOptions,
      startingMap: d.startingMap,
      playerNames: [],
      myName: this.username,
      status: '?',
      latestUpdate: d.latestUpdate,
    }
  }

  /** 检查是否有更新（轮询用） */
  async checkForLatest(gameID, afterVersion = this.latestUpdate) {
    const after = encodeURIComponent(String(afterVersion ?? '0'))
    const res = await this._fetch(
      `/FCM/agent/v1/games/${gameID}/changes/?afterVersion=${after}`,
    )
    const result = await this._json(res, `检查游戏 ${gameID} 更新`)
    if (result.version != null) this.latestUpdate = String(result.version)
    return result
  }

  /** 列出当前账号可见的游戏 */
  async listGames() {
    const res = await this._fetch('/FCM/agent/v1/games/?offset=0&limit=100')
    const payload = await this._json(res, '列出 FCM 游戏')
    return (payload.games ?? []).map((game) => Number(game.id))
  }

  async createGame(input) {
    const res = await this._fetch('/FCM/agent/v1/games/', {
      method: 'POST',
      body: input,
    })
    return this._json(res, '创建 FCM 游戏')
  }

  async joinGame(gameID) {
    const res = await this._fetch(`/FCM/agent/v1/games/${gameID}/join/`, {
      method: 'POST',
      body: {},
    })
    return this._json(res, `加入游戏 ${gameID}`)
  }

  async getCommandReceipt(gameID, idempotencyKey) {
    const res = await this._fetch(
      `/FCM/agent/v1/games/${gameID}/commands/${encodeURIComponent(idempotencyKey)}/`,
    )
    if (res.status === 404) {
      let payload = null
      try { payload = await res.json() } catch {}
      if (payload?.error?.code === 'COMMAND_NOT_FOUND') return null
      const error = new Error(payload?.error?.message ?? '查询命令回执失败')
      error.code = payload?.error?.code ?? 'HTTP_ERROR'
      throw error
    }
    const payload = await this._json(res, `查询游戏 ${gameID} 命令回执`)
    return payload.command
  }

  async getAuthoritativeActions(gameID) {
    const res = await this._fetch(`/FCM/agent/v1/games/${gameID}/actions/`)
    const payload = await this._json(res, `读取游戏 ${gameID} 权威动作`)
    if (payload.version != null) this.latestUpdate = String(payload.version)
    return payload
  }

  async executeActions(gameID, command) {
    const res = await this._fetch(`/FCM/agent/v1/games/${gameID}/actions/`, {
      method: 'POST',
      body: command,
    })
    const payload = await this._json(res, `执行游戏 ${gameID} 权威动作`)
    if (payload.version != null) this.latestUpdate = String(payload.version)
    return payload
  }

  /**
   * 从游戏页 HTML 解析 initData
   *
   * HTML 模板（FCM/templates/FCM/showFCMgame.html）里是这种形式：
   *   var initData = {};
   *   initData.gameID = 123;
   *   initData.startingOptions = {...};
   *   initData.startingMap = [...];
   *   initData.playerNames = [...];
   *   initData.gameData = '...';
   */
  _parseInitData(html) {
    if (!html || !html.includes('initData')) return null

    // 取 initData 区块（从 "var initData" 到 script 结束前）
    const start = html.indexOf('initData')
    const end = html.indexOf('</script>', start)
    const block = html.slice(start, end > 0 ? end : start + 20000)

    const grab = (key) => {
      // 逐个字段抓：initData.<key> = <value>
      // ★ 注意：模板里部分字段【没有分号】结尾（如 startingMap），
      //   所以用「到行尾」截断，而非「到分号」。
      const re = new RegExp(`initData\\.${key}\\s*=\\s*([^;\\n]+)`)
      const m = block.match(re)
      return m ? m[1].trim() : null
    }

    const parseVal = (raw) => {
      if (raw == null) return null
      // 引号字符串
      if (
        (raw.startsWith("'") && raw.endsWith("'")) ||
        (raw.startsWith('"') && raw.endsWith('"'))
      ) {
        return raw.slice(1, -1).replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      }
      try {
        return JSON.parse(raw)
      } catch {
        // 单引号数组（playerNames 是 ['a', 'b'] 形式）
        try {
          return JSON.parse(raw.replace(/'/g, '"'))
        } catch {
          return raw
        }
      }
    }

    const out = {
      gameID: Number(parseVal(grab('gameID'))) || null,
      gameName: decodeEntities(parseVal(grab('gameName'))),
      gameData: parseVal(grab('gameData')),
      startingOptions: parseVal(grab('startingOptions')),
      startingMap: parseVal(grab('startingMap')),
      playerNames: parseVal(grab('playerNames')),
      currentPlayers: parseVal(grab('currentPlayers')),
      currentPlayersArray: parseVal(grab('currentPlayersArray')),
      turn: parseVal(grab('turn')),
      name: parseVal(grab('name')),
      chatData: parseVal(grab('chatData')),
      displayNames: parseVal(grab('displayNames')),
      gameCreationTimestamp: parseVal(grab('gameCreationTimestamp')),
    }
    return out.gameID ? out : null
  }
}
