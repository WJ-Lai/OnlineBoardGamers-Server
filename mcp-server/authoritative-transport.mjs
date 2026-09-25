import { gzipSync, gunzipSync } from 'node:zlib'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function compress(value) {
  return gzipSync(Buffer.from(JSON.stringify(value))).toString('base64')
}

function decompress(value) {
  return JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8'))
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export class AuthoritativeTransport {
  constructor({
    actorName,
    existingMoves = [],
    pendingPlayerNames = [],
    acceptedPhases = [],
    nextVersion,
    sideData = '',
  }) {
    this.actorName = actorName
    this.existingMoves = clone(existingMoves)
    this.pendingPlayerNames = [...pendingPlayerNames]
    this.acceptedPhases = [...acceptedPhases]
    this.nextVersion = String(nextVersion)
    this.sideData = sideData
    this.requests = []
    this.simultaneousSubmission = null
    this.canonicalSave = null
  }

  fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    this.requests.push(body)

    if (body.action === 'saveSimulMove') {
      const moves = clone(this.existingMoves)
      const index = moves.findIndex((entry) => entry?.[0] === this.actorName)
      if (index < 0) return jsonResponse({ error: 'actor missing from move scaffold' }, 400)
      moves[index] = [
        this.actorName,
        [...this.acceptedPhases],
        String(Date.now()),
        decompress(body.moveData),
      ]
      const notRequired = new Set(body.notRequiedPlayerNames ?? [])
      const playersToMove = this.pendingPlayerNames.filter(
        (name) => name !== this.actorName && !notRequired.has(name),
      )
      this.simultaneousSubmission = { request: body, moves, playersToMove }
      if (playersToMove.length) {
        return jsonResponse({ allPlayersMoved: false, playersToMove })
      }
      return jsonResponse({
        allPlayersMoved: true,
        moveData: compress(moves),
        latestUpdate: this.nextVersion,
      })
    }

    if (body.action === 'saveNormal') {
      this.canonicalSave = body
      return jsonResponse({
        latestUpdate: this.nextVersion,
        ...(this.sideData ? { sideData: this.sideData } : {}),
      })
    }

    // deleteMoveData and other official housekeeping calls are acknowledged;
    // Django applies their durable effect together with the final CAS commit.
    return jsonResponse({ latestUpdate: this.nextVersion })
  }
}
