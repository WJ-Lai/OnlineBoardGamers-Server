/**
 * FCM 游戏适配器 —— 把 HTTP API 的原始数据 与 FCM 规则引擎 桥接起来
 *
 * 职责：
 *   1. 从 Django API 拉取游戏（blob + 元数据）
 *   2. 把 blob 载入 FCM store（复用 importFCMmodel）
 *   3. 用 FCMrules.js 计算「当前玩家能做什么」（合法操作）
 *   4. 读取局面为结构化 JSON
 *
 * 设计原则：
 *   - 绝不直接改 blob。所有操作都要过规则层。
 *   - 只读模式：本文件不含任何写操作。
 */

import {
  setupBrowserEnv,
  setInitData,
  loadFCMModules,
  loadPersonalStore,
  setPersonalState,
  resetStore,
} from './browser-env.mjs'
import { FCMApiClient } from './api-client.mjs'
import { FCMActionLayer } from './action-layer.mjs'

// ---- 阶段名（与 FCMreference.js 的 PHASES_STR 对齐）----
/** 工作日子阶段名（官方 FCMreference.js 的 SUBPHASE_* 值） */
const SUBPHASE_NAMES = {
  1: 'HIRING（招募）',
  2: 'TRAINING（培训）',
  3: 'MARKETING（营销）',
  4: 'PRODUCE（生产）',
  5: 'HOUSES（建楼）',
  5.5: 'LOBBYISTS（征地）',
  6: 'NEW_RESTAURANTS（开分店）',
  7: 'CONFIRM_END_TURN（收尾）',
}

const PHASE_NAMES = {
  0: 'Setup - Restaurants Round 1',
  1: 'Setup - Restaurants Round 2',
  2: 'Setup - Reserve Cards',
  3: 'Restructuring',
  4: 'Order of Business',
  5: 'Working 9:00-5:00',
  6: 'Dinner Time',
  7: 'Payday',
  8: 'Marketing Campaigns',
  9: 'Clean Up',
  10: 'Game Over',
  11: 'Pizza Bomb Milestone',
  12: 'Coffee Shop Milestone',
  13: 'Setup - Draft Modules',
  14: 'Urban Planning',
  15: 'Choose CEO Bonus',
}

export class FCMAdapter {
  constructor(api) {
    this.api = api ?? new FCMApiClient()
    this.ready = false
    this.modules = null
    this.actions = null
    this.playerIndex = null
    this._res = 0
  }

  async init() {
    if (this.ready) return
    await setupBrowserEnv()
    await loadPersonalStore()
    this.modules = await loadFCMModules()
    // 让 browser-env 的 fetch 桥能拿到会话 cookie。
    // ★ 注意：__fcmCookieJar 是全局的，多个 adapter（多账号）会互相覆盖。
    //   所以每次操作前必须调 activate() 把自己设成"当前活动会话"，
    //   否则官方 FCM_IO.js 发出的请求会带上别人的 cookie，
    //   服务器端 request.user.username 取到错误的人（实测：player01 的提交
    //   被记成 player02 → player01 永远提交不上 → phase 2 死循环）。
    this.activate()
    this.ready = true
  }

  /** 把自己设为「当前活动会话」，供 browser-env 的 fetch 桥取 cookie */
  activate() {
    globalThis.__fcmCookieJar = this.api.jar
    globalThis.__fcmActiveUser = this.api.username
  }

  /**
   * ★ 执行一个动作（写操作）
   * 强制经过 action-layer 的三道闸门；不提供任何绕过入口。
   */
  async doAction(spec, { playerIndex, dryRun = false, save = null } = {}) {
    if (!this.actions) throw new Error('请先 loadGame()')
    this.activate() // ★ 确保官方 fetch 用本账号的 cookie
    return this.actions.execute(spec, {
      playerIndex: playerIndex ?? this.playerIndex,
      dryRun,
      save,
    })
  }

