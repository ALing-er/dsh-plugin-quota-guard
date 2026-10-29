/**
 * Runtime state owner: balance probes, alerts, usage accounting, and failover
 * decisions. The HTTP API and the plugin wiring both read this object, so the
 * account list can change at runtime without rebuilding the plugin.
 *
 * @module dsh-plugin-quota-guard/controller
 */

import { normalizeAccount, serializeAccount } from './config.js'
import { probeBalance } from './probes.js'
import { probeQuota } from './quota-probe.js'
import { queryFreeQuota } from './bailian.js'
import { accountForRoute, selectTarget } from './router.js'
import { formatBalanceAlert, formatSwitchAlert, sendWebhook } from './alerts.js'

/** Severity ordering for alert promotion. */
const SEVERITY = Object.freeze({ unknown: 0, ok: 0, warn: 1, critical: 2, exhausted: 3 })

/** Token counters that start at zero per account. */
const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Initial live state for one account.
 * @param {object} account - normalized account.
 * @param {{spent?: number, lastCost?: number | null}} [saved] - spend carried
 *   over from the previous run.
 * @returns {object} state.
 */
export function initialState(account, saved) {
  return {
    status: 'unknown',
    remaining: null,
    probedRemaining: null,
    remainingPercent: null,
    quota: null,
    currency: account.currency ?? null,
    spent: saved?.spent ?? 0,
    lastCost: saved?.lastCost ?? null,
    source: 'init',
    stale: false,
    checkedAt: 0,
    lastProbeAt: 0,
    blockedUntil: 0,
    note: '',
  }
}

/**
 * Create the runtime controller.
 * @param {object} options - dependencies.
 * @param {object} options.config - normalized config without its account list.
 * @param {unknown[]} options.entries - raw account entries (patch config or store).
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {() => number} options.now - clock.
 * @param {(level: string, text: string) => void} options.log - logger.
 * @param {(ref: string) => Promise<string | undefined>} options.resolveApiKey - credential lookup.
 * @param {(accounts: object[]) => Promise<void>} options.persist - durable account list writer.
 * @param {Map<string, {spent: number, lastCost: number | null}>} [options.savedSpend] - spend restored from the store.
 * @param {'auto' | 'manual'} [options.switchOrder] - second-level ordering restored from the store.
 * @param {(provider: string) => Promise<string[]>} [options.providerModels] - models the host's route can call.
 * @param {string} [options.storePath] - displayed in the snapshot footer.
 * @returns {object} controller API.
 */
