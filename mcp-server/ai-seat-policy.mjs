/**
 * FCM's working-day subphase is client-local.  The active seat must preserve
 * that pipeline, while every waiting seat must reload to observe remote turns.
 */
export function shouldRefreshSeat({ phase, yourTurn }) {
  return phase !== 5 || !yourTurn
}

export function chooseRestructureEmployees(beach, slotCount, reference) {
  const available = [...(beach ?? [])]
  const selected = []
  const take = (predicate) => {
    const index = available.findIndex(predicate)
    if (index >= 0 && selected.length < slotCount) {
      selected.push(available.splice(index, 1)[0])
    }
  }
  const recruiters = new Set([
    reference.RECRUITING_GIRL,
    reference.RECRUITING_MANAGER,
    reference.HR_DIRECTOR,
  ])
  const marketers = new Set(reference.MARKETERS ?? [])
  const producers = new Set(reference.PRODUCERS ?? [])

  take((employee) => marketers.has(employee))
  take((employee) => producers.has(employee))
  take((employee) => recruiters.has(employee))
  while (available.length > 0 && selected.length < slotCount) selected.push(available.shift())
  return selected
}