  /**
   * 工作日内部循环用：不重新拉局面（否则服务端的 subphase 会被重置为 1），
   * 只保证动作层实例存在。
   * action-layer 用 getStore() 动态取 store，所以这里不需要重建。
   */
  rebindActions() {
    if (!this.actions) this.actions = new FCMActionLayer({
      getStore: () => this.store,
      modules: this.modules,
      adapter: this,
    })
    return this.actions
  }

  /** 结束某座位的回合（官方 endPlayerTurn，内部自行落库） */
  async endTurn(forced = false, playerIndex = null) {
    if (!this.actions) throw new Error('请先 loadGame()')
    this.activate() // ★ 关键：官方 saveSimulMove 用全局 cookie，必须切到本账号
    return this.actions.endTurn(forced, playerIndex ?? this.playerIndex)
  }

  get store() {
    return this.modules.storeMod.useModelStore()
  }

  /**
   * 载入一局游戏到内存
   *
   * ★ 走官方 initGame()（FCMmodel.js）—— 这是前端真正的入口，它自己会处理：
   *   - gameData 为空（全新局）→ 生成随机地图 + 初始化玩家/阶段
   *   - gameData 非空        → 解压并还原局面
   *   之前直接调 importFCMmodel 只能处理后者，全新局会 "Load Decompress Error"。
   *
   * ★ includeContext 问题（原项目 bug）：
   *   FCMfuncs.js:998 在 includeContext=true 时对 store.context（reactive({})）
   *   调用 .splice()，必然崩。initGame 内部对已开局走的是
   *   importFCMmodel(gameData, false, false)，已经是干净路径，不会踩到。
   */
  async loadGame(gameID) {
    await this.init()
    this.activate() // ★ loadGame 内部 initGame 会发请求，必须用本账号 cookie

    const d = await this.api.getGameData(gameID)

    return this.loadSnapshot(d, { actorName: this.api.username })
  }

  /**
   * 从服务端已经鉴权并绑定身份的快照载入规则引擎。
   *
   * 与 loadGame() 的关键区别：这里不发 HTTP、不读取密码/会话，也不允许
   * 调用方用互不匹配的 actorName / actorSeat 冒充其他座位。Django 的权威
   * 命令端点会使用这个入口，把认证、并发控制与 FCM 规则计算分开。
   */
  async loadSnapshot(d, { actorName, actorSeat = null } = {}) {
    await this.init()

    if (!d || !Array.isArray(d.playerNames)) {
      const error = new Error('游戏快照缺少 playerNames')
      error.code = 'INVALID_SNAPSHOT'
      throw error
    }

    const derivedSeat = actorName == null ? -1 : d.playerNames.indexOf(actorName)
    if (derivedSeat < 0) {
      const error = new Error(`账号 ${actorName ?? '(missing)'} 不是游戏 ${d.id} 的玩家`)
      error.code = 'NOT_A_PLAYER'
      error.nextAction = '由服务端把已认证的 Agent 身份绑定到该游戏座位'
      throw error
    }
    if (actorSeat != null && actorSeat !== derivedSeat) {
      const error = new Error(
        `身份 ${actorName} 属于座位 ${derivedSeat}，不能以座位 ${actorSeat} 执行`,
      )
      error.code = 'ACTOR_MISMATCH'
      throw error
    }
    const me = derivedSeat

    // importFCMmodel / initGame 需要 window.initData
    setInitData({
      startingOptions: d.startingOptionsRaw ?? d.startingOptions,
      startingMap: d.startingMap,
      playerNames: d.playerNames,
      gameID: d.id,
      name: actorName,
      chatData: d.chatData ?? '',
      pov: -99,
      latestUpdate: d.latestUpdate,
      gameCreationTimestamp: d.gameCreationTimestamp,
      finishedGame: false,
      displayNames: d.displayNames,
      gameData: d.blob,
      currentPlayers: d.currentPlayers ?? [],
    })

    // ★ 重建 pinia：FCM store 是模块级单例，不重置会在多次导入间累积状态
    //   （表现为第二次 loadGame 时 IMPORT_INDEX 错位、报 undefined.map）
    resetStore()

    // 写操作需要 personal store（saveGameNormal 读 personal.gameID/latestUpdate/pov）
    // 且 pinia 刚被重建，必须在这之后重新注入。
    // 注意：initGame 自己也会设 personal.pov = window.initData.pov，所以这里
    // 先把 pov 放进 initData。
    this.playerIndex = me
    this.actorName = actorName
    this.currentGameID = d.id
    this.currentVersion = String(d.latestUpdate ?? '0')
    globalThis.initData.pov = me
    globalThis.window.initData.pov = me
    // moveData：initGame 在 phase >= WORKING_DAY 时会解压它（第 251 行）。
    // 空串是合法的（表示本轮还没提交 move）。
    globalThis.initData.moveData = d.moveData ?? ''
    globalThis.window.initData.moveData = globalThis.initData.moveData

    setPersonalState({
      gameID: d.id,
      name: actorName,
      pov: me,
      latestUpdate: d.latestUpdate,
    })

    // ★ 官方入口：处理全新局（空 gameData）与已有局
    await this.modules.model.initGame()

    // initGame 会再次写 personal.*，重设一次确保 gameID/latestUpdate 正确
    setPersonalState({
      gameID: d.id,
      name: actorName,
      pov: me,
      latestUpdate: d.latestUpdate,
    })
    this.store.gameName = d.gameName ?? `Game ${d.id}`

    // 动作层（写操作唯一入口）
    this.actions = new FCMActionLayer({
      getStore: () => this.store,
      modules: this.modules,
      adapter: this,
    })

    return {
      gameID: d.id,
      gameName: this.store.gameName,
      phase: this.store.gameflow.phase,
      phaseName: PHASE_NAMES[this.store.gameflow.phase] ?? '?',
      turn: this.store.gameflow.turn,
      players: this.store.players.map((p) => p.displayName ?? p.name),
      currentPlayers: d.currentPlayers,
      mySeat: me,
      isFreshGame: !d.blob,
    }
  }

