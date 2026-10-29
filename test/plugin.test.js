import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

/**
 * Minimal Cordis-shaped host for exercising the plugin without the harness.
 * @param {object} config - plugin config.
 * @param {{fetch?: typeof fetch, now?: () => number}} internals - test seams.
 * @returns {object} harness handles.
 */
function createHarness(config, internals = {}) {
  const listeners = new Map()
  const commands = new Map()
  const warnings = []

  const ctx = {
    logger: {
      info() {},
      warn(text) { warnings.push(text) },
      error() {},
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    effect(body) {
      const disposer = body()
      return () => {
        if (typeof disposer === 'function') void disposer()
      }
    },
    interval() { return () => {} },
    timeout() { return () => {} },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    get(name) {
      return name === 'credentials' ? { resolve: async () => ({ value: 'test-key' }) } : undefined
    },
  }

  apply(ctx, config, {
    store: {},
    persist: async () => {},
    ...internals,
  })

  /**
   * Dispatch one event to the plugin listener.
   * @param {string} name - event name.
   * @param {...unknown} args - exact listener arguments.
   * @returns {Promise<unknown>}
   */
  async function fire(name, ...args) {
    const [listener] = listeners.get(name) ?? []
    assert.ok(listener, `no listener for ${name}`)
    return listener(...args)
  }

  return { warnings, commands, fire }
}

/**
 * Build a JSON response stub.
 * @param {unknown} payload - JSON body.
 * @returns {object}
 */
function response(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

const TWO_ACCOUNTS = {
  accounts: [
    {
      id: 'deepseek',
      label: 'DeepSeek 官方',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      priority: 10,
      warnBelow: 10,
      criticalBelow: 2,
      balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    },
    {
      id: 'kimi',
      label: 'Kimi',
      provider: 'moonshotai-cn',
      model: 'kimi-k2',
      priority: 20,
      warnBelow: 5,
      criticalBelow: 1,
      balance: { kind: 'moonshot', apiKeyEnv: 'MOONSHOT_API_KEY' },
    },
  ],
}

test('QUOTA_EXCEEDED blocks the account and the next request is re-routed', async () => {
  const fetch = async () => response({ data: { available_balance: 4.8 } })
  const harness = createHarness(TWO_ACCOUNTS, { fetch, now: () => 1000 })

  const action = await harness.fire('agent/request-error', {
    provider: 'deepseek-official',
    failure: { code: 'QUOTA_EXCEEDED' },
    signal: { aborted: false },
  }, async () => undefined)
  assert.deepEqual(action, { kind: 'retry' })

  const base = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    maxTokens: 8192,
    temperature: 0.3,
  }
  const routed = await harness.fire('agent/request', { signal: { aborted: false } }, async () => base)
  assert.equal(routed.provider, 'moonshotai-cn')
  assert.equal(routed.model, 'kimi-k2')
  assert.equal(routed.temperature, 0.3)
  assert.equal('reasoningEffort' in routed, false)
  assert.equal('maxTokens' in routed, false)
  assert.ok(harness.warnings.some((line) => line.includes('额度耗尽')))
  // deliver() logs the switch line itself, so a single failover must not log twice.
  assert.equal(harness.warnings.filter((line) => line.includes('已自动切换')).length, 1)
})

test('a quota failure without another account stays terminal', async () => {
  const config = {
    accounts: [{
      id: 'deepseek',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    }],
  }
  const harness = createHarness(config, {
    fetch: async () => response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '50' }] }),
    now: () => 1000,
  })

  const action = await harness.fire('agent/request-error', {
    provider: 'deepseek-official',
    failure: { code: 'QUOTA_EXCEEDED' },
    signal: { aborted: false },
  }, async () => undefined)
  assert.equal(action, undefined)

  const base = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  assert.deepEqual(await harness.fire('agent/request', { signal: { aborted: false } }, async () => base), base)
})

test('non-quota failures are delegated untouched', async () => {
  const harness = createHarness(TWO_ACCOUNTS, {
    fetch: async () => response({ data: { available_balance: 4.8 } }),
    now: () => 1000,
  })
  const action = await harness.fire('agent/request-error', {
    provider: 'deepseek-official',
    failure: { code: 'RATE_LIMIT' },
    signal: { aborted: false },
  }, async () => ({ kind: 'retry' }))
  assert.deepEqual(action, { kind: 'retry' })
})

test('a failing probe degrades to a priced usage estimate', async () => {
  let healthy = true
  const fetch = async (url) => {
    if (url.startsWith('https://api.deepseek.com')) {
      if (!healthy) throw new Error('network down')
      return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] })
    }
    throw new Error(`unexpected ${url}`)
  }
  const harness = createHarness({
    accounts: [{
      id: 'deepseek',
      label: 'DeepSeek 官方',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      warnBelow: 3,
      criticalBelow: 1,
      balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    }],
    alert: { minIntervalMs: 0 },
  }, { fetch, now: () => 1000 })

  const quota = harness.commands.get('quota')
  const first = await quota.handler({})
  assert.equal(first.kind, 'success')
  assert.match(first.text, /¥10\.00/)

  await harness.fire('session/event', {}, {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 0, outputTokens: 1_000_000 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    },
  })

  healthy = false
  const second = await quota.handler({})
  assert.equal(second.kind, 'success')
  assert.match(second.text, /¥8\.00/)
  assert.match(second.text, /network down/)
})

test('crossing the warn threshold posts one webhook alert', async () => {
  const balances = [
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '50.00' }] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] },
  ]
  const posts = []
  const fetch = async (url, init) => {
    if (url.startsWith('https://api.deepseek.com')) return response(balances.shift())
    posts.push(JSON.parse(init.body))
    return response({})
  }
  const harness = createHarness({
    accounts: [{
      id: 'deepseek',
      label: 'DeepSeek 官方',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      warnBelow: 10,
      criticalBelow: 2,
      balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    }],
    alert: {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      format: 'feishu',
      minIntervalMs: 0,
    },
  }, { fetch, now: () => 1000 })

  const quota = harness.commands.get('quota')
  await quota.handler({})
  await quota.handler({})
  await quota.handler({})

  assert.equal(posts.length, 1)
  assert.equal(posts[0].msg_type, 'text')
  assert.match(posts[0].content.text, /余额预警/)
})

test('/quota renders every configured account', async () => {
  const harness = createHarness(TWO_ACCOUNTS, {
    fetch: async (url) => (url.startsWith('https://api.deepseek.com')
      ? response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.80' }] })
      : response({ data: { available_balance: 4.2 } })),
    now: () => 1000,
  })
  const result = await harness.commands.get('quota').handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /DeepSeek 官方/)
  assert.match(result.text, /Kimi/)
  assert.match(result.text, /deepseek-official\/deepseek-v4-flash/)
  assert.match(result.text, /moonshotai-cn\/kimi-k2/)
})