export function createController(options) {
  const { config, fetchImpl, now, log, resolveApiKey, persist, storePath, quotaProbe = probeQuota, freeQuotaProbe = queryFreeQuota, savedSpend, providerModels } = options

  /** @type {object[]} */
  let accounts = []
  /** @type {Map<string, object>} */
  const states = new Map()
  /** @type {Map<string, object>} */
  const usage = new Map()
  /** @type {Map<string, object>} */
  const spendAnchors = new Map()
  /** @type {Map<string, number>} */
  const alertMemory = new Map()
  /** Route of the most recent model request, i.e. what the foreground is using. */
  let lastRoute
  /** Outcome of the most recent one-click switch, for page diagnostics. */
  let lastSwitch
  let refreshing
  /** In-flight background refresh of stale accounts. */
  let staleRun
  /** Whether the second-level failover follows measured health or manual order. */
  let switchOrder = options.switchOrder === 'manual' ? 'manual' : 'auto'

  for (const [index, entry] of (options.entries ?? []).entries()) {
    let account
    try {
      account = normalizeAccount(entry, `accounts[${index}]`)
    } catch (error) {
      log('warn', `[quota-guard] 跳过无效账户：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (accounts.some((existing) => existing.id === account.id)) {
      log('warn', `[quota-guard] 跳过重复账户 "${account.id}"`)
      continue
    }
    accounts.push(account)
    const saved = savedSpend?.get(account.id)
    states.set(account.id, initialState(account, saved))
    // The token ledger counts from the previous run's totals, so a restart does
    // not hand back allowance that was already consumed.
    if (saved?.usage !== undefined && saved.usage !== null && typeof saved.usage === 'object') {
      usage.set(account.id, { ...EMPTY_USAGE, ...saved.usage })
    }
  }

  /**
   * Current token totals for one account.
   * @param {string} id - account id.
   * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
   */
  function usageOf(id) {
    return usage.get(id) ?? EMPTY_USAGE
  }

  /**
   * Spend totals worth persisting, so a restart does not reset the estimate.
   * @returns {Record<string, {spent: number, lastCost: number | null}>}
   */
  function spendState() {
    /** @type {Record<string, {spent: number, lastCost: number | null, usage: object}>} */
    const saved = {}
    for (const [id, state] of states) {
      const totals = usageOf(id)
      const used = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
      if ((state.spent ?? 0) <= 0 && used === 0) continue
      saved[id] = { spent: state.spent ?? 0, lastCost: state.lastCost ?? null, usage: { ...totals } }
    }
    return saved
  }

  /**
   * Push one alert through the logger and the optional webhook.
   * @param {string} text - rendered alert.
   * @returns {Promise<void>} resolves after the webhook settles (never rejects).
   */
  async function deliver(text) {
    log('warn', text)
    if (config.alert.webhookUrl === undefined) return
    try {
      await sendWebhook(config.alert, text, fetchImpl)
    } catch (error) {
      log('warn', `[quota-guard] webhook 推送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Derive the visible status from state and thresholds.
   * @param {object} account - normalized account.
   * @param {object} state - live state.
   * @param {number} at - epoch milliseconds.
   * @returns {string} status.
   */
  function resolveStatus(account, state, at) {
    if (state.blockedUntil > at) return 'exhausted'
    // Level 2: subscription / allowance percentages.
    if (state.quota !== null && state.quota !== undefined && state.remainingPercent !== null) {
      const remaining = state.remainingPercent
      if (remaining <= account.quota.criticalPercent) return remaining <= 0 ? 'exhausted' : 'critical'
      if (remaining <= account.quota.warnPercent) return 'warn'
      return 'ok'
    }
    // Level 1: monetary balance.
    if (state.remaining === null) return 'unknown'
    if (state.stale && state.lastProbeAt > 0 && at - state.lastProbeAt > config.staleAfterMs) return 'unknown'
    if (state.remaining <= 0) return 'exhausted'
    if (account.criticalBelow !== null && state.remaining <= account.criticalBelow) return 'critical'
    if (account.warnBelow !== null && state.remaining <= account.warnBelow) return 'warn'
    return 'ok'
  }

  /**
   * Degrade a missing probe into a usage-based estimate.
   * @param {object} account - normalized account.
   * @param {object} state - state being updated in place.
   * @param {number} at - epoch milliseconds.
   * @returns {void}
   */
  function applyEstimate(account, state, at) {
    state.checkedAt = at
    if (state.probedRemaining === null) return
    if (account.pricing === null) {
      state.remaining = state.probedRemaining
      state.stale = true
      return
    }
    const anchor = spendAnchors.get(account.id) ?? EMPTY_USAGE
    const current = usageOf(account.id)
    const spent =
      ((current.input - anchor.input) / 1e6) * account.pricing.inputPerMTok +
      ((current.output - anchor.output) / 1e6) * account.pricing.outputPerMTok +
      ((current.cacheRead - anchor.cacheRead) / 1e6) * account.pricing.cacheReadPerMTok +
      ((current.cacheWrite - anchor.cacheWrite) / 1e6) * account.pricing.cacheWritePerMTok
    state.remaining = Math.max(0, state.probedRemaining - spent)
    state.source = 'estimate'
    state.stale = true
  }

  /**
   * Estimate the remaining balance locally for a platform that exposes no
   * balance endpoint: `startAmount` minus everything dsh has spent so far.
   *
   * This is an approximation, not a measurement — it can only see calls made
   * through this harness, and it depends on the configured per-token prices.
   *
   * @param {object} account - normalized account.
   * @param {object} state - state being updated in place.
   * @param {number} at - epoch milliseconds.
   * @returns {boolean} whether an estimate could be produced.
   */
  function applySpendEstimate(account, state, at) {
    const start = account.balance.startAmount
    if (typeof start !== 'number' || account.pricing === null) return false
    state.checkedAt = at
    state.remaining = Math.max(0, start - (state.spent ?? 0))
    state.currency = account.currency ?? 'CNY'
    state.source = 'estimate'
    state.stale = true
    return true
  }

  /**
   * One free-quota reading, reused for a minute per model. A per-model question
   * is needed because `--all` omits models whose allowance is already gone.
   * @param {string} model - model id.
   * @returns {Promise<object>} probe result.
   */
  const freeQuotaCache = new Map()
  // Never cache longer than the freshness window, or a blocking re-probe would
  // be served from the cache and the failover would still lag behind.
  const freeQuotaTtlMs = Math.min(60_000, config.routeFreshMs)
  // One `--all` reading serves every same-provider candidate at once.
  const freeQuotaAllCache = { at: 0, result: undefined }
  const providerModelCache = new Map()
  async function bailianFreeQuota(model) {
    const at = now()
    const cached = freeQuotaCache.get(model)
    if (cached !== undefined && at - cached.at < freeQuotaTtlMs) return cached.result
    let result
    try {
      result = await freeQuotaProbe({ model })
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    freeQuotaCache.set(model, { at, result })
    return result
  }

  /**
   * Every model's free allowance in one CLI call, reused for the freshness
   * window. The rows also seed the per-model cache so an adopted model does not
   * trigger a second CLI run.
   * @returns {Promise<object>} probe result.
   */
  async function freeQuotaAll() {
    const at = now()
    if (freeQuotaAllCache.result !== undefined && at - freeQuotaAllCache.at < freeQuotaTtlMs) {
      return freeQuotaAllCache.result
    }
    let result
    try {
      result = await freeQuotaProbe({})
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    freeQuotaAllCache.at = at
    freeQuotaAllCache.result = result
    if (result.ok === true) {
      for (const row of result.models) freeQuotaCache.set(row.model, { at, result: { ok: true, models: [row] } })
    }
    return result
  }

  /**
   * Models the host's route can actually call, cached briefly.
   * @param {string} provider - provider id.
   * @returns {Promise<string[]>} model ids.
   */
  async function routeModels(provider) {
    if (typeof providerModels !== 'function') return []
    const at = now()
    const cached = providerModelCache.get(provider)
    if (cached !== undefined && at - cached.at < freeQuotaTtlMs) return cached.models
    let models = []
    try {
      const listed = await providerModels(provider)
      if (Array.isArray(listed)) {
        models = [...new Set(listed.filter((model) => typeof model === 'string' && model !== ''))]
      }
    } catch {
      // A route that cannot enumerate itself simply offers no siblings.
    }
    providerModelCache.set(provider, { at, models })
    return models
  }

  /**
   * Turn a provider/model pair into a settings-safe account id.
   * @param {string} provider - provider id.
   * @param {string} model - model id.
   * @returns {string} slug.
   */
  function siblingId(provider, model) {
    const slug = `${provider}-auto-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return slug.slice(0, 60)
  }

  /**
   * Add one discovered sibling to the monitored list so later decisions and the
   * Settings page treat it like any other account.
   * @param {object} owner - the exhausted account on the same provider.
   * @param {{model: string}} row - the allowance row that made it eligible.
   * @returns {Promise<object | undefined>} the adopted account.
   */
  async function adoptSibling(owner, row) {
    if (accounts.some((account) => account.provider === owner.provider
      && (account.model === row.model || account.models.includes(row.model)))) return undefined
    return upsertAccount({
      id: siblingId(owner.provider, row.model),
      label: `${owner.label} / ${row.model}`,
      provider: owner.provider,
      model: row.model,
      models: [row.model],
      priority: owner.priority + 1,
      balance: { kind: 'none' },
      ...(owner.siteUrl === undefined ? {} : { siteUrl: owner.siteUrl }),
      quota: {
        kind: 'bailian-free',
        warnPercent: owner.quota.warnPercent,
        criticalPercent: owner.quota.criticalPercent,
      },
    })
  }

  /**
   * Pick an unmonitored model on the same provider that still has free quota.
   *
   * This is the middle tier between “another monitored model of the vendor” and
   * “another vendor”: a platform usually ships several models with their own
   * free allowances, and switching vendor while those sit unused wastes them.
   *
   * @param {object} owner - the exhausted account owning the current route.
   * @returns {Promise<{id: string, provider: string, model: string} | undefined>}
   */
  async function autoSibling(owner) {
    if (!config.autoAdoptModels || owner.quota?.kind !== 'bailian-free') return undefined
    const models = await routeModels(owner.provider)
    if (models.length === 0) return undefined
    const monitored = new Set(accounts
      .filter((account) => account.provider === owner.provider)
      .flatMap((account) => [account.model, ...account.models]))
    const pool = models.filter((model) => !monitored.has(model))
    if (pool.length === 0) return undefined
    const listing = await freeQuotaAll()
    if (listing.ok !== true) return undefined
    const floor = typeof owner.quota.criticalPercent === 'number' ? owner.quota.criticalPercent : 5
    const best = pool
      .map((model) => listing.models.find((row) => row.model === model))
      .filter((row) => row !== undefined && row.hasQuota === true && row.remainingPercent > floor)
      .sort((left, right) => right.remainingPercent - left.remainingPercent)[0]
    if (best === undefined) return undefined
    const adopted = await adoptSibling(owner, best)
    return adopted === undefined
      ? undefined
      : { id: adopted.id, provider: adopted.provider, model: adopted.model }
  }

  /**
   * Make sure one model of a platform is monitored, adopting it when needed.
   * @param {string} provider - provider id.
   * @param {string} model - model id.
   * @returns {Promise<object | undefined>} the monitored account.
   */
  async function adoptModel(provider, model) {
    const existing = accounts.find((account) => account.provider === provider
      && (account.model === model || account.models.includes(model)))
    if (existing !== undefined) return existing
    const template = accounts.find((account) => account.provider === provider
      && account.quota?.kind === 'bailian-free')
    if (template === undefined) return undefined
    const models = await routeModels(provider)
    if (models.length > 0 && !models.includes(model)) return undefined
    return adoptSibling(template, { model })
  }

  /**
   * Other models of one platform that still carry free quota, for the
   * one-click switch list shown next to an exhausted card.
   * @param {string} provider - provider id.
   * @returns {Promise<object[]>} sorted candidates.
   */
  async function recommendations(provider) {
    const template = accounts.find((account) => account.provider === provider
      && account.quota?.kind === 'bailian-free')
    if (template === undefined) return []
    const models = await routeModels(provider)
    if (models.length === 0) return []
    const listing = await freeQuotaAll()
    if (listing.ok !== true) return []
    const at = now()
    const blocked = new Set(accounts
      .filter((account) => account.provider === provider)
      .filter((account) => {
        const state = states.get(account.id)
        return state !== undefined
          && (state.blockedUntil > at || state.status === 'critical' || state.status === 'exhausted')
      })
      .flatMap((account) => [account.model, ...account.models]))
    const floor = typeof template.quota.criticalPercent === 'number' ? template.quota.criticalPercent : 5
    return models
      .filter((model) => !blocked.has(model))
      .map((model) => listing.models.find((row) => row.model === model))
      .filter((row) => row !== undefined && row.hasQuota === true && row.remainingPercent > floor)
      .sort((left, right) => right.remainingPercent - left.remainingPercent)
      .map((row) => ({
        model: row.model,
        remaining: row.remaining,
        total: row.total,
        remainingPercent: row.remainingPercent,
        ...(row.expires === undefined ? {} : { expires: row.expires }),
        monitored: accounts.some((account) => account.provider === provider
          && (account.model === row.model || account.models.includes(row.model))),
      }))
  }

  /**
   * Emit a threshold alert only when severity climbs, rate limited per account.
   * @param {object} account - normalized account.
   * @param {object} previous - prior state.
   * @param {object} next - new state.
   * @returns {Promise<void>}
   */
  async function maybeAlert(account, previous, next) {
    if (next.status === 'unknown' || next.status === 'ok') return
    if (SEVERITY[next.status] <= SEVERITY[previous.status]) return
    const at = now()
    const last = alertMemory.get(account.id) ?? 0
    if (at - last < config.alert.minIntervalMs) return
    alertMemory.set(account.id, at)
    await deliver(formatBalanceAlert(account, next, next.status))
  }

  /**
   * Refresh one account's state.
   *
   * Escalation strategy:
   *  1. a monetary balance endpoint when one is configured;
   *  2. otherwise a subscription / per-allowance quota probe;
   *  3. otherwise report that nothing is queryable and point at the console.
   *
   * @param {object} account - normalized account.
   * @returns {Promise<void>}
   */
  async function refreshAccount(account) {
    const previous = states.get(account.id) ?? initialState(account)
    const startedAt = now()
    const next = { ...previous }
    const levelOne = account.balance.kind !== 'none'
    const levelTwo = !levelOne && account.quota.kind !== 'none'

    if (levelOne) {
      let probe
      try {
        probe = await probeBalance(account, { resolveApiKey, fetchImpl, timeoutMs: config.probeTimeoutMs })
      } catch (error) {
        probe = { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
      }
      if (probe.kind === 'balance') {
        next.probedRemaining = probe.remaining
        next.remaining = probe.remaining
        next.currency = probe.currency ?? account.currency ?? previous.currency
        next.source = probe.source
        next.stale = false
        next.lastProbeAt = startedAt
        next.checkedAt = startedAt
        next.note = ''
        next.quota = null
        next.remainingPercent = null
        spendAnchors.set(account.id, { ...usageOf(account.id) })
      } else {
        applyEstimate(account, next, startedAt)
        next.note = probe.kind === 'unsupported' ? '' : probe.reason
        // A failed Alibaba Cloud balance call is a level-3 outcome for that
        // account: nothing local can be measured, so point at the console.
        if (probe.kind !== 'unsupported' && account.balance.kind === 'aliyun' && account.siteUrl !== undefined) {
          next.note = `${next.note}；请在官网核对余额：${account.siteUrl}`
        }
      }
    } else if (levelTwo) {
      next.checkedAt = startedAt
      next.remaining = null
      next.probedRemaining = null
      // Level 2a: the platform publishes a per-model free allowance through its
      // CLI; rows are matched by model id.
      if (account.quota.kind === 'bailian-free') {
        const result = await bailianFreeQuota(account.model)
        const entry = result.ok === true
          ? result.models.find((model) => model.model === account.model)
            ?? result.models.find((model) => account.models.includes(model.model))
          : undefined
        if (result.ok !== true) {
          next.quota = null
          next.remainingPercent = null
          next.source = 'unavailable'
          next.note = `无法读取百炼免费额度：${result.reason}`
        } else if (entry === undefined || entry.hasQuota === false) {
          // The CLI answers nulls (or omits the row) once an allowance is gone.
          next.quota = {
            source: 'bailian-free',
            product: 'free-quota',
            periods: [{ label: '免费额度', remainingPercent: 0 }],
          }
          next.remainingPercent = 0
          next.source = 'bailian-free'
          next.stale = false
          next.lastProbeAt = startedAt
          next.note = entry === undefined
            ? `百炼没有 ${account.model} 的免费额度（未开通或已用完）`
            : `${account.model} 的免费额度已用完；以官网为准`
        } else {
          next.quota = {
            source: 'bailian-free',
            product: 'free-quota',
            periods: [{ label: '免费额度', remainingPercent: entry.remainingPercent }],
          }
          next.remainingPercent = entry.remainingPercent
          next.source = 'bailian-free'
          next.stale = false
          next.lastProbeAt = startedAt
          const expires = entry.expires === undefined ? '' : `，${entry.expires} 到期`
          next.note = `免费额度剩余 ${formatTokens(entry.remaining)} / ${formatTokens(entry.total)} token${expires}；以官网为准`
        }
      } else if (account.quota.kind === 'tokens') {
        const totals = usageOf(account.id)
        const used = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
        const allowance = account.quota.startTokens
        const left = Math.max(0, allowance - used)
        const remainingPercent = allowance > 0 ? (left / allowance) * 100 : 0
        next.quota = {
          source: 'token-ledger',
          product: 'token-quota',
          periods: [{ label: '剩余 token', remainingPercent }],
        }
        next.remainingPercent = remainingPercent
        next.source = 'token-ledger'
        next.stale = true
        const site = account.siteUrl === undefined ? '' : `；以官网为准：${account.siteUrl}`
        next.note = `按「期初 ${formatTokens(allowance)} − 已用 ${formatTokens(used)} token」估算，未包含其他客户端用量${site}`
      } else {
        let probe
        try {
          probe = await quotaProbe(account, { resolveApiKey, fetchImpl, timeoutMs: config.probeTimeoutMs })
        } catch (error) {
          probe = { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
        }
        if (probe.kind === 'quota') {
          next.quota = {
            source: probe.source,
            product: probe.product,
            edition: probe.edition,
            periods: probe.periods,
          }
          next.remainingPercent = probe.remainingPercent
          next.source = probe.source
          next.stale = false
          next.lastProbeAt = startedAt
          next.note = ''
        } else {
          next.quota = null
          next.remainingPercent = null
          next.source = 'unavailable'
          next.note = `${describeNoQuota(account)}${probe.reason === undefined ? '' : `（${probe.reason}）`}`
        }
      }
    } else {
      next.checkedAt = startedAt
      next.remaining = null
      next.probedRemaining = null
      next.quota = null
      next.remainingPercent = null
      // Level 3a: nothing is queryable, but a starting balance plus the local
      // spend ledger still yields a usable (approximate) remaining amount.
      if (applySpendEstimate(account, next, startedAt)) {
        const site = account.siteUrl === undefined ? '' : `；以官网为准：${account.siteUrl}`
        next.note = `按「期初余额 − 本地累计花费」估算，未包含其他客户端用量${site}`
      } else {
        next.source = 'unavailable'
        next.note = describeNoQuota(account)
      }
    }

    next.status = resolveStatus(account, next, startedAt)
    states.set(account.id, next)
    await maybeAlert(account, previous, next)
  }

  /**
   * Refresh accounts whose last check is older than the routing freshness
   * window. The background loop calls this so a spent allowance is noticed
   * within seconds instead of one poll interval later.
   * @returns {Promise<void>}
   */
  function refreshStale() {
    if (accounts.length === 0) return Promise.resolve()
    if (staleRun !== undefined) return staleRun
    const at = now()
    const due = accounts.filter((account) => {
      const checked = states.get(account.id)?.checkedAt ?? 0
      return checked === 0 || at - checked >= config.routeFreshMs
    })
    if (due.length === 0) return Promise.resolve()
    staleRun = (async () => {
      for (const account of due) {
        try {
          await refreshAccount(account)
        } catch (error) {
          log('warn', `[quota-guard] 过期数据刷新失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().finally(() => {
      staleRun = undefined
    })
    return staleRun
  }

  /**
   * Render a token count compactly for notes and alerts.
   * @param {number} value - token count.
   * @returns {string}
   */
  function formatTokens(value) {
    const count = Math.max(0, Math.round(value))
    if (count >= 1e6) return `${(count / 1e6).toFixed(count % 1e6 === 0 ? 0 : 2)}M`
    if (count >= 1e4) return `${(count / 1e4).toFixed(1)} 万`
    return `${count}`
  }

  /**
   * Compose the level-3 note: nothing is queryable, check the console.
   * @param {object} account - normalized account.
   * @returns {string}
   */
  function describeNoQuota(account) {
    const site = account.siteUrl === undefined ? '' : `：${account.siteUrl}`
    return `无法获取余额与模型剩余额度，请前往官网查询${site}`
  }

  /**
   * Refresh every account once, coalescing concurrent callers.
   * @returns {Promise<void>} resolves when this cycle finished.
   */
  function refreshAll() {
    if (accounts.length === 0) return Promise.resolve()
    if (refreshing !== undefined) return refreshing
    const run = Promise.all(accounts.map((account) => refreshAccount(account)))
      // Spend the ledger accumulates between refreshes; writing it here keeps
      // the estimate stable across restarts.
      .then(() => persist(accounts, spendState(), { switchOrder }))
      .catch((error) => {
        log('warn', `[quota-guard] 余额刷新失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (refreshing === run) refreshing = undefined
      })
    refreshing = run
    return run
  }

  /**
   * Rewrite a route that belongs to an unhealthy account.
   *
   * When the owner's data is older than `routeFreshMs` the owner is re-probed
   * before the decision, so an allowance that just ran out still triggers the
   * failover on this request instead of waiting for the next poll.
   *
   * @param {{provider: string, model: string}} base - route the loop would use.
   * @returns {Promise<{provider: string, model: string} | undefined>} replacement route.
   */
  async function routeOverride(base) {
    if (!config.autoSwitch || accounts.length === 0) return undefined
    const owner = accountForRoute(accounts, base.provider, base.model)
    if (owner === undefined) return undefined

    let at = now()
    let ownerState = states.get(owner.id)
    if (ownerState !== undefined) {
      const age = at - ownerState.checkedAt
      if (ownerState.checkedAt === 0) {
        // Never probed yet: start the check but do not delay this request.
        void refreshAccount(owner)
      } else if (age >= config.routeFreshMs) {
        await refreshAccount(owner)
        ownerState = states.get(owner.id)
        at = now()
      }
    }

    const blocked = ownerState !== undefined
      && (ownerState.blockedUntil > at || ownerState.status === 'critical' || ownerState.status === 'exhausted')
    if (!blocked) {
      if (ownerState !== undefined && at - ownerState.checkedAt > config.intervalMs) void refreshAll()
      return undefined
    }

    let target = selectTarget(accounts, states, base, at, { switchOrder })
    // Middle tier: a platform with free allowances per model usually has more
    // models than the ones registered here. Try those before changing vendor.
    if (target === undefined || target.provider !== owner.provider) {
      const sibling = await autoSibling(owner)
      if (sibling !== undefined) target = sibling
    }
    if (target === undefined) {
      if (ownerState !== undefined && at - ownerState.checkedAt > config.intervalMs) void refreshAll()
      return undefined
    }

    const to = accounts.find((account) => account.id === target.id)
    const reason = ownerState?.status === 'exhausted' ? '额度耗尽' : '余额不足'
    const text = formatSwitchAlert(owner, base.model, to, target.model, reason)
    // deliver() logs the line itself; logging here as well doubles every switch.
    if (config.alert.onSwitch) void deliver(text)
    else log('warn', text)
    return { provider: target.provider, model: target.model }
  }

  /**
   * Mark an account exhausted after a provider quota failure.
   * @param {string} provider - route that failed.
   * @param {string} code - provider-neutral failure code.
   * @returns {boolean} whether another account can take over.
   */
  function onQuotaError(provider, code) {
    if (!config.switchOnQuotaError) return false
    const owner = accountForRoute(accounts, provider, '')
    if (owner === undefined) return false
    const at = now()
    const previous = states.get(owner.id) ?? initialState(owner)
    const nextState = {
      ...previous,
      status: 'exhausted',
      remaining: 0,
      source: 'provider-error',
      stale: false,
      checkedAt: at,
      blockedUntil: at + config.quotaCooldownMs,
      note: code,
    }
    states.set(owner.id, nextState)
    void deliver(formatBalanceAlert(owner, nextState, 'exhausted'))
    return selectTarget(accounts, states, { provider, model: '' }, at, { switchOrder }) !== undefined
  }

  /**
   * Record the route the foreground just asked for, so the Settings page can
   * show the model that is actually in use rather than every card alike.
   * @param {string | undefined} provider - route key.
   * @param {string | undefined} model - model id.
   * @returns {void}
   */
  function noteRoute(provider, model) {
    if (typeof provider !== 'string' || provider === '') return
    if (typeof model !== 'string' || model === '') return
    lastRoute = { provider, model, at: now() }
  }

  /**
   * Remember the outcome of a one-click switch so the page can explain a
   * foreground that did not follow.
   * @param {{provider: string, model: string, mode: string | null, reason: string}} entry - outcome.
   * @returns {void}
   */
  function noteSwitch(entry) {
    lastSwitch = { ...entry, at: now() }
  }

  /**
   * Account one assistant message's usage.
   * @param {string} provider - message source provider.
   * @param {string} model - message source model.
   * @param {object} sample - provider token accounting.
   * @returns {void}
   */
  function noteUsage(provider, model, sample) {
    const account = accountForRoute(accounts, provider, model)
    if (account === undefined) return
    const totals = { ...usageOf(account.id) }
    totals.input += Number(sample.inputTokens ?? 0) || 0
    totals.output += Number(sample.outputTokens ?? 0) || 0
    totals.cacheRead += Number(sample.cacheReadTokens ?? 0) || 0
    totals.cacheWrite += Number(sample.cacheWriteTokens ?? 0) || 0
    usage.set(account.id, totals)
    if (account.pricing === null) return

    // Price this one call from its own usage sample.
    //
    // `inputTokens` is already the uncached prompt size: the adapter computes
    // `prompt - cacheRead - cacheWrite` before handing usage to the harness, so
    // the cache buckets are billed separately and must not be subtracted again.
    const input = Number(sample.inputTokens ?? 0) || 0
    const output = Number(sample.outputTokens ?? 0) || 0
    const cacheRead = Number(sample.cacheReadTokens ?? 0) || 0
    const cacheWrite = Number(sample.cacheWriteTokens ?? 0) || 0
    const cost =
      (input / 1e6) * account.pricing.inputPerMTok +
      (cacheRead / 1e6) * account.pricing.cacheReadPerMTok +
      (cacheWrite / 1e6) * account.pricing.cacheWritePerMTok +
      (output / 1e6) * account.pricing.outputPerMTok

    const state = states.get(account.id)
    if (state === undefined) return
    state.spent = (state.spent ?? 0) + cost
    state.lastCost = cost
  }

  /**
   * Add or replace one account, then persist the whole list.
   * @param {unknown} raw - raw account fields.
   * @param {string} [path] - config path used in validation errors.
   * @returns {Promise<object>} normalized account.
   */
  async function upsertAccount(raw, path = 'account') {
    const account = normalizeAccount(raw, path)
    const index = accounts.findIndex((existing) => existing.id === account.id)
    const previous = index >= 0 ? accounts[index] : undefined
    accounts = index >= 0
      ? accounts.map((existing, position) => (position === index ? account : existing))
      : [...accounts, account]
    // Re-anchoring the starting balance restarts the ledger: the new figure is
    // the truth from this moment on, so spend counted against the old one goes.
    if (previous !== undefined && previous.balance.startAmount !== account.balance.startAmount) {
      const state = states.get(account.id)
      if (state !== undefined) {
        state.spent = 0
        state.lastCost = null
      }
    }
    // Same rule for a token allowance: a new starting figure means a fresh count.
    if (previous !== undefined && previous.quota.startTokens !== account.quota.startTokens) {
      usage.set(account.id, { ...EMPTY_USAGE })
    }
    if (!states.has(account.id)) states.set(account.id, initialState(account, savedSpend?.get(account.id)))
    await persist(accounts, spendState(), { switchOrder })
    void refreshAccount(account)
    return account
  }

  /**
   * Remove one account and forget its runtime state.
   * @param {string} id - account id.
   * @returns {Promise<boolean>} whether the account existed.
   */
  async function removeAccount(id) {
    const next = accounts.filter((account) => account.id !== id)
    if (next.length === accounts.length) return false
    accounts = next
    states.delete(id)
    usage.delete(id)
    spendAnchors.delete(id)
    alertMemory.delete(id)
    await persist(accounts, spendState(), { switchOrder })
    return true
  }

  /**
   * Change how the second-level failover orders its candidates.
   * @param {'auto' | 'manual'} value - ordering mode.
   * @returns {Promise<'auto' | 'manual'>} the stored mode.
   */
  async function setSwitchOrder(value) {
    if (value !== 'auto' && value !== 'manual') throw new Error('switchOrder 必须是 auto 或 manual')
    switchOrder = value
    await persist(accounts, spendState(), { switchOrder })
    return switchOrder
  }

  /**
   * Route the next request would be moved to, without probing anything. The
   * Settings page uses this to explain why the foreground still shows the
   * exhausted model: the switch happens at request time, not in the picker.
   * @returns {{provider: string, model: string} | null}
   */
  function previewSwitch() {
    if (!config.autoSwitch || lastRoute === undefined) return null
    const target = selectTarget(
      accounts,
      states,
      { provider: lastRoute.provider, model: lastRoute.model },
      now(),
      { switchOrder },
    )
    return target === undefined ? null : { provider: target.provider, model: target.model }
  }

  /**
   * Build the browser-facing snapshot.
   * @returns {object} JSON-compatible status document.
   */
  function snapshot() {
    const at = now()
    return {
      accounts: accounts.map((account) => {
        const state = states.get(account.id) ?? initialState(account)
        const serialized = serializeAccount(account)
        // `quota` feeds both the `/quota` table and the settings page: they need
        // the probe payload (periods, source) *and* the configured thresholds
        // (warnPercent, criticalPercent), so keep the thresholds instead of
        // letting the probe result replace the whole object.
        const quota = serialized.quota === undefined
          ? (state.quota ?? null)
          : { ...serialized.quota, ...(state.quota ?? {}) }
        return {
          ...serialized,
          status: state.status,
          remaining: state.remaining,
          remainingPercent: state.remainingPercent,
          quota,
          currency: state.currency ?? account.currency ?? null,
          spent: state.spent ?? 0,
          lastCost: state.lastCost ?? null,
          source: state.source,
          stale: state.stale === true,
          checkedAt: state.checkedAt,
          lastProbeAt: state.lastProbeAt,
          note: state.note ?? '',
          siteUrl: account.siteUrl ?? '',
        }
      }),
      autoSwitch: config.autoSwitch,
      switchOnQuotaError: config.switchOnQuotaError,
      switchOrder,
      alert: {
        webhookUrl: config.alert.webhookUrl ?? '',
        format: config.alert.format,
        onSwitch: config.alert.onSwitch,
      },
      storePath: storePath ?? '',
      refreshedAt: at,
      current: lastRoute === undefined ? null : { provider: lastRoute.provider, model: lastRoute.model, at: lastRoute.at },
      pendingSwitch: previewSwitch(),
      lastSwitch: lastSwitch ?? null,
    }
  }

  return {
    accounts: () => accounts,
    stateOf: (id) => states.get(id),
    snapshot,
    refreshAll,
    refreshStale,
    routeOverride,
    onQuotaError,
    noteUsage,
    noteRoute,
    noteSwitch,
    upsertAccount,
    removeAccount,
    setSwitchOrder,
    adoptModel,
    recommendations,
  }
}