  /** 把 store 导出回 blob（只读模式仅用于校验，不提交） */
  exportBlob(includeContext = true) {
    return this.modules.funcs.exportFCMmodel(false, includeContext)
  }

  /**
   * 读取局面（结构化 JSON）
   */
  getState() {
    const store = this.store
    return {
      gameID: this.currentGameID,
      version: this.currentVersion ?? String(this.api.latestUpdate ?? '0'),
      gameName: store.gameName,
      phase: store.gameflow.phase,
      phaseName: PHASE_NAMES[store.gameflow.phase] ?? '?',
      turn: store.gameflow.turn,
      subphase: store.gameflow.subphase,
      turnOrder: store.gameflow.turnOrder,
      newTurnOrder: store.gameflow.newTurnOrder,
      bank: store.bank,
      mySeat: this.playerIndex,
      myName: this.actorName ?? this.api.username,
      players: store.players.map((p, i) => ({
        index: i,
        name: p.displayName ?? p.name,
        money: p.money,
        resources: [...(p.resources ?? [])],
        // employees = 上班中（含 BLANK=-1 空槽）；beach = 待命区
        employees: [...(p.employees ?? [])],
        beach: [...(p.beach ?? [])],
        ceoSlots: p.ceoSlots,
        restaurants: p.restaurants,
        milestones: p.milestones,
      })),
      availableEmployees: Object.fromEntries(
        Object.entries(store.availableEmployees ?? {}).filter(([, n]) => n > 0),
      ),
      houseDemands: (store.needs ?? []).map((need) => ({
        house: need.number,
        goods: (need.needs ?? []).map((item) => item?.[0]).filter(Number.isInteger),
        restaurantDistances: this.modules.model?.giveRestaurantRangesForHouse?.(need.number) ?? [],
      })),
      activeCampaigns: (store.campaigns ?? []).map((campaign) => ({ ...campaign })),
      startingOptions: store.startingOptions,
    }
  }

