/**
 * Pure failover selection: given account states, decide whether the call that
 * is about to run should be re-routed.
 *
 * Keeping this module free of I/O and timers makes the routing rules testable
 * and keeps the plugin's event listeners thin.
 *
 * @module dsh-plugin-quota-guard/router
 */

/** Preference order when two accounts share a priority. */
const STATUS_RANK = Object.freeze({ ok: 0, warn: 1, unknown: 2, critical: 3, exhausted: 4 })

/**
 * Allowances that belong to one model rather than to the whole account. They
 * cannot represent a model they do not monitor.
 */
const PER_MODEL_QUOTA = new Set(['tokens', 'bailian-free'])

/**
 * Find the account that owns a provider/model route.
 *
 * Exact provider + served model wins. Otherwise the first account on that
 * provider represents it, but only when its allowance is account-wide (a money
 * balance). A token ledger belongs to a single model, so it must never absorb
 * the usage — or the failover — of a different model on the same route.
 *
 * @param {readonly object[]} accounts - normalized accounts.
 * @param {string | undefined} provider - route key from the request config.
 * @param {string | undefined} model - model id from the request config.
 * @returns {object | undefined} the owning account.
 */
export function accountForRoute(accounts, provider, model) {
  if (provider === undefined || provider === '') return undefined
  const exact = accounts.find((account) => account.provider === provider && account.models.includes(model))
  if (exact !== undefined) return exact
  return accounts.find((account) => account.provider === provider && !PER_MODEL_QUOTA.has(account.quota?.kind))
}

/**
 * Whether an account may receive new traffic.
 * @param {object} account - normalized account.
 * @param {object | undefined} state - live state for that account.
 * @param {number} now - epoch milliseconds.
 * @returns {boolean}
 */
export function isEligible(account, state, now) {
  if (state === undefined) return true
  if (state.blockedUntil !== undefined && state.blockedUntil > now) return false
  return state.status !== 'critical' && state.status !== 'exhausted'
}

/**
 * Model to use when re-routing to a target account.
 * @param {object} target - candidate account.
 * @param {{provider: string, model: string}} current - route being replaced.
 * @returns {string} model id.
 */
function modelFor(target, current) {
  if (target.provider === current.provider && target.models.includes(current.model)) return current.model
  return target.model
}

/**
 * Choose a replacement route when the current one is unhealthy.
 *
 * Candidates are ordered by proven health first (ok, warn, unknown), then by
 * configured priority, then by remaining balance. Returns `undefined` in every
 * case where the call should proceed unchanged: unmanaged route, healthy
 * route, or no eligible candidate.
 *
 * @param {readonly object[]} accounts - normalized accounts.
 * @param {ReadonlyMap<string, object>} states - account id to live state.
 * @param {{provider: string, model: string}} current - route the loop would use.
 * @param {number} now - epoch milliseconds.
 * @param {{switchOrder?: 'auto' | 'manual'}} [options] - second-level ordering.
 *   `auto` (default) ranks by measured health; `manual` keeps the configured
 *   priority order inside one provider.
 * @returns {{id: string, provider: string, model: string} | undefined} target route.
 */
export function selectTarget(accounts, states, current, now, options = {}) {
  const manual = options.switchOrder === 'manual'
  const owner = accountForRoute(accounts, current.provider, current.model)
  if (owner === undefined) return undefined

  const ownerState = states.get(owner.id)
  // The owner needs replacing exactly when it may not receive new traffic.
  if (isEligible(owner, ownerState, now)) return undefined

  const candidates = accounts
    .filter((account) => account.id !== owner.id && isEligible(account, states.get(account.id), now))
    .sort((left, right) => {
      // Staying on the same platform keeps the failover inside one catalog:
      // another model of the same vendor is always preferable to a different
      // vendor, even when that other vendor is healthier or higher priority.
      const leftSame = left.provider === current.provider ? 0 : 1
      const rightSame = right.provider === current.provider ? 0 : 1
      if (leftSame !== rightSame) return leftSame - rightSame
      // Manual mode: the user's own order outranks measured health.
      if (manual && left.priority !== right.priority) return left.priority - right.priority
      const leftRank = STATUS_RANK[states.get(left.id)?.status ?? 'unknown']
      const rightRank = STATUS_RANK[states.get(right.id)?.status ?? 'unknown']
      if (leftRank !== rightRank) return leftRank - rightRank
      if (!manual && left.priority !== right.priority) return left.priority - right.priority
      const leftRemaining = states.get(left.id)?.remaining
      const rightRemaining = states.get(right.id)?.remaining
      return (rightRemaining ?? Number.NEGATIVE_INFINITY) - (leftRemaining ?? Number.NEGATIVE_INFINITY)
    })

  const target = candidates[0]
  if (target === undefined) return undefined

  const model = modelFor(target, current)
  if (target.provider === current.provider && model === current.model) return undefined
  return { id: target.id, provider: target.provider, model }
}
