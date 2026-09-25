import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'

import { AuthoritativeTransport } from '../authoritative-transport.mjs'

function compress(value) {
  return gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')
}

function decompress(value) {
  return JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8'))
}

test('simultaneous transport captures a non-final move without inventing canonical state', async () => {
  const transport = new AuthoritativeTransport({
    actorName: 'agent-a',
    existingMoves: [
      ['agent-a', [-1], '', []],
      ['agent-b', [-1], '', []],
    ],
    pendingPlayerNames: ['agent-a', 'agent-b'],
    acceptedPhases: [3, 4],
    nextVersion: '101',
  })

  const response = await transport.fetch('http://local/FCM/processTurn/', {
    body: JSON.stringify({ action: 'saveSimulMove', moveData: compress([[1], [], 0]) }),
  })
  const body = await response.json()

  assert.equal(body.allPlayersMoved, false)
  assert.deepEqual(body.playersToMove, ['agent-b'])
  assert.deepEqual(transport.simultaneousSubmission.moves[0][3], [[1], [], 0])
  assert.equal(transport.canonicalSave, null)
})

test('last simultaneous move feeds the official resolver and captures its normal save', async () => {
  const transport = new AuthoritativeTransport({
    actorName: 'agent-b',
    existingMoves: [
      ['agent-a', [3, 4], '1', [[2], [], 0]],
      ['agent-b', [-1], '', []],
    ],
    pendingPlayerNames: ['agent-b'],
    acceptedPhases: [3, 4],
    nextVersion: '102',
    sideData: 'side-data',
  })

  const simul = await transport.fetch('http://local/FCM/processTurn/', {
    body: JSON.stringify({ action: 'saveSimulMove', moveData: compress([[3], [], 1]) }),
  })
  const simulBody = await simul.json()
  assert.equal(simulBody.allPlayersMoved, true)
  assert.equal(simulBody.latestUpdate, '102')
  assert.deepEqual(decompress(simulBody.moveData)[1][3], [[3], [], 1])

  const normal = await transport.fetch('http://local/FCM/processTurn/', {
    body: JSON.stringify({ action: 'saveNormal', gameData: 'resolved-blob' }),
  })
  assert.equal((await normal.json()).sideData, 'side-data')
  assert.equal(transport.canonicalSave.gameData, 'resolved-blob')
})