  /**
   * ★ 核心：计算「当前玩家可做的合法操作」
   *
   * 全部来自 FCMrules.js —— 不重写任何规则。
   * AI 只能从这个列表里选，物理上无法做非法操作。
   */
  getLegalActions(playerIndex = this.playerIndex) {
    const store = this.store
    const rules = this.modules.rules
    const controller = this.modules.controller
    const rf = this.modules.reference
    const phase = store.gameflow.phase
    const out = { phase, phaseName: PHASE_NAMES[phase] ?? '?', actions: [] }

    // 谁该动？
    //
    // ★ 关键：FCM 分「轮替阶段」和「同时阶段」。
    //   - 轮替阶段（工作日、回合顺位…）：只有 turnOrder[0] 能动
    //   - 同时阶段（选预备卡 2 / 重组 3 / 发薪 7 / 清理 9）：
    //     **每个玩家都能动**，controller.currentPlayerIndex() 在这种阶段
    //     直接返回 personal.pov（自己），不能用来判断"轮到谁"。
    //   证据：FCMcontroller.isSimulPhase() 第 85/89 行。
    const isSimul = controller.isSimulPhase(phase)
    let currentIndex = null
    if (isSimul) {
      // 同时阶段的 turnOrder 是“尚未提交的座位”集合。提交完成后
      // 服务端会把该座位移出；不能因为阶段仍是 simul 就再次开放动作。
      const pending = store.gameflow.turnOrder ?? []
      currentIndex = pending.includes(playerIndex) ? playerIndex : null
    } else {
      try {
        const to = store.gameflow.turnOrder ?? []
        currentIndex = to.length ? to[0] : null
      } catch {
        currentIndex = null
      }
    }
    out.isSimulPhase = Boolean(isSimul)
    out.currentPlayerIndex = isSimul ? null : currentIndex
    out.yourTurn = currentIndex === playerIndex
    if (!out.yourTurn) {
      out.note = `不是座位 ${playerIndex} 的回合（当前是座位 ${currentIndex}）`
    }

    switch (phase) {
      case 0: // Setup - Restaurants, round 1
      case 1: // Setup - Restaurants, round 2
        out.actions.push({
          type: 'place_restaurant',
          rotation: store.context.rotation ?? 0,
          legalSquares: rules.givePossibleStartingRestaurantsPosition(store.context.rotation ?? 0),
          hint: '选择餐厅位置（可选点位见 legalSquares）',
        })
        out.actions.push({ type: 'finish_turn', hint: '结束放置' })
        break

      case 2: // Setup - Reserve Cards
        out.actions.push({
          type: 'choose_reserve_card',
          cardValues: [-1, 1, 2, 3],
          hint: '选一张预备卡（3 = $20 档）',
        })
        out.actions.push({ type: 'finish_turn', hint: '结束选卡' })
        break

      case 3: // Setup - Turn Order / Restructuring（同时阶段：派工）
        out.actions.push({
          type: 'place_employees',
          beach: [...(store.players[playerIndex]?.beach ?? [])],
          slots: (store.players[playerIndex]?.employees ?? []).map((e, i) =>
            e === -1 ? i : null,
          ).filter((i) => i !== null),
          hint: '把待命员工放进空槽（-1 表示空槽）',
        })
        out.actions.push({ type: 'finish_turn', hint: '结束派工' })
        break

      case 4: // Order of Business
        out.actions.push({
          type: 'choose_turn_order',
          positions: (store.gameflow.newTurnOrder ?? []).map(
            (seat, index) => seat === -1 ? index : null,
          ).filter((index) => index !== null),
        })
        break

      case 5: // Working Day —— 官方是子阶段流水线，必须按子阶段给动作
        //   HIRING(1) → TRAINING(2) → MARKETING(3) → PRODUCE(4)
        //   → HOUSES(5) → LOBBYISTS(5.5) → NEW_RESTAURANTS(6) → CONFIRM_END_TURN(7)
        {
          const sp = store.gameflow.subphase
          out.subphase = sp
          out.subphaseName = SUBPHASE_NAMES[sp] ?? String(sp)

          if (sp === 1) {
            // 招募：可以招多个（受招募点数限制）
            out.actions.push({
              type: 'hire',
              candidates: this._hireCandidates(playerIndex),
              recruitingPoints: rules.getRemainingRecruitingPoints?.(playerIndex),
            })
          } else if (sp === 2) {
            // 培训
            out.actions.push({
              type: 'train',
              available: this._trainableCandidates(playerIndex),
              trainingPoints: rules.getTrainingPoints?.(playerIndex, store.context.justTrained)?.total,
            })
          } else if (sp === 3) {
            // 营销采用一个原子动作：MCP 每次命令都会从服务器重载局面，
            // 不能把网页里的“选员工→选广告→选商品→点地图”拆成多次调用。
            const marketers = [...new Set(
              (store.players[playerIndex]?.employees ?? []).filter(
                (employee) => (rf.MARKETERS ?? []).includes(employee) &&
                  employee !== rf.MASS_MARKETEER,
              ),
            )]
            const options = marketers.map((marketer) => {
              const maxDuration = rules.giveMaxDurationForMarketer?.(marketer) ?? 1
              const campaigns = rules.possibleMarketingCampaigns(
                store.availableMarketingCampaigns ?? [], marketer,
              ).filter((campaign) => campaign >= 1 && campaign <= 16).map((campaign) => {
                const campaignData = rf.MARKETING_CAMPAIGNS?.[campaign]
                const hasMilestone = (milestone) => Number.isInteger(milestone) &&
                  Boolean(this.modules.player?.hasMilestone?.(playerIndex, milestone))
                const durationInfinite = (
                  (campaignData?.type === rf.BILLBOARD && (
                    (Number.isInteger(rf.FIRST_BILLBOARD) &&
                      (store.availableMilestones ?? []).includes(rf.FIRST_BILLBOARD)) ||
                    hasMilestone(rf.FIRST_BILLBOARD)
                  )) ||
                  (campaignData?.type === rf.RADIO &&
                    hasMilestone(rf.FIRST_BRAND_DIRECTOR_USED))
                )
                const marketingPlacement = (rotated) => {
                  const legalSquares = rules.givePossiblePositionsForMarketingCampaign(
                    marketer, campaign, rotated,
                  )
                  return {
                    rotated,
                    legalSquares,
                    houseImpacts: legalSquares.map((index) => ({
                      index,
                      houses: rules.housesAffectedByMarketingCampaign({
                        number: campaign, index, rotated,
                      }),
                    })),
                  }
                }
                const placements = [marketingPlacement(false)]
                if ((rf.ROTATABLE_CAMPAIGNS ?? []).includes(campaign)) {
                  placements.push(marketingPlacement(true))
                }
                return { campaign, durationInfinite, maxDuration, placements }
              })
              return { marketer, campaigns }
            })
            out.actions.push({
              type: 'marketing',
              goods: [0, 1, 2, 3, 4],
              options,
            })
          } else if (sp === 4) {
            // 生产
            const producers = this._producers(playerIndex)
            out.actions.push({
              type: 'produce',
              producers: producers.filter((producer) => producer.mode !== 'collect'),
            })
            const collectors = producers.filter((producer) => producer.mode === 'collect').map(
              (producer) => {
                const isZeppelin = producer.id === rf.ZEPPELIN_PILOT
                return {
                  id: producer.id,
                  name: producer.name,
                  startMode: isZeppelin ? 'tile' : 'square',
                  starts: isZeppelin
                    ? rules.givePossibleStartsFromRestaurantsForZeppelin()
                    : rules.givePossibleStartsFromRestaurants(),
                }
              },
            )
            out.actions.push({ type: 'collect_drinks', collectors })
          } else if (sp === 5) {
            const remainingBuilds = Math.max(0,
              (store.players[playerIndex]?.employees ?? []).filter(
                (employee) => employee === rf.NEW_BUSINESS_DEVELOPER,
              ).length - (store.context.justBuilt ?? []).length,
            )
            const houses = (rules.availableHouses?.() ?? []).map((house) => ({
              house,
              placements: [
                { rotation: 0, legalSquares: rules.givePossiblePositionsForBlock(2, 3) },
                { rotation: 1, legalSquares: rules.givePossiblePositionsForBlock(3, 2) },
              ],
            }))
            const gardens = (rules.availableGardens?.() ?? 0) > 0
              ? (rules.givePossibleHousesForGarden?.() ?? []).map((house) => {
                  const houseIndex = this.modules.map.findIndexForHouse(house)
                  return {
                    house,
                    houseIndex,
                    edges: this.modules.map.findFreeEdgesForHouse(house).map((edge) => ({
                      edge,
                      index: this.modules.map.giveIndexForEdge(edge, houseIndex),
                    })),
                  }
                })
              : []
            out.actions.push({
              type: 'build_house', remainingBuilds, houses, gardens,
            })
          } else if (sp === 6) {
            const player = store.players[playerIndex]
            const managers = []
            for (const manager of [rf.LOCAL_MANAGER, rf.REGIONAL_MANAGER]) {
              const owned = (player?.employees ?? []).filter(
                (employee) => employee === manager,
              ).length
              const used = (store.context.justOpened ?? []).filter(
                (employee) => employee === manager,
              ).length
              if (owned <= used) continue
              const ranged = manager === rf.LOCAL_MANAGER
              const placements = [0, 1, 2, 3].map((rotation) => ({
                rotation,
                legalSquares: rules.givePossiblePositionsForNewRestaurant(rotation, ranged),
              }))
              const actions = []
              if ((player?.restaurants ?? []).length < 3) {
                actions.push({ type: 'create', placements })
              }
              if (manager === rf.REGIONAL_MANAGER && (player?.restaurants ?? []).length > 0) {
                actions.push({
                  type: 'move',
                  restaurants: player.restaurants.map((restaurant) => restaurant.index),
                  placements,
                })
              }
              if (actions.length > 0) managers.push({ manager, remaining: owned - used, actions })
            }
            out.actions.push({ type: 'open_restaurant', managers })
          }

          // 推进子阶段（官方 endWorkingDaySubphase）—— 没这步就到不了 TRAINING/MARKETING
          if (sp < 7) out.actions.push({ type: 'next_subphase', hint: `进入下一子阶段` })
          out.actions.push({ type: 'finish_turn', hint: `结束子阶段（当前 ${out.subphaseName}）` })
        }
        break

      case 7: // Payday
        out.actions.push({
          type: 'resolve_payday',
          salaryDue: rules.salary?.(playerIndex),
          currentlyAffordable: Boolean(rules.canAffordPayDay?.(playerIndex)),
          fireableEmployees: [...(rules.fireableEmployees?.(playerIndex) ?? [])],
          payableResources: rules.canPayWithFood?.(playerIndex)
            ? [...(store.players[playerIndex]?.resources ?? [])].filter(
                (resource) => resource !== this.modules.reference?.COFFEE,
              )
            : [],
        })
        break

      case 9: // Clean Up
        {
          const resources = [...(store.players[playerIndex]?.resources ?? [])]
          const hasFridge = Boolean(this.modules.player?.hasFridge?.(playerIndex))
          const requiresFridgeChoice = Boolean(rules.kimchiFridgeCollision?.(playerIndex))
          out.actions.push({
            type: 'resolve_cleanup',
            resources,
            hasFridge,
            requiresFridgeChoice,
            minimumDiscardCount: hasFridge ? Math.max(0, resources.length - 10) : 0,
          })
        }
        break

      case 11: // First Pizza Sold: free radio campaign
        {
          const house = store.firstPizzas?.[1]
          const legalSquares = store.firstPizzas?.[2] === playerIndex
            ? (rules.givePossiblePositionsForRadioPizzaBomb?.(house) ?? []).filter(
                (index) => this.modules.map.adjacentToRoad(index),
              )
            : []
          out.actions.push({
            type: 'place_pizza_radio',
            campaign: rules.firstRadioCampaign?.(),
            house,
            legalSquares,
            canSkip: legalSquares.length === 0,
          })
        }
        break

      default:
        out.actions.push({ type: 'unknown_phase', phase })
    }

    return out
  }

