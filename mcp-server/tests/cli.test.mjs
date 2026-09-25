import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCli, runCli } from '../cli.mjs'

test('CLI parses a server-authoritative batch without accepting credentials as arguments', () => {
  const parsed = parseCli([
    'execute', '61', '123', '8c95e40d-b3b2-4498-94dd-f1969a816901',
    '[{"type":"next_subphase"}]',
  ])
  assert.deepEqual(parsed, {
    command: 'execute',
    gameID: 61,
    expectedVersion: '123',
    idempotencyKey: '8c95e40d-b3b2-4498-94dd-f1969a816901',
    actions: [{ type: 'next_subphase' }],
  })
  assert.throws(
    () => parseCli(['--token', 'secret', 'games']),
    (error) => error.code === 'CLI_USAGE',
  )
})

test('CLI delegates state and execute to the same HTTP client contract', async () => {
  const calls = []
  const api = {
    getAuthoritativeActions: async (gameID) => {
      calls.push(['inspect', gameID])
      return { gameID, version: '9', state: { phase: 5 }, legalActions: { actions: [] } }
    },
    executeActions: async (gameID, payload) => {
      calls.push(['execute', gameID, payload])
      return { gameID, version: '10', resolved: true }
    },
  }
  assert.deepEqual(await runCli(parseCli(['state', '7']), api), { phase: 5 })
  const result = await runCli(parseCli([
    'execute', '7', '9', '8c95e40d-b3b2-4498-94dd-f1969a816901',
    '[{"type":"next_subphase"}]',
  ]), api)
  assert.equal(result.version, '10')
  assert.equal(calls[1][2].actions[0].type, 'next_subphase')
})

test('doctor verifies token identity and game discovery in one command', async () => {
  const calls = []
  const api = {
    base: 'https://obg.example',
    token: 'secret-that-must-not-be-returned',
    whoami: async () => {
      calls.push('whoami')
      return {
        username: 'fcm-agent-1-abc',
        authentication: 'pat',
        scopes: ['fcm:play', 'fcm:read'],
      }
    },
    listGames: async () => {
      calls.push('games')
      return [{ id: 64 }]
    },
  }

  assert.deepEqual(parseCli(['doctor']), { command: 'doctor' })
  const result = await runCli({ command: 'doctor' }, api)
  assert.deepEqual(calls, ['whoami', 'games'])
  assert.deepEqual(result, {
    ok: true,
    server: 'https://obg.example',
    username: 'fcm-agent-1-abc',
    authentication: 'pat',
    scopes: ['fcm:play', 'fcm:read'],
    visibleGames: 1,
  })
  assert.equal(JSON.stringify(result).includes(api.token), false)
})
