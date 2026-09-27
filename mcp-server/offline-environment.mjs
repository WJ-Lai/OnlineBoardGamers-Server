import { EngineRuntime } from './engine-runtime.mjs'
import { SerialExecutor } from './serial-executor.mjs'

// Pinia, the browser shims and the local transport are process-global. Every
// environment in this process must therefore share one queue, not only clones
// descended from the same parent.
const OFFLINE_ENGINE_EXECUTOR = new SerialExecutor()

function clone(value) {
  return structuredClone(value)
}

function invalidEnvironment(message) {
  const error = new Error(message)
  error.code = 'INVALID_OFFLINE_ENVIRONMENT'
  return error
}

function acceptedMovePhases(phase) {
  if ([0, 1, 2].includes(phase)) return [0, 1, 2]
  if (phase === 3) return [3, 4]
  return [5, 6, 7, 8, 9, 11, 12, 15]
}

/**
 * Cloneable, database-free environment around the authoritative FCM runtime.
 *
 * snapshot ──inspect──▶ seat-safe observation/legal actions
 *    │
 *    └──executeBatch──▶ canonical snapshot OR buffered simultaneous move
 *
 * It deliberately stores engine snapshots and simultaneous move envelopes, not a
 * second representation of FCM rules. All transitions still execute official JS.
 */
export class OfflineEnvironment {
  constructor({
    runtime = new EngineRuntime(),
    snapshot = null,
    executor = OFFLINE_ENGINE_EXECUTOR,
  } = {}) {
    this.runtime = runtime
    this._executor = executor
    this._snapshot = null
    this._moves = []
    if (snapshot) this.reset(snapshot)
  }

  static fromSeed({ seed, playerNames, gameID = 1, gameName = 'Offline FCM' }) {
    if (seed == null || !Array.isArray(playerNames)) {
      throw invalidEnvironment('fromSeed requires seed and playerNames')
    }
    return new OfflineEnvironment({
      snapshot: {
        id: gameID,
        gameName,
        status: 'ACTIVE',
        turn: 0,
        phase: 0,
        latestUpdate: '0',
        gameData: '',
        startingMap: [],
        startingOptions: [],
        playerNames: [...playerNames],
        displayNames: [...playerNames],
        currentPlayers: [...playerNames],
        mySeat: 0,
        moveData: '',
        chatData: '',
        gameCreationTimestamp: 0,
        initializationSeed: String(seed),
      },
    })
  }

  reset(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.playerNames) || snapshot.playerNames.length < 2) {
      throw invalidEnvironment('reset requires an official snapshot with at least two players')
    }
    if ((snapshot.startingOptions ?? []).length > 0) {
      throw invalidEnvironment('offline environment currently supports the base game only')
    }
    this._snapshot = clone(snapshot)
    this._snapshot.latestUpdate = String(this._snapshot.latestUpdate ?? '0')
    this._moves = this._snapshot.playerNames.map((name) => [name, [-1], '', []])
    return this.snapshot()
  }

  snapshot() {
    if (!this._snapshot) throw invalidEnvironment('environment has not been reset')
    return clone(this._snapshot)
  }

  clone() {
    const copy = new OfflineEnvironment({
      runtime: this.runtime,
      snapshot: this._snapshot,
      executor: this._executor,
    })
    copy._moves = clone(this._moves)
    return copy
  }

  _actor(seat) {
    if (!this._snapshot) throw invalidEnvironment('environment has not been reset')
    const name = this._snapshot.playerNames[seat]
    if (!Number.isInteger(seat) || !name) throw invalidEnvironment(`invalid seat ${seat}`)
    return { name, seat }
  }

  async observe(seat) {
    const snapshot = this.snapshot()
    const actor = this._actor(seat)
    return this._executor.run(() => this.runtime.inspect({ snapshot, actor }))
  }

  async legal(seat) {
    return (await this.observe(seat)).legalActions
  }

  async step(seat, actions) {
    return this._executor.run(async () => {
      const actor = this._actor(seat)
      const before = this.snapshot()
      const nextVersion = String(BigInt(before.latestUpdate) + 1n)
      const result = await this.runtime.executeBatch({
        snapshot: before,
        actor,
        expectedVersion: before.latestUpdate,
        actions: clone(actions),
        transportContext: {
          existingMoves: this._moves,
          pendingPlayerNames: before.currentPlayers ?? [],
          acceptedPhases: acceptedMovePhases(before.phase),
          nextVersion,
          sideData: '',
        },
      })

      if (result.canonicalSave) {
        const saved = result.canonicalSave
        this._snapshot = {
          ...before,
          gameData: saved.gameData,
          phase: saved.phase,
          turn: saved.turn,
          latestUpdate: nextVersion,
          currentPlayers: [...(saved.nextPlayer ?? [])],
          startingMap: saved.mapTiles ?? before.startingMap,
          status: saved.status ?? before.status,
          moveData: '',
        }
        this._moves = this._snapshot.playerNames.map((name) => [name, [-1], '', []])
      } else if (result.simultaneousSubmission) {
        this._moves = clone(result.simultaneousSubmission.moves)
        this._snapshot = {
          ...before,
          latestUpdate: nextVersion,
          currentPlayers: [...result.simultaneousSubmission.playersToMove],
          moveData: '',
        }
      } else {
        throw invalidEnvironment('official runtime returned no durable transition')
      }

      return {
        before,
        after: this.snapshot(),
        engine: result,
      }
    })
  }
}
