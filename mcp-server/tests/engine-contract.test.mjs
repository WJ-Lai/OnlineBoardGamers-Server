import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_AI_POLICY_VERSION,
  ENGINE_PROTOCOL_VERSION,
  buildBuiltinAIMetadata,
  buildEngineMetadata,
  normalizeEngineSnapshot,
  seededRandom,
} from '../engine-contract.mjs'

test('engine metadata is versioned and fingerprints the authoritative FCM sources', async () => {
  const first = await buildEngineMetadata()
  const second = await buildEngineMetadata()

  assert.equal(first.protocolVersion, ENGINE_PROTOCOL_VERSION)
  assert.match(first.rulesetHash, /^[0-9a-f]{64}$/)
  assert.equal(first.rulesetHash, second.rulesetHash)
  assert.ok(first.rulesetFiles.includes('src/js/FCMrules.js'))
  assert.ok(first.rulesetFiles.includes('src/js/FCMcontroller.js'))
})

test('built-in benchmark policy has a separate reproducible fingerprint', async () => {
  const first = await buildBuiltinAIMetadata()
  const second = await buildBuiltinAIMetadata()

  assert.equal(first.policyVersion, BUILTIN_AI_POLICY_VERSION)
  assert.match(first.policyHash, /^[0-9a-f]{64}$/)
  assert.equal(first.policyHash, second.policyHash)
  assert.deepEqual(first.policyFiles, ['src/js/FCM_AI.js'])
  assert.equal('rulesetHash' in first, false)
})

test('fresh-game random source is deterministic per server seed', () => {
  const first = seededRandom('game:7:seed:2')
  const second = seededRandom('game:7:seed:2')
  const different = seededRandom('game:8:seed:2')
  const a = [first(), first(), first()]
  assert.deepEqual(a, [second(), second(), second()])
  assert.notDeepEqual(a, [different(), different(), different()])
})

test('engine snapshot normalization accepts only the server snapshot shape', () => {
  const normalized = normalizeEngineSnapshot({
    id: 3,
    gameData: 'blob',
    startingOptions: [1, 2],
    playerNames: ['a', 'b'],
    latestUpdate: '9',
  })
  assert.equal(normalized.blob, 'blob')
  assert.deepEqual(normalized.startingOptionsRaw, [1, 2])
  assert.equal(normalized.latestUpdate, '9')

  assert.throws(
    () => normalizeEngineSnapshot({ id: 3, playerNames: 'a,b' }),
    (error) => error.code === 'INVALID_SNAPSHOT',
  )
  assert.throws(
    () => normalizeEngineSnapshot({ id: 3, playerNames: ['a'], unexpected: true }),
    (error) => error.code === 'INVALID_SNAPSHOT',
  )
})
