/**
 * FCM MCP Server —— 浏览器环境桥接层
 *
 * 作用：让 FCM 的前端规则代码（Vite 源码，依赖浏览器 API）能在 Node 里跑。
 * 必须在 import 任何 FCM 模块【之前】调用 setupBrowserEnv()。
 */

// 必须与 FCM 源码解析到同一份 Pinia 模块；mcp-server 自己的 node_modules
// 若加载第二份副本，两者各有一套 activePinia，全量真实运行会在 useStore() 崩溃。
import { createPinia, setActivePinia } from '../FCM/vueFCM/node_modules/pinia/dist/pinia.mjs'
import zlibBridge from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url))
const VUEFCM = path.resolve(MCP_DIR, '../FCM/vueFCM')

export function buildAgentWriteHeaders(inputHeaders = {}) {
  const headers = { ...inputHeaders }
  if (globalThis.__fcmIdempotencyKey) {
    headers['X-OBG-Idempotency-Key'] = globalThis.__fcmIdempotencyKey
  }
  if (globalThis.__fcmAgentAction) {
    headers['X-OBG-Agent-Action'] = globalThis.__fcmAgentAction
  }
  if (globalThis.__fcmCommandHash) {
    headers['X-OBG-Command-Hash'] = globalThis.__fcmCommandHash
  }
  return headers
}