  // ---- 内部辅助：从规则引擎取候选 ----

  _hireCandidates(playerIndex) {
    const store = this.store
    const rf = this.modules.reference
    const avail = store.availableEmployees ?? {}
    return Object.entries(avail)
      .filter(([, n]) => n > 0)
      .map(([id]) => ({ id: Number(id), name: rf.EMPLOYEES_STR?.[Number(id)] ?? String(id) }))
  }

  /**
   * 可培训的员工 —— 用官方 rules.possibleUpgrades() 判定（权威），
   * 与 ActionAreaWorkingDay.vue 的 computedTrainableOptions 完全同源。
   *
   * 返回 { id, name, origin, upgrades: [{id,name}] }
   *   origin: 0 = beach（待命区）, 2 = at work（已上岗）
   */
  _trainableCandidates(playerIndex) {
    const store = this.store
    const p = store.players[playerIndex]
    if (!p) return []
    const rf = this.modules.reference
    const rules = this.modules.rules
    if (typeof rules.possibleUpgrades !== 'function') return []

    const td = rules.getTrainingPoints?.(playerIndex, store.context.justTrained) ?? {
      total: 0, level2: 0, level3: 0, unlimited: false,
    }
    const justTrainedTo = (store.context.justTrained ?? []).map((x) => x.to)
    const out = []

    const collect = (emp, fromActive) => {
      if (emp < 0 || typeof emp !== 'number') return
      const levels = rules.possibleUpgrades(
          store.availableEmployees, playerIndex, emp,
          td.total ?? 0, td.level2 ?? 0, td.level3 ?? 0, td.unlimited ?? false,
          justTrainedTo, fromActive,
        )
      const upgradesById = new Map()
      levels.forEach((level, levelIndex) => {
        for (const id of level ?? []) {
          if (!upgradesById.has(id)) upgradesById.set(id, levelIndex + 1)
        }
      })
      if (!upgradesById.size) return
      out.push({
        id: emp,
        name: rf.EMPLOYEES_STR?.[emp] ?? String(emp),
        origin: fromActive ? 2 : 0,
        upgrades: [...upgradesById].map(([id, steps]) => ({
          id,
          steps,
          name: rf.EMPLOYEES_STR?.[id] ?? String(id),
        })),
      })
    }

    // beach（待命）所有人都可能可培训
    for (const e of p.beach ?? []) collect(e, false)
    // 已上岗的只有在拿到「Lemonade 里程碑」后才允许在职培训（官方规则）
    const canTrainAtWork = this.modules.player?.hasMilestone?.(
      playerIndex, rf.FIRST_LEMONADE_SOLD,
    )
    if (canTrainAtWork) for (const e of p.employees ?? []) collect(e, true)

    return out
  }

  _producers(playerIndex) {
    const store = this.store
    const p = store.players[playerIndex]
    if (!p) return []
    const rf = this.modules.reference
    const remaining = Array.isArray(store.context?.remainingProducers)
      ? store.context.remainingProducers
      : (p.employees ?? [])
    const producerTypes = new Set(rf.PRODUCERS ?? [])
    return remaining
      .filter((e) => e >= 0 && typeof e === 'number' && producerTypes.has(e))
      .map((e) => {
        const goods = this.modules.rules.givePossibleFoodDrinksChoice?.(e) ?? []
        return {
          id: e,
          name: rf.EMPLOYEES_STR?.[e] ?? String(e),
          goods: [...goods],
          mode: goods.length > 0 ? 'produce' : 'collect',
        }
      })
  }
}

export { PHASE_NAMES }
