import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const ENGINE_PROTOCOL_VERSION = 'fcm-engine-v1'

const VUE_ROOT = new URL('../FCM/vueFCM/', import.meta.url)

export const RULESET_FILES = Object.freeze([
  'src/js/FCMrules.js',
  'src/js/FCMcontroller.js',
  'src/js/FCMmodel.js',
  'src/js/FCMplayer.js',
  'src/js/FCMfuncs.js',
  'src/js/FCMmap.js',
  'src/js/FCMreference.js',
  'src/stores/FCMstore.js',
])

const SNAPSHOT_FIELDS = new Set([
  'id', 'gameName', 'status', 'turn', 'phase', 'latestUpdate', 'gameData',
  'startingMap', 'startingOptions', 'playerNames', 'displayNames',
  'currentPlayers', 'mySeat', 'moveData', 'chatData', 'gameCreationTimestamp',
  'initializationSeed',
])

function invalidSnapshot(message) {
  const error = new Error(message)
  error.code = 'INVALID_SNAPSHOT'
  return error
}

export function seededRandom(seedValue) {
  let seed = 2166136261
  for (const char of String(seedValue)) {
    seed ^= char.charCodeAt(0)
    seed = Math.imul(seed, 16777619)
  }
  return () => {
    seed += 0x6D2B79F5
    let value = seed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export async function buildEngineMetadata() {
  const hash = createHash('sha256')
  for (const relativePath of RULESET_FILES) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(await readFile(new URL(relativePath, VUE_ROOT)))
    hash.update('\0')
  }
  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    rulesetHash: hash.digest('hex'),
    rulesetFiles: [...RULESET_FILES],
  }
}

export function normalizeEngineSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidSnapshot('snapshot must be a JSON object')
  }
  const unknown = Object.keys(input).filter((key) => !SNAPSHOT_FIELDS.has(key))
  if (unknown.length) {
    throw invalidSnapshot(`unknown snapshot fields: ${unknown.sort().join(', ')}`)
  }
  if (!Number.isInteger(input.id) || input.id < 1) {
    throw invalidSnapshot('snapshot.id must be a positive integer')
  }
  if (!Array.isArray(input.playerNames) || input.playerNames.some(
    (name) => typeof name !== 'string' || !name,
  )) {
    throw invalidSnapshot('snapshot.playerNames must be an array of non-empty strings')
  }
  if (new Set(input.playerNames).size !== input.playerNames.length) {
    throw invalidSnapshot('snapshot.playerNames must not contain duplicates')
  }
  const startingOptions = input.startingOptions ?? []
  if (!Array.isArray(startingOptions) && (
    !startingOptions || typeof startingOptions !== 'object'
  )) {
    throw invalidSnapshot('snapshot.startingOptions must be an array or object')
  }
  const normalizedOptions = Array.isArray(startingOptions)
    ? [...startingOptions]
    : Object.entries(startingOptions).filter(([, enabled]) => enabled).map(([key]) => key)

  return {
    ...input,
    blob: String(input.gameData ?? ''),
    startingMap: input.startingMap ?? [],
    startingOptions: normalizedOptions,
    startingOptionsRaw: startingOptions,
    displayNames: input.displayNames ?? input.playerNames,
    currentPlayers: input.currentPlayers ?? [],
    moveData: input.moveData ?? '',
    chatData: input.chatData ?? '',
    latestUpdate: String(input.latestUpdate ?? '0'),
  }
}