/** 注入 FCM 源码依赖的浏览器全局 */
export async function setupBrowserEnv() {
  if (globalThis.__fcmEnvReady) return
  // --- 浏览器全局 ---
  globalThis.window = globalThis
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {}, classList: { contains: () => false } },
    cookie: '',
  }
  // Node 22 起 navigator 是只读 getter，需用 defineProperty 覆盖
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'fcm-mcp', language: 'en' },
      configurable: true,
      writable: true,
    })
  } catch {
    /* 若已可写则忽略 */
  }
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  }
  globalThis.location = { href: '', reload() {}, origin: 'http://127.0.0.1:8000' }
  globalThis.alert = (m) => console.log('[ALERT]', m)
  globalThis.$ = () => ({ on() {}, html() {}, append() {}, show() {}, hide() {}, empty: () => ({ on() {}, html() {}, append() {}, show() {}, hide() {} }) })

  // base64（Node 有 Buffer，但 atob/btoa 语义要与浏览器一致：binary string）
  // ★ 容错：FCM 某些路径会在 moveData 为空时也调 atob()，浏览器里会得到空串，
  //   Node 的 Buffer.from(undefined,'base64') 会抛 ERR_INVALID_ARG_TYPE。
  //   这里对齐浏览器语义：非字符串一律当空串。
  globalThis.atob = (b64) => {
    if (process.env.FCM_TRACE_ATOB && typeof b64 !== 'string') {
      console.log('[TRACE atob] 非字符串:', typeof b64, JSON.stringify(b64)?.slice(0,120))
    }
    if (process.env.FCM_TRACE_ATOB && typeof b64 === 'string' && b64.length > 0) {
      const bad = b64.replace(/[A-Za-z0-9+/=]/g, '')
      if (bad) console.log('[TRACE atob] 含非法字符:', JSON.stringify(bad.slice(0,40)), 'len=' + b64.length)
      else console.log('[TRACE atob] ok len=' + b64.length)
    }
    return Buffer.from(typeof b64 === 'string' ? b64 : '', 'base64').toString('binary')
  }
  globalThis.btoa = (s) => Buffer.from(typeof s === 'string' ? s : '', 'binary').toString('base64')

  // ★ fetch 桥：FCM_IO.js 里写的是相对路径（"/FCM/processTurn/"）。
  //   浏览器的 fetch 基于 window.location，Node 的 fetch 没有 base URL。
  //   这里包一层：
  //     - 相对路径 → 拼到 FCM 服务器地址（FCM_BASE_URL）
  //     - 自动带上 cookie（CookieJar 里的 session + csrf）
  //     - 自动注入 X-CSRFToken（FCM_IO 自己也会带，这里兜底）
  //   这是在 Node 里复刻浏览器同源行为，不是绕过任何规则。
  const RAW_FETCH = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const base = (process.env.FCM_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
    let url = typeof input === 'string' ? input : input.url
    if (url.startsWith('/')) url = `${base}${url}`

    const headers = url.includes('/FCM/processTurn/')
      ? buildAgentWriteHeaders(init.headers)
      : { ...(init.headers ?? {}) }
    const cookieHeader = globalThis.__fcmCookieJar?.header?.()
    if (cookieHeader && !headers.Cookie && !headers.cookie) headers.Cookie = cookieHeader
    if (init.method && init.method !== 'GET') {
      const csrf = globalThis.__fcmCookieJar?.get?.('csrftoken')
      if (csrf && !headers['X-CSRFToken'] && !headers['x-csrftoken']) headers['X-CSRFToken'] = csrf
    }

    // ★ 诊断：追踪官方 FCM_IO.js 发出的请求（它走 globalThis.fetch，不经 FCMApiClient）
    if (process.env.FCM_TRACE_HTTP === '1' && url.includes('processTurn') && init.body) {
      try {
        const b = JSON.parse(init.body)
        let mv = b.moveData
        if (typeof mv === 'string') {
          try {
            mv = JSON.parse(zlibBridge.gunzipSync(Buffer.from(mv, 'base64')).toString('utf-8'))
          } catch {
            mv = `<${mv.slice(0, 40)}>`
          }
        }
        console.error(
          `[TRACE OFFICIAL] action=${b.action} phase=${b.phase} turn=${b.turn} ` +
            `latestUpdate=${b.latestUpdate} BKSN=${b.BKSN} moveData=${JSON.stringify(mv)}`,
        )
      } catch (e) {
        console.error(`[TRACE OFFICIAL] 解析失败: ${e.message}`)
      }
    }

    const requestInit = {
      ...init,
      headers,
      redirect: init.redirect ?? 'manual',
    }
    const response = globalThis.__fcmLocalTransport
      ? await globalThis.__fcmLocalTransport(url, requestInit)
      : await RAW_FETCH(url, requestInit)

    // FCM_IO 的保存函数面向浏览器：遇到 syncError 时只更新 UI 文案，
    // 不抛异常。Agent 侧必须拿到机器可读结果，否则会把写入失败报告为成功。
    // 这里只读 clone，不消费原 response body。
    if (url.includes('/FCM/processTurn/')) {
      let body = null
      let text = ''
      let parsed = false
      try {
        text = await response.clone().text()
        body = text ? JSON.parse(text) : null
        parsed = body !== null && typeof body === 'object'
      } catch {
        body = null
      }
      globalThis.__fcmLastWriteResult = {
        ok: response.ok && parsed && !body?.syncError && !body?.gameNotActive,
        status: response.status,
        body,
        parsed,
      }

      if (process.env.FCM_TRACE_HTTP === '1') {
        let reqLU = '?'
        try { reqLU = JSON.parse(init.body)?.latestUpdate } catch {}
        let sideInfo = ''
        if (body && 'sideData' in body) {
          sideInfo = ` ⚠️sideData type=${Array.isArray(body.sideData) ? `ARRAY(len=${body.sideData.length})` : typeof body.sideData}`
        }
        console.error(
          `[TRACE RESP] 会话=${globalThis.__fcmActiveUser ?? '?'} 请求LU=${reqLU} → ${response.status} ${text.slice(0, 180)}${sideInfo}`,
        )
      }
    }

    return response
  }

  // pako（gzip）
  // ★ 注意：Node 里 pako.ungzip(bytes, {to:'string'}) 会二次编码出错。
  //   FCMfuncs.importFCMmodel 内部用 pako.ungzip(step1, { to: "string" })，
  //   所以这里包一层，保证它在 Node 下也能正确解出 UTF-8 文本。
  const pakoMod = await import('pako')
  const pakoRaw = pakoMod.default ?? pakoMod
  globalThis.pako = {
    ...pakoRaw,
    ungzip: (bytes, opts) => {
      const out = pakoRaw.ungzip(bytes) // 返回 Uint8Array
      if (opts && opts.to === 'string') {
        return Buffer.from(out).toString('utf8')
      }
      return out
    },
  }

  // pinia
  setActivePinia(createPinia())

  globalThis.__fcmEnvReady = true
}

