/**
 * quota-guard: multi-provider quota monitor, alerting, automatic model
 * failover, and a Settings-page control surface for DeepSeek Harness.
 *
 * Host side only — no prompt text, tools, or messages are added. The browser
 * half ships through `exports["./client"]` and talks to this plugin over the
 * five routes registered below.
 *
 * @module dsh-plugin-quota-guard
 */

import { normalizeConfig, serializeAccount } from './config.js'
import { createController } from './controller.js'
import { createApi } from './api.js'
import { createRoutes } from './routes.js'
import { detectCli, installCli, queryFreeQuota } from './bailian.js'
import { defaultStorePath, readStoreSync, writeStore } from './store.js'
import { formatStatusTable } from './alerts.js'

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'quota-guard'

/** `timer` drives refresh; `commands` owns `/quota`. `webServer` is optional. */
export const inject = ['timer', 'commands']

/**
 * Install monitoring, failover, and the web control surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - loader row config.
 * @param {object} [internals] - test seams (`fetch`, `now`, `store`, `storePath`, `persist`).
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}, internals = {}) {
  const baseConfig = normalizeConfig(rawConfig)
  const storePath = internals.storePath ?? defaultStorePath()
  const fetchImpl = internals.fetch ?? globalThis.fetch
  const now = internals.now ?? (() => Date.now())
  /** Most recent Session that produced an event, used for one-click switches. */
  let lastSessionId
  /** Route of the most recent request, used to find the right Session again. */
  let lastRequestRoute

  /**
   * Write one line through the Cordis logger, falling back to the console.
   * @param {'info' | 'warn' | 'error'} level - severity.
   * @param {string} text - message.
   * @returns {void}
   */
  function log(level, text) {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](text)
    else if (level !== 'info') console.warn(text)
  }

  const stored = internals.store !== undefined ? internals.store : readStoreSync(storePath, (text) => log('warn', text))
  const entries = stored !== null && stored !== undefined && Array.isArray(stored.accounts)
    ? stored.accounts
    : baseConfig.accounts

  // Spend restored from the previous run: accounts without a queryable balance
  // estimate their remaining amount from this ledger.
  const spend = stored !== null && stored !== undefined && stored.spend !== null && typeof stored.spend === 'object'
    ? stored.spend
    : {}
  const savedSpend = new Map(Object.entries(spend).filter(([, value]) => value !== null && typeof value === 'object'))

  // The Settings page stores its ordering choice with the accounts, so a UI
  // change survives a restart without rewriting the patch layer.
  const switchOrder = stored?.switchOrder === 'manual' ? 'manual' : baseConfig.switchOrder

  /**
   * Persist the account list, the spend ledger, and the switch-order mode for
   * the next boot.
   * @param {object[]} accounts - normalized accounts.
   * @param {Record<string, {spent: number, lastCost: number | null}>} [spent] - spend per account id.
   * @param {{switchOrder?: 'auto' | 'manual'}} [settings] - runtime preferences.
   * @returns {Promise<void>}
   */
  async function persist(accounts, spent = {}, settings = {}) {
    if (internals.persist !== undefined) {
      await internals.persist(accounts, spent, settings)
      return
    }
    await writeStore(storePath, {
      version: 2,
      accounts: accounts.map(serializeAccount),
      spend: spent,
      switchOrder: settings.switchOrder ?? baseConfig.switchOrder,
    })
  }

  /**
   * Resolve a credential reference per operation, exactly like the adapters.
   * @param {string} ref - credential reference such as `DEEPSEEK_API_KEY`.
   * @returns {Promise<string | undefined>} the secret, or undefined.
   */
  async function resolveApiKey(ref) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return process.env[ref]
    const hit = await credentials.resolve(ref)
    return hit?.value
  }

  /**
   * Models the host's route can actually call, without touching the network.
   * Used to find same-platform siblings that are not monitored yet.
   * @param {string} provider - provider id.
   * @returns {Promise<string[]>} model ids.
   */
  async function providerModels(provider) {
    const llm = ctx.get('llm')
    if (llm === undefined) return []
    try {
      const listed = await llm.listModels?.(provider)
      if (!Array.isArray(listed)) return []
      return [...new Set(listed
        .map((item) => (typeof item === 'string' ? item : item?.id))
        .filter((id) => typeof id === 'string' && id !== ''))]
    } catch {
      return []
    }
  }

  const controller = createController({
    config: baseConfig,
    entries,
    fetchImpl,
    now,
    log,
    resolveApiKey,
    persist,
    storePath,
    savedSpend,
    switchOrder,
    providerModels,
  })

  /**
   * Replace the foreground Session's model (and the saved default) so the dsh
   * picker follows an explicit one-click switch.
   * @param {string} provider - provider id.
   * @param {string} model - model id.
   * @returns {Promise<{mode: 'session' | 'default' | undefined, reason: string}>} outcome.
   */
  async function switchForeground(provider, model) {
    /**
     * Save the deployment default, used when the live Session cannot be reached.
     * @param {string} reason - why the Session path was unavailable.
     * @returns {Promise<{mode: 'default' | undefined, reason: string}>}
     */
    async function saveDefault(reason) {
      const defaults = ctx.get('agentDefaultModel')
      if (defaults === undefined || typeof defaults.saveSelection !== 'function') {
        return { mode: undefined, reason }
      }
      try {
        await defaults.saveSelection({ provider, model })
        return { mode: 'default', reason }
      } catch (error) {
        return { mode: undefined, reason: `${reason}；默认模型保存失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (lastSessionId === undefined) {
      // A fresh process may not have served a request yet. With exactly one live
      // Session there is no ambiguity, so adopt it instead of only saving a default.
      const store = ctx.get('sessions')
      const live = typeof store?.list === 'function' ? store.list() : []
      if (live.length === 1 && typeof live[0]?.id === 'string') lastSessionId = live[0].id
    }
    if (lastSessionId === undefined && lastRequestRoute === undefined) {
      return saveDefault('尚未捕获到当前会话')
    }
    const sessions = ctx.get('sessionController')
    if (sessions === undefined || typeof sessions.selectModel !== 'function') {
      return saveDefault('当前部署未挂载 sessionController')
    }

    // Candidates: live Sessions that were using the same route (largest log
    // first, which is the visible conversation), then the last requesting Agent.
    const candidates = []
    if (lastRequestRoute !== undefined) {
      const store = ctx.get('sessions')
      const live = typeof store?.list === 'function' ? store.list() : []
      const matching = live
        .filter((session) => typeof session?.id === 'string')
        .filter((session) => {
          try {
            const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
            return header?.config?.provider === lastRequestRoute.provider
              && header?.config?.model === lastRequestRoute.model
          } catch {
            return false
          }
        })
        .sort((left, right) => (right.events?.length ?? 0) - (left.events?.length ?? 0))
      for (const session of matching) candidates.push(session.id)
    }
    if (lastSessionId !== undefined && !candidates.includes(lastSessionId)) candidates.push(lastSessionId)

    let reason = '尚未捕获到当前会话'
    for (const sessionId of candidates) {
      try {
        await sessions.selectModel({ sessionId, provider, model })
        lastSessionId = sessionId
        return { mode: 'session', reason: '' }
      } catch (error) {
        reason = `会话 ${sessionId}：${error instanceof Error ? error.message : String(error)}`
        log('warn', `[quota-guard] 切换会话 ${sessionId} 的模型失败：${reason}`)
      }
    }
    return saveDefault(reason)
  }

  /**
   * Make sure the local tools the account list depends on are present.
   *
   * The Bailian allowance is only readable through its CLI, so a user who adds
   * a Bailian account should not have to discover the missing binary through an
   * error message. Installation runs at most once per process and never blocks
   * startup.
   *
   * @returns {Promise<{ok: boolean, detail: string, needsLogin?: boolean, installed?: boolean}>} outcome.
   */
  async function prepareCli() {
    if (internals.prepareCli !== undefined) return internals.prepareCli()
    const needs = controller.accounts().some((account) => account.quota?.kind === 'bailian-free')
    if (!needs) return { ok: true, detail: '当前账户不需要百炼 CLI' }
    const detected = await detectCli()
    if (detected.ok) return { ok: true, detail: `bl 已安装${detected.version === '' ? '' : `（${detected.version}）`}` }
    if (!baseConfig.autoInstallCli) return { ok: false, detail: detected.reason }
    log('info', '[quota-guard] 未检测到 bl CLI，开始自动安装 bailian-cli…')
    let installed = await installCli()
    if (!installed.ok) {
      // npm may report a cleanup failure (EBUSY/EPERM) even when the binary
      // landed; trust the binary first.
      const visible = await detectCli()
      if (visible.ok) {
        return { ok: true, detail: `已安装 bl（${visible.version}），npm 报告了清理警告`, installed: true }
      }
      // A previous uninstall can leave a locked directory behind; retry once.
      if (/EBUSY|EPERM|ENOTEMPTY|resource busy|operation not permitted/i.test(installed.reason)) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        installed = await installCli()
      }
      if (!installed.ok) return { ok: false, detail: installed.reason }
    }
    const after = await detectCli()
    if (!after.ok) return { ok: false, detail: after.reason }
    // A fresh install has no login state; ask once with the CLI so the page can
    // pop the login prompt immediately instead of after the next poll.
    const probe = await queryFreeQuota({})
    if (probe.ok) return { ok: true, detail: '已自动安装 bailian-cli', installed: true }
    return {
      ok: true,
      detail: '已自动安装 bailian-cli，还需要登录',
      installed: true,
      needsLogin: /未登录|authenticated/i.test(probe.reason),
    }
  }

  const api = createApi({ ctx, controller, log, fetchImpl, switchForeground, prepareCli })

  log('info', controller.accounts().length === 0
    ? '[quota-guard] 已启用，但未配置 accounts：可在设置页「模型额度」里添加。'
    : `[quota-guard] 已启用：监控 ${controller.accounts().map((account) => account.label).join('、')}（自动切换${baseConfig.autoSwitch ? '开' : '关'}）。`)

  // --- token accounting: the estimation fallback needs spend per account -----

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const sample = event.data?.usage
    if (sample === undefined || sample === null) return
    const source = event.data.message?.source
    controller.noteUsage(source?.provider, source?.model, sample)
  })

  // --- routing: rewrite the frozen call config before the loop prepares it ---

  ctx.on('agent/request', async (payload, next) => {
    // The payload owns the exact Agent, so this is the reliable identity for a
    // one-click foreground switch (session/event also fires for other sessions).
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId === 'string') lastSessionId = sessionId
    const base = await next()
    if (payload?.signal?.aborted) return base
    const override = await controller.routeOverride(base)
    const actual = override === undefined ? base : override
    if (typeof actual?.provider === 'string' && typeof actual?.model === 'string') {
      lastRequestRoute = { provider: actual.provider, model: actual.model }
    }
    // Record the route the call really uses, so the Settings page shows the
    // switched provider instead of the one the user originally picked.
    controller.noteRoute(actual?.provider, actual?.model)
    if (override === undefined) return base
    // A different route invalidates output limits and reasoning identifiers,
    // so let the target adapter fill its own defaults.
    const { provider: _provider, model: _model, reasoningEffort: _effort, maxTokens: _maxTokens, ...rest } = base
    return { ...rest, provider: override.provider, model: override.model }
  })

  // --- failure recovery: one retry onto a healthy account --------------------

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload?.signal?.aborted) return next()
    const code = payload?.failure?.code
    if (typeof code !== 'string' || !baseConfig.quotaErrorCodes.includes(code)) return next()
    return controller.onQuotaError(payload.provider, code) ? { kind: 'retry' } : next()
  })

  // --- periodic work ---------------------------------------------------------

  ctx.effect(() => ctx.interval(() => {
    void controller.refreshAll()
  }, baseConfig.intervalMs), 'quota-guard: balance refresh interval')

  // Keep routing data fresh between the slow full polls: an allowance that just
  // ran out must be visible within seconds, not one interval later.
  ctx.effect(() => ctx.interval(() => {
    void controller.refreshStale()
  }, Math.max(5000, Math.floor(baseConfig.routeFreshMs / 2))), 'quota-guard: stale-data refresh interval')

  if (controller.accounts().length > 0) {
    ctx.effect(() => ctx.timeout(() => {
      void controller.refreshAll()
    }, 2000), 'quota-guard: initial balance refresh')

    // Auto-install the local tools the account list depends on (Bailian CLI).
    ctx.effect(() => ctx.timeout(() => {
      void prepareCli().then((result) => {
        if (!result.ok) {
          log('warn', `[quota-guard] 环境准备失败：${result.detail}`)
          return
        }
        // A fresh install changes the CLI state, so re-read the allowances to
        // surface the login prompt (or the first real numbers) right away.
        if (result.installed === true) {
          controller.resetQuotaCache()
          void controller.refreshAll()
        }
      })
    }, 4000), 'quota-guard: local tool setup')
  }

  ctx.effect(() => ctx.commands.register({
    name: 'quota',
    description: '查看各平台模型额度与自动切换状态',
    handler: async () => {
      try {
        await controller.refreshAll()
        return { kind: 'success', text: formatStatusTable(controller.snapshot(), now()) }
      } catch (error) {
        return { kind: 'error', text: `quota-guard: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'quota-guard: /quota command')

  // --- browser surface: routes are optional, the monitor is not ---------------

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (uiCtx) => {
      uiCtx.effect(() => {
        const disposers = createRoutes(api).map((route) => uiCtx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, 'quota-guard: web routes')
    })
  }
}
