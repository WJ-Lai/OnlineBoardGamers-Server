import assert from 'node:assert/strict'
import test from 'node:test'

import { FCMApiClient } from '../api-client.mjs'

class FakeApiClient extends FCMApiClient {
  constructor(routes) {
    super({ base: 'http://example.test', username: 'alice', password: 'secret' })
    this.routes = routes
    this.calls = []
  }

  async _fetch(path, options = {}) {
    this.calls.push({ path, options })
    const route = this.routes[path]
    if (!route) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('game loading uses the member-scoped JSON snapshot instead of scraping HTML', async () => {
  const client = new FakeApiClient({
    '/FCM/agent/v1/games/9/snapshot/': {
      body: {
        id: 9,
        gameName: 'JSON game',
        gameData: 'blob',
        startingMap: [1, 2],
        startingOptions: [],
        playerNames: ['alice', 'bob'],
        currentPlayers: ['alice'],
        latestUpdate: '77',
        moveData: '',
        chatData: '',
        displayNames: ['alice', 'bob'],
        gameCreationTimestamp: '10',
      },
    },
  })

  const game = await client.getGameData(9)
  assert.equal(game.id, 9)
  assert.equal(game.blob, 'blob')
  assert.equal(game.latestUpdate, '77')
  assert.deepEqual(client.calls.map((call) => call.path), [
    '/FCM/agent/v1/games/9/snapshot/',
  ])
})

test('JSON API authorization errors preserve stable machine codes', async () => {
  const client = new FakeApiClient({
    '/FCM/agent/v1/games/9/snapshot/': {
      status: 403,
      body: { error: { code: 'NOT_A_PLAYER', message: 'denied', nextAction: 'join' } },
    },
  })

  await assert.rejects(
    () => client.getGameData(9),
    (error) => error.code === 'NOT_A_PLAYER' && error.nextAction === 'join',
  )
})

test('game listing uses bounded server-side pagination', async () => {
  const client = new FakeApiClient({
    '/FCM/agent/v1/games/?offset=0&limit=100': {
      body: { games: [{ id: 7 }, { id: 9 }], hasMore: false },
    },
  })
  assert.deepEqual(await client.listGames(), [7, 9])
})

test('create and join use the strict Agent JSON endpoints', async () => {
  const client = new FakeApiClient({
    '/FCM/agent/v1/games/': { body: { game: { id: 12, status: 'WAITING' } } },
    '/FCM/agent/v1/games/12/join/': {
      body: { gameID: 12, status: 'ACTIVE', alreadyJoined: false },
    },
  })
  const created = await client.createGame({
    gameName: 'Agents', maxPlayers: 4, invitedUsernames: ['bob', 'carol'],
  })
  const joined = await client.joinGame(12)

  assert.equal(created.game.id, 12)
  assert.equal(joined.status, 'ACTIVE')
  assert.deepEqual(client.calls, [
    {
      path: '/FCM/agent/v1/games/',
      options: {
        method: 'POST',
        body: { gameName: 'Agents', maxPlayers: 4, invitedUsernames: ['bob', 'carol'] },
      },
    },
    {
      path: '/FCM/agent/v1/games/12/join/',
      options: { method: 'POST', body: {} },
    },
  ])
})

test('command receipt lookup distinguishes missing from completed writes', async () => {
  const key = '8c95e40d-b3b2-4498-94dd-f1969a816901'
  const path = `/FCM/agent/v1/games/12/commands/${key}/`
  const foundClient = new FakeApiClient({
    [path]: {
      body: { command: { idempotencyKey: key, commandHash: 'a'.repeat(64), outcome: 'SUCCEEDED' } },
    },
  })
  assert.equal((await foundClient.getCommandReceipt(12, key)).outcome, 'SUCCEEDED')

  const missingClient = new FakeApiClient({
    [path]: { status: 404, body: { error: { code: 'COMMAND_NOT_FOUND' } } },
  })
  assert.equal(await missingClient.getCommandReceipt(12, key), null)
})

test('PAT mode sends bearer auth and never requires a password login', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ games: [], hasMore: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const client = new FCMApiClient({
      base: 'http://example.test', token: 'obg_pat_prefix_secret-value',
    })
    await client.listGames()
    assert.equal(calls[0].options.headers.Authorization, 'Bearer obg_pat_prefix_secret-value')
    assert.equal(client.password, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('authoritative actions use the server state and batch command endpoints', async () => {
  const client = new FakeApiClient({
    '/FCM/agent/v1/games/12/actions/': {
      body: { version: '55', state: { phase: 5 }, legalActions: { actions: [] } },
    },
  })
  const inspected = await client.getAuthoritativeActions(12)
  const executed = await client.executeActions(12, {
    expectedVersion: '55',
    idempotencyKey: '8c95e40d-b3b2-4498-94dd-f1969a816901',
    actions: [{ type: 'next_subphase' }],
  })
  assert.equal(inspected.version, '55')
  assert.equal(executed.state.phase, 5)
  assert.equal(client.calls[1].options.method, 'POST')
  assert.deepEqual(client.calls[1].options.body.actions, [{ type: 'next_subphase' }])
})