/** 重置 pinia（FCM store 是单例，多次 import 会累积状态） */
export function resetStore() {
  setActivePinia(createPinia())
}

/** 设置 window.initData（initGame / importFCMmodel 依赖它） */
export function setInitData({
  startingOptions,
  startingMap,
  playerNames,
  gameID,
  name,
  chatData = '',
  pov = -99,
  latestUpdate = '-1',
  gameCreationTimestamp = 0,
  finishedGame = false,
  displayNames = [],
  notes = '',
  yourTurnAudioType = 0,
  gameData = '',
  currentPlayers = [],
}) {
  globalThis.initData = {
    startingOptions,
    startingMap,
    playerNames,
    gameID,
    name,
    // initGame 会读这些；缺了会在 funcs.decompressChatData 等处炸
    chatData,
    pov,
    latestUpdate,
    gameCreationTimestamp,
    finishedGame,
    displayNames,
    notes,
    yourTurnAudioType,
    gameData,
    currentPlayers,
  }
  globalThis.window.initData = globalThis.initData
}

/** 加载 FCM 模块（必须环境就绪后） */
export async function loadFCMModules() {
  const [rules, funcs, model, storeMod, reference, player, controller, backendIO, map] =
    await Promise.all([
      import(`${VUEFCM}/src/js/FCMrules.js`),
      import(`${VUEFCM}/src/js/FCMfuncs.js`),
      import(`${VUEFCM}/src/js/FCMmodel.js`),
      import(`${VUEFCM}/src/stores/FCMstore.js`),
      import(`${VUEFCM}/src/js/FCMreference.js`),
      import(`${VUEFCM}/src/js/FCMplayer.js`),
      import(`${VUEFCM}/src/js/FCMcontroller.js`),
      // 写操作的落库出口：saveGameNormal → POST /FCM/processTurn/
      import(`${VUEFCM}/src/backend/FCM_IO.js`),
      import(`${VUEFCM}/src/js/FCMmap.js`),
    ])
  const personalMod = globalThis.__fcmPersonalMod ?? (await import(`${VUEFCM}/src/stores/FCMpersonal.js`))
  return { rules, funcs, model, storeMod, reference, player, controller, backendIO, map, personalMod }
}

/**
 * 设置 personal store（写操作必需：saveGameNormal 读 personal.gameID / latestUpdate / pov）
 * 必须在 model store 就绪后调用。
 */
export function setPersonalState({ gameID, name, pov, latestUpdate, trainingGame = false }) {
  const { usePersonalStore } = globalThis.__fcmPersonalMod ?? {}
  if (!usePersonalStore) throw new Error('personal store 模块未加载')
  const p = usePersonalStore()
  p.gameID = gameID
  p.name = name
  p.pov = pov
  p.latestUpdate = String(latestUpdate ?? '-1')
  p.trainingGame = trainingGame
  p.haltPlay = false
  p.liveWS = false // MCP 不建 WebSocket：靠 HTTP 落库 + 轮询
  return p
}

/** 加载 personal store 模块（FCM_IO 间接依赖它） */
export async function loadPersonalStore() {
  const mod = await import(`${VUEFCM}/src/stores/FCMpersonal.js`)
  globalThis.__fcmPersonalMod = mod
  return mod
}

export const PATHS = { VUEFCM }
