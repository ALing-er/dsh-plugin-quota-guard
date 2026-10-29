import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { createController } from '../lib/controller.js'
import { createApi, credentialRefFor } from '../lib/api.js'

/**
 * Build an API instance over a real controller with in-memory persistence.
 * @param {object} [options] - service fakes.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const calls = []
  const persisted = []
  const ctx = {
    get(name) {
      if (name === 'settings') return options.settings
      if (name === 'credentials') return options.credentials
      if (name === 'agentDefaultModel') return options.defaults
      if (name === 'llm') {
        return {
          listProviders: () => options.providers ?? [],
          listConfigurableProviders: () => options.configurable ?? [],
          listModelDiscoveryNamespaces: () => options.namespaces ?? [],
          ...(options.listModels === undefined ? {} : { listModels: options.listModels }),
          ...(options.discover === undefined ? {} : { discoverModels: options.discover }),
        }
      }
      return undefined
    },
  }
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [],
    fetchImpl: async () => {
      throw new Error('tests never reach the network')
    },
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async (accounts) => {
      persisted.push(accounts.map((account) => account.id))
    },
    storePath: 'C:/tmp/quota-guard.json',
    // Same seam for the controller: tests never shell out to the CLI.
    freeQuotaProbe: options.freeQuota ?? (async () => ({ ok: false, reason: 'not in tests' })),
  })
  const api = createApi({
    ctx,
    controller,
    log: (...parts) => calls.push(parts),
    fetchImpl: options.fetch,
    // Tests never shell out to the Bailian CLI unless they ask for it.
    freeQuotaProbe: options.freeQuota ?? (async () => ({ ok: false, reason: 'not in tests' })),
    switchForeground: options.switchForeground,
    prepareCli: options.prepareCli,
  })
  return { api, calls, persisted, controller }
}

test('saveAccount adds an account and persists the full list', async () => {
  const harness = createHarness()
  const snapshot = await harness.api.saveAccount({
    id: 'deepseek',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  })
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].status, 'unknown')
  assert.equal(snapshot.accounts[0].balance.kind, 'deepseek')
  assert.deepEqual(harness.persisted.at(-1), ['deepseek'])
})

test('saveAccount stores the Alibaba Cloud AccessKey pair', async () => {
  const stored = []
  const harness = createHarness({
    credentials: { set: async (ref, value) => { stored.push({ ref, value }) } },
  })
  await harness.api.saveAccount({
    id: 'dashscope-qwen-plus',
    provider: 'dashscope',
    model: 'qwen-plus',
    balance: {
      kind: 'aliyun',
      accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID',
      accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET',
    },
    accessKey: 'LTAI-test',
    accessKeySecret: 'secret-value',
  })
  assert.deepEqual(stored, [
    { ref: 'ALIYUN_ACCESS_KEY_ID', value: 'LTAI-test' },
    { ref: 'ALIYUN_ACCESS_KEY_SECRET', value: 'secret-value' },
  ])
})

test('saveAccount rejects an invalid balance spec', async () => {
  const harness = createHarness()
  await assert.rejects(
    harness.api.saveAccount({ id: 'x', provider: 'p', model: 'm', balance: { kind: 'http' } }),
    /jsonPath|url/,
  )
})

test('deleteAccount removes an account and reports unknown ids', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({ id: 'kimi', provider: 'moonshotai-cn', model: 'kimi-k2', balance: { kind: 'moonshot' } })
  const snapshot = await harness.api.deleteAccount({ id: 'kimi' })
  assert.equal(snapshot.accounts.length, 0)
  await assert.rejects(harness.api.deleteAccount({ id: 'kimi' }), /不存在/)
})

test('setSwitchOrder validates and stores the mode', async () => {
  const harness = createHarness()
  const snapshot = await harness.api.setSwitchOrder({ switchOrder: 'manual' })
  assert.equal(snapshot.switchOrder, 'manual')
  await assert.rejects(harness.api.setSwitchOrder({ switchOrder: 'sideways' }), /switchOrder/)
})

test('reorderAccount moves one account a slot in the manual order', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({ id: 'a', provider: 'p', model: 'm-a', warnBelow: 10, criticalBelow: 2, balance: { kind: 'none' } })
  await harness.api.saveAccount({ id: 'b', provider: 'p', model: 'm-b', warnBelow: 10, criticalBelow: 2, balance: { kind: 'none' } })
  const snapshot = await harness.api.reorderAccount({ id: 'b', direction: 'up' })
  assert.deepEqual(
    Object.fromEntries(snapshot.accounts.map((account) => [account.id, account.priority])),
    { a: 20, b: 10 },
  )
  await assert.rejects(harness.api.reorderAccount({ id: 'missing', direction: 'up' }), /不存在/)
})

test('switchModel adopts the model and switches the foreground', async () => {
  const calls = []
  const harness = createHarness({
    switchForeground: async (provider, model) => { calls.push([provider, model]); return { mode: 'session', reason: '' } },
  })
  await harness.api.saveAccount({
    id: 'dashscope-pro',
    provider: 'dashscope',
    model: 'deepseek-v4-pro-0813',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  const snapshot = await harness.api.switchModel({ provider: 'dashscope', model: 'qwen3.8-27b' })
  assert.deepEqual(calls, [['dashscope', 'qwen3.8-27b']])
  assert.equal(snapshot.switched, 'session')
  assert.equal(snapshot.switchError, '')
  assert.deepEqual(snapshot.current, { provider: 'dashscope', model: 'qwen3.8-27b', at: 1000 })
  assert.ok(snapshot.accounts.some((account) => account.model === 'qwen3.8-27b'))
  await assert.rejects(
    harness.api.switchModel({ provider: 'unknown', model: 'm' }),
    /路由/,
  )
})

test('saveAccount stores the platform API key once', async () => {
  const stored = []
  const writes = []
  const harness = createHarness({
    credentials: { set: async (ref, value) => { stored.push({ ref, value }) } },
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions' } } } }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({
    id: 'dashscope-pro',
    provider: 'dashscope',
    model: 'deepseek-v4-pro-0813',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
    apiKey: 'sk-test-123',
  })
  assert.deepEqual(stored, [{ ref: 'DASHSCOPE_API_KEY', value: 'sk-test-123' }])
  assert.deepEqual(writes, [
    // The model must be callable before the account points at it.
    {
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'dashscope', 'models'], value: [{ id: 'deepseek-v4-pro-0813' }] }],
    },
    // The route has no declared reference yet, so the plugin declares one.
    {
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'dashscope', 'apiKeyEnv'], value: 'DASHSCOPE_API_KEY' }],
    },
  ])
})

test('clearProvider removes every model of one platform', async () => {
  const writes = []
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions' } } } }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({ id: 'a', provider: 'dashscope', model: 'm-a', warnBelow: 10, criticalBelow: 2, balance: { kind: 'none' } })
  await harness.api.saveAccount({ id: 'b', provider: 'dashscope', model: 'm-b', warnBelow: 10, criticalBelow: 2, balance: { kind: 'none' } })
  await harness.api.saveAccount({ id: 'c', provider: 'ant-ling', model: 'm-c', warnBelow: 10, criticalBelow: 2, balance: { kind: 'none' } })
  const snapshot = await harness.api.clearProvider({ provider: 'dashscope' })
  assert.deepEqual(snapshot.accounts.map((account) => account.id), ['c'])
  assert.deepEqual(writes.at(-1), { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'dashscope'] }] })
})

test('saveAccount appends a new model to the platform route', async () => {
  const writes = []
  const harness = createHarness({
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: {
          providers: {
            dashscope: {
              baseURL: 'https://ds.example/v1',
              api: 'openai-completions',
              models: [{ id: 'qwen-plus', name: 'Qwen Plus' }],
            },
          },
        },
      }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({
    id: 'dashscope-qwen3-8-flash',
    provider: 'dashscope',
    model: 'qwen3.8-flash',
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  assert.deepEqual(writes, [{
    ns: 'llm-pi-ai',
    ops: [{
      op: 'set',
      path: ['providers', 'dashscope', 'models'],
      value: [{ id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen3.8-flash' }],
    }],
  }])
})

test('syncRouteModels makes already-registered accounts callable', async () => {
  const writes = []
  const profile = { baseURL: 'https://ds.example/v1', api: 'openai-completions', models: [{ id: 'qwen-plus' }] }
  const harness = createHarness({
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { dashscope: profile } } }],
      mutate: async (ns, ops) => {
        writes.push({ ns, ops })
        const value = ops[0]?.value
        if (Array.isArray(value)) profile.models = value
      },
    },
  })
  // An account saved by a build that never touched the route catalog.
  await harness.api.saveAccount({ id: 'f', provider: 'dashscope', model: 'qwen3.8-flash', balance: { kind: 'none' } })
  assert.deepEqual(profile.models.map((model) => model.id), ['qwen-plus', 'qwen3.8-flash'])
  // A second pass finds nothing missing and writes nothing.
  const before = writes.length
  await harness.api.syncRouteModels()
  assert.equal(writes.length, before)
})

test('a profile that is not pi-ai shaped is never rewritten', async () => {
  const writes = []
  const harness = createHarness({
    configurable: [{ provider: 'ant-ling', settingsNs: 'llm-ant-ling', settingsPath: [] }],
    settings: {
      describe: () => [{ ns: 'llm-ant-ling', value: { apiKeyEnv: 'ANT_LING_API_KEY' } }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({ id: 'ant', provider: 'ant-ling', model: 'ling-mini', balance: { kind: 'none' } })
  assert.deepEqual(writes, [])
})

test('setupCli delegates to the local tool installer', async () => {
  const harness = createHarness({ prepareCli: async () => ({ ok: true, detail: 'bl 已安装（2.6.2）' }) })
  assert.deepEqual(await harness.api.setupCli(), { ok: true, detail: 'bl 已安装（2.6.2）' })
})

test('adding a Bailian account asks for the CLI installer once', async () => {
  let calls = 0
  const harness = createHarness({
    prepareCli: async () => {
      calls += 1
      return { ok: true, detail: 'bl 已安装' }
    },
  })
  await harness.api.saveAccount({
    id: 'bailian-a',
    provider: 'dashscope',
    model: 'qwen-plus',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  await harness.api.saveAccount({
    id: 'bailian-b',
    provider: 'dashscope',
    model: 'qwen-max',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 1)
})

test('a failed foreground switch does not claim the route', async () => {
  const harness = createHarness({
    switchForeground: async () => ({ mode: 'default', reason: 'session not found' }),
  })
  await harness.api.saveAccount({
    id: 'dashscope-pro',
    provider: 'dashscope',
    model: 'deepseek-v4-pro-0813',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  const snapshot = await harness.api.switchModel({ provider: 'dashscope', model: 'qwen3.8-27b' })
  assert.equal(snapshot.switched, 'default')
  assert.equal(snapshot.switchError, 'session not found')
  // The page must keep showing the picker's real route, not the attempted one.
  assert.equal(snapshot.current, null)
  assert.equal(snapshot.lastSwitch.reason, 'session not found')
})

test('recommendations are advisory and never mutate the account list', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({
    id: 'dashscope-pro',
    provider: 'dashscope',
    model: 'deepseek-v4-pro-0813',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  // This harness has no route catalog, so the operation answers with an empty list.
  assert.deepEqual(await harness.api.recommendations({ provider: 'dashscope' }), { models: [] })
  assert.equal(harness.controller.accounts().length, 1)
})

test('recommendations include allowance models the route has not declared', async () => {
  const harness = createHarness({
    freeQuota: async () => ({
      ok: true,
      models: [
        { model: 'qwen3.8-flash', type: 'Text', hasQuota: true, remaining: 947461, total: 1000000, remainingPercent: 94.7 },
        { model: 'kimi-k3', type: 'Text', hasQuota: true, remaining: 999507, total: 1000000, remainingPercent: 100 },
        { model: 'qwen3-asr-flash', type: 'Audio', hasQuota: true, remaining: 35969, total: 36000, remainingPercent: 99.9 },
      ],
    }),
  })
  await harness.api.saveAccount({
    id: 'dashscope-plus',
    provider: 'dashscope',
    model: 'qwen-plus',
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free' },
  })
  const result = await harness.api.recommendations({ provider: 'dashscope' })
  assert.deepEqual(result.models.map((row) => row.model), ['kimi-k3', 'qwen3.8-flash'])
  // Advisory only: nothing was adopted behind the user's back.
  assert.equal(harness.controller.accounts().length, 1)
})

test('a brand-new Bailian route discovers models from its allowance', async () => {
  const harness = createHarness({
    listModels: async () => [],
    freeQuota: async () => ({
      ok: true,
      models: [
        { model: 'qwen-plus', type: 'Text', hasQuota: true, remaining: 0, total: 1000000, remainingPercent: 0 },
        { model: 'qwen3.8-flash', type: 'Text', hasQuota: true, remaining: 947461, total: 1000000, remainingPercent: 94.7 },
        { model: 'qwen3-asr-flash', type: 'Audio', hasQuota: true, remaining: 35969, total: 36000, remainingPercent: 99.9 },
      ],
    }),
  })
  // No route exists yet, so the CLI list is the only catalog available.
  const result = await harness.api.discoverModels({ provider: 'dashscope' })
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-plus', 'qwen3.8-flash'])
})

test('a Bailian route also offers allowance models it has not declared', async () => {
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: {
          providers: {
            dashscope: {
              baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              api: 'openai-completions',
              models: [{ id: 'qwen-plus' }],
            },
          },
        },
      }],
    },
    listModels: async () => [{ id: 'qwen-plus' }],
    freeQuota: async () => ({
      ok: true,
      models: [
        { model: 'qwen-plus', type: 'Text', hasQuota: true, remaining: 0, total: 1000000, remainingPercent: 0 },
        { model: 'qwen3.8-flash', type: 'Text', hasQuota: true, remaining: 947461, total: 1000000, remainingPercent: 94.7 },
        { model: 'qwen3-asr-flash', type: 'Audio', hasQuota: true, remaining: 35969, total: 36000, remainingPercent: 99.9 },
        { model: 'expired-model', type: 'Text', hasQuota: false, remaining: 0, total: 0, remainingPercent: 0 },
      ],
    }),
  })
  const result = await harness.api.discoverModels({ provider: 'dashscope' })
  // Chat models with allowance are offered; audio rows and spent models are not.
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-plus', 'qwen3.8-flash'])
})

test('removing the last account of a route releases the provider', async () => {
  const writes = []
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions' } } } }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({ id: 'qwen-plus', provider: 'dashscope', model: 'qwen-plus', balance: { kind: 'none' } })
  await harness.api.deleteAccount({ id: 'qwen-plus' })
  assert.deepEqual(writes, [
    { ns: 'pi-ai', ops: [{ op: 'set', path: ['providers', 'dashscope', 'models'], value: [{ id: 'qwen-plus' }] }] },
    { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'dashscope'] }] },
  ])
})

test('a route with another monitored account is kept', async () => {
  const writes = []
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions' } } } }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  })
  await harness.api.saveAccount({ id: 'qwen-plus', provider: 'dashscope', model: 'qwen-plus', balance: { kind: 'none' } })
  await harness.api.saveAccount({ id: 'qwen-max', provider: 'dashscope', model: 'qwen-max', balance: { kind: 'none' } })
  await harness.api.deleteAccount({ id: 'qwen-plus' })
  // Only the route-model sync writes; the route itself must not be released.
  assert.deepEqual(writes.filter((write) => write.ops.some((op) => op.op === 'unset')), [])
})

test('createProvider writes the route, stores the key, and registers the account', async () => {
  const writes = []
  const settings = {
    mutate: async (ns, ops) => { writes.push({ ns, ops }) },
  }
  const credentials = {
    set: async (ref, value) => { writes.push({ ref, value }) },
  }
  const harness = createHarness({
    settings,
    credentials,
    providers: [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
  })

  const snapshot = await harness.api.createProvider({
    route: 'acme',
    displayName: 'Acme',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    apiKey: 'sk-123',
    models: [{ id: 'acme-large', contextWindow: 65536, maxTokens: 4096 }],
    account: { model: 'acme-large', priority: 20, balance: { kind: 'none' } },
  })

  assert.equal(credentialRefFor('acme'), 'ACME_API_KEY')
  assert.deepEqual(writes[0], {
    ns: 'llm-pi-ai',
    ops: [{
      op: 'set',
      path: ['providers', 'acme'],
      value: {
        displayName: 'Acme',
        api: 'openai-completions',
        baseURL: 'https://acme.example/v1',
        models: [{ id: 'acme-large', contextWindow: 65536, maxTokens: 4096 }],
        apiKeyEnv: 'ACME_API_KEY',
      },
    }],
  })
  assert.deepEqual(writes[1], { ref: 'ACME_API_KEY', value: 'sk-123' })
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].provider, 'acme')
  assert.equal(snapshot.accounts[0].model, 'acme-large')
  assert.equal(snapshot.providers.length, 1)
})

test('createProvider on an existing pi-ai route merges its model list', async () => {
  const writes = []
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{
        ns: 'pi-ai',
        value: {
          providers: {
            dashscope: {
              api: 'openai-completions',
              baseURL: 'https://ds.example/v1',
              apiKeyEnv: 'DASHSCOPE_API_KEY',
              models: [{ id: 'old-model' }],
            },
          },
        },
      }],
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
    credentials: { set: async () => {} },
  })
  const snapshot = await harness.api.createProvider({
    route: 'dashscope',
    api: 'openai-completions',
    baseURL: 'https://ds.example/v1',
    models: [{ id: 'qwen-plus' }],
    account: { model: 'qwen-plus', balance: { kind: 'none' } },
  })
  const profile = writes[0].ops[0].value
  assert.deepEqual(profile.models.map((model) => model.id), ['old-model', 'qwen-plus'])
  assert.equal(profile.apiKeyEnv, 'DASHSCOPE_API_KEY')
  assert.equal(snapshot.accounts.length, 1)
})

test('clearProvider moves the deployment default to a surviving account', async () => {
  const saved = []
  const harness = createHarness({
    defaults: {
      currentSelection: () => ({ provider: 'dashscope', model: 'qwen-plus' }),
      saveSelection: async (selection) => { saved.push(selection) },
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions', models: [] } } },
      }],
      mutate: async () => {},
    },
    configurable: [{ provider: 'dashscope', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dashscope'] }],
  })
  await harness.api.saveAccount({
    id: 'dashscope-plus',
    provider: 'dashscope',
    model: 'qwen-plus',
    priority: 100,
    balance: { kind: 'none' },
  })
  await harness.api.saveAccount({
    id: 'other-model',
    provider: 'other',
    model: 'm',
    priority: 50,
    balance: { kind: 'none' },
  })
  await harness.api.clearProvider({ provider: 'dashscope' })
  // The default would otherwise point at a provider id that no longer exists.
  assert.deepEqual(saved, [{ provider: 'other', model: 'm' }])
})

test('createProvider keeps the settings of an account it re-declares', async () => {
  const harness = createHarness({
    settings: { mutate: async () => {} },
    credentials: { set: async () => {} },
    providers: [],
  })
  await harness.api.saveAccount({
    id: 'dashscope-qwen3-8-flash',
    provider: 'dashscope',
    model: 'qwen3.8-flash',
    balance: { kind: 'none' },
    quota: { kind: 'bailian-free', warnPercent: 15, criticalPercent: 3 },
  })
  await harness.api.createProvider({
    route: 'dashscope',
    api: 'openai-completions',
    baseURL: 'https://ds.example/v1',
    models: [{ id: 'qwen3.8-flash' }],
    account: { model: 'qwen3.8-flash' },
  })
  const account = harness.controller.accounts().find((entry) => entry.id === 'dashscope-qwen3-8-flash')
  assert.equal(account.quota.kind, 'bailian-free')
  assert.equal(account.quota.warnPercent, 15)
  assert.equal(account.quota.criticalPercent, 3)
})

test('createProvider still rejects a route owned by another adapter', async () => {
  const harness = createHarness({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    settings: { mutate: async () => assert.fail('must not write the route') },
  })
  await assert.rejects(harness.api.createProvider({
    route: 'deepseek-official',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com/v1',
    models: [{ id: 'deepseek-chat' }],
    account: { model: 'deepseek-chat', balance: { kind: 'none' } },
  }), /已被现有路由占用/)
})

test('createProvider leaves the key out when none is supplied', async () => {
  const writes = []
  const harness = createHarness({
    settings: { mutate: async (ns, ops) => { writes.push({ ns, ops }) } },
    credentials: { set: async () => assert.fail('must not store a key') },
    providers: [],
  })
  await harness.api.createProvider({
    route: 'native',
    api: 'openai-completions',
    baseURL: 'https://native.example/v1',
    apiKey: '',
    models: [{ id: 'native-model' }],
    account: { model: 'native-model', balance: { kind: 'none' } },
  })
  assert.equal(writes[0].ops[0].value.apiKeyEnv, undefined)
  assert.equal(writes.length, 1)
})

test('createProvider rejects bad ids, protocols, and model lists', async () => {
  const settings = { mutate: async () => assert.fail('must not write') }
  const harness = createHarness({ settings, credentials: { set: async () => {} } })

  await assert.rejects(harness.api.createProvider({
    route: '1bad', api: 'openai-completions', baseURL: 'https://x.example', models: [{ id: 'm' }], account: { model: 'm' },
  }), /Provider ID/)

  await assert.rejects(harness.api.createProvider({
    route: 'ok', api: 'openai-completions', baseURL: 'ftp://x.example', models: [{ id: 'm' }], account: { model: 'm' },
  }), /http\(s\)/)

  await assert.rejects(harness.api.createProvider({
    route: 'ok', api: 'openai-completions', baseURL: 'https://x.example', models: [], account: { model: 'm' },
  }), /至少需要一个模型/)

  await assert.rejects(harness.api.createProvider({
    route: 'ok', api: 'openai-completions', baseURL: 'https://x.example',
    models: [{ id: 'm' }, { id: 'm' }], account: { model: 'm' },
  }), /重复/)

  await assert.rejects(harness.api.createProvider({
    route: 'ok', api: 'openai-completions', baseURL: 'https://x.example',
    models: [{ id: 'm' }], account: { model: 'other' },
  }), /模型列表内/)
})

test('createProvider refuses a route an adapter already serves', async () => {
  const harness = createHarness({
    settings: { mutate: async () => assert.fail('must not write') },
    credentials: { set: async () => {} },
    providers: [{ id: 'moonshotai-cn', name: 'Moonshot AI CN' }],
  })
  await assert.rejects(harness.api.createProvider({
    route: 'moonshotai-cn',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2' }],
    account: { model: 'kimi-k2' },
  }), /已被现有路由占用/)
})

test('createProvider reports a missing settings seam', async () => {
  const harness = createHarness({ providers: [] })
  await assert.rejects(harness.api.createProvider({
    route: 'acme', api: 'openai-completions', baseURL: 'https://acme.example/v1',
    models: [{ id: 'm' }], account: { model: 'm' },
  }), /设置服务未挂载/)
})

test('createProvider reuses an existing credential reference without a key', async () => {
  const writes = []
  const harness = createHarness({
    settings: { mutate: async (ns, ops) => { writes.push({ ns, ops }) } },
    credentials: {
      set: async () => assert.fail('must not store a key'),
      describe: async (ref) => ({ configured: ref === 'ARKCLI_CODING_PLAN_API_KEY' }),
    },
  })
  const snapshot = await harness.api.createProvider({
    route: 'volcengine-coding',
    displayName: '火山方舟 Coding Plan',
    api: 'openai-completions',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    credentialRef: 'ARKCLI_CODING_PLAN_API_KEY',
    models: [{ id: 'deepseek-v4.1-flash' }],
    account: { model: 'deepseek-v4.1-flash', balance: { kind: 'none' } },
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ops[0].value.apiKeyEnv, 'ARKCLI_CODING_PLAN_API_KEY')
  assert.equal(snapshot.accounts[0].provider, 'volcengine-coding')
})

test('reusing an unconfigured reference is rejected before anything is written', async () => {
  const writes = []
  const harness = createHarness({
    settings: { mutate: async (ns, ops) => { writes.push({ ns, ops }) } },
    credentials: { describe: async () => ({ configured: false }) },
  })
  await assert.rejects(harness.api.createProvider({
    route: 'acme',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    credentialRef: 'MISSING_KEY',
    models: [{ id: 'm' }],
    account: { model: 'm' },
  }), /未配置/)
  assert.equal(writes.length, 0)
})

test('a typed key is stored under the requested reference', async () => {
  const stored = []
  const harness = createHarness({
    settings: { mutate: async () => {} },
    credentials: {
      set: async (ref, value) => { stored.push({ ref, value }) },
      describe: async () => ({ configured: true }),
    },
  })
  await harness.api.createProvider({
    route: 'acme',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    apiKey: 'sk-1',
    credentialRef: 'SHARED_KEY',
    models: [{ id: 'm' }],
    account: { model: 'm' },
  })
  assert.deepEqual(stored, [{ ref: 'SHARED_KEY', value: 'sk-1' }])
})

test('createProvider stores the Alibaba Cloud AccessKey pair', async () => {
  const stored = []
  const harness = createHarness({
    settings: { mutate: async () => {} },
    credentials: { set: async (ref, value) => { stored.push({ ref, value }) } },
  })
  await harness.api.createProvider({
    route: 'dashscope',
    api: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen-plus' }],
    accessKey: 'LTAI-test',
    accessKeySecret: 'secret-value',
    account: {
      model: 'qwen-plus',
      balance: {
        kind: 'aliyun',
        accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID',
        accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET',
      },
    },
  })
  assert.deepEqual(stored, [
    { ref: 'ALIYUN_ACCESS_KEY_ID', value: 'LTAI-test' },
    { ref: 'ALIYUN_ACCESS_KEY_SECRET', value: 'secret-value' },
  ])
})

test('an illegal credential reference is rejected', async () => {
  const harness = createHarness({ settings: { mutate: async () => {} } })
  await assert.rejects(harness.api.createProvider({
    route: 'acme',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    credentialRef: 'bad-ref',
    models: [{ id: 'm' }],
    account: { model: 'm' },
  }), /环境变量名/)
})

test('state reports the credential reference a provider already declares', async () => {
  const harness = createHarness({
    providers: [{ id: 'acme', name: 'Acme' }],
    configurable: [{ provider: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] }],
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }] },
  })
  const snapshot = await harness.api.state()
  assert.deepEqual(snapshot.providers, [{ id: 'acme', name: 'Acme', apiKeyEnv: 'ACME_KEY' }])
})

test('a provider whose profile declares no reference keeps the bare entry', async () => {
  const harness = createHarness({
    providers: [{ id: 'native', name: 'Native' }],
    configurable: [{ provider: 'native', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'native'] }],
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { native: { api: 'openai-completions' } } } }] },
  })
  const snapshot = await harness.api.state()
  assert.deepEqual(snapshot.providers, [{ id: 'native', name: 'Native' }])
})

test('a login-authenticated provider adopts a reference that actually holds a secret', async () => {
  const described = []
  const harness = createHarness({
    providers: [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    credentials: {
      describe: async (ref) => {
        described.push(ref)
        return { configured: ref === 'DEEPSEEK_API_KEY', writable: true }
      },
    },
  })
  const snapshot = await harness.api.state()
  assert.deepEqual(snapshot.providers, [
    { id: 'deepseek-account', name: 'DeepSeek Account', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeyDetected: true },
  ])
  assert.deepEqual(described, ['DEEPSEEK_ACCOUNT_API_KEY', 'DEEPSEEK_ACCOUNT', 'DEEPSEEK_API_KEY'])
})

test('a declared reference is preferred over store detection', async () => {
  const harness = createHarness({
    providers: [{ id: 'acme', name: 'Acme' }],
    configurable: [{ provider: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] }],
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }] },
    credentials: { describe: async () => ({ configured: true }) },
  })
  const snapshot = await harness.api.state()
  assert.equal(snapshot.providers[0].apiKeyEnv, 'ACME_KEY')
})

test('discoverModels asks the namespace that owns an existing route', async () => {
  let observed
  const harness = createHarness({
    providers: [{ id: 'acme', name: 'Acme' }],
    configurable: [{ provider: 'acme', settingsNs: 'acme-ns', settingsPath: [] }],
    discover: async (ns, request) => {
      observed = { ns, request }
      return [{ id: 'acme-large', name: 'Acme Large', contextWindow: 65536 }, { id: 'acme-small' }]
    },
  })
  const result = await harness.api.discoverModels({ provider: 'acme' })
  assert.deepEqual(observed, { ns: 'acme-ns', request: { provider: 'acme' } })
  assert.deepEqual(result.models, [
    { id: 'acme-large', name: 'Acme Large', contextWindow: 65536 },
    { id: 'acme-small' },
  ])
})

test('an existing route lists only the models dsh configured', async () => {
  let remoteAsked = 0
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions', apiKeyEnv: 'DASHSCOPE_API_KEY' } } } }],
    },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
    listModels: async () => [{ id: 'qwen3.8-27b' }, { id: 'glm-5.3' }],
    discover: async () => { remoteAsked += 1; return [{ id: 'qwen-plus' }, { id: 'qwen-max' }] },
  })
  const result = await harness.api.discoverModels({ provider: 'dashscope' })
  // The route's own models are the only ones dsh can actually route to.
  assert.deepEqual(result.models.map((model) => model.id), ['qwen3.8-27b', 'glm-5.3'])
  // Neither the endpoint sweep nor the adapter probe runs: the catalog answers it.
  assert.equal(remoteAsked, 0)
})

test('a route with no catalog still reads the endpoint listing directly', async () => {
  const requests = []
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions', apiKeyEnv: 'DASHSCOPE_API_KEY' } } } }],
    },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
    listModels: async () => [],
    discover: async () => [{ id: 'only-one' }],
    fetch: async (url, init) => {
      requests.push({ url, auth: init.headers.authorization })
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen-plus' }, { id: 'qwen-max' }, { id: 'only-one' }] }),
      }
    },
  })
  const result = await harness.api.discoverModels({ provider: 'dashscope' })
  assert.equal(requests[0].url, 'https://ds.example/v1/models')
  assert.equal(requests[0].auth, 'Bearer sk-test')
  assert.deepEqual(result.models.map((model) => model.id), ['qwen-plus', 'qwen-max', 'only-one'])
})

test('discoverModels attaches the Bailian free allowance rows', async () => {
  const harness = createHarness({
    providers: [{ id: 'dashscope', name: '百炼' }],
    configurable: [{ provider: 'dashscope', settingsNs: 'pi-ai', settingsPath: ['providers', 'dashscope'] }],
    settings: {
      describe: () => [{ ns: 'pi-ai', value: { providers: { dashscope: { baseURL: 'https://ds.example/v1', api: 'openai-completions', apiKeyEnv: 'DASHSCOPE_API_KEY' } } } }],
    },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
    listModels: async () => [{ id: 'qwen3.8-27b' }],
    discover: async () => [{ id: 'qwen3.8-27b' }, { id: 'qwen-plus' }],
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'qwen3.8-27b' }, { id: 'qwen-plus' }] }),
    }),
    freeQuota: async () => ({
      ok: true,
      models: [{ model: 'qwen3.8-27b', remaining: 999832, total: 1000000, remainingPercent: 100 }],
    }),
  })
  const result = await harness.api.discoverModels({ provider: 'dashscope' })
  assert.equal(result.freeQuota.length, 1)
  assert.equal(result.freeQuota[0].model, 'qwen3.8-27b')
})

test('a non-Bailian route never asks the CLI', async () => {
  let asked = 0
  const harness = createHarness({
    discover: async () => [{ id: 'acme-large' }],
    freeQuota: async () => { asked += 1; return { ok: true, models: [] } },
  })
  await harness.api.discoverModels({ baseURL: 'https://gw.example/v1' })
  assert.equal(asked, 0)
})

test('discoverModels interrogates a draft endpoint with a one-shot key', async () => {
  let observed
  const harness = createHarness({
    discover: async (ns, request) => {
      observed = { ns, request }
      return []
    },
  })
  const result = await harness.api.discoverModels({
    baseURL: 'https://gw.example/v1', api: 'openai-completions', apiKey: 'sk-1',
  })
  assert.deepEqual(observed, {
    ns: 'llm-pi-ai',
    request: { baseURL: 'https://gw.example/v1', api: 'openai-completions', apiKey: 'sk-1' },
  })
  assert.deepEqual(result.models, [])
})

test('discoverModels falls through namespaces and normalizes ids', async () => {
  const tried = []
  const harness = createHarness({
    namespaces: ['broken-ns', 'llm-pi-ai'],
    discover: async (ns) => {
      tried.push(ns)
      if (ns === 'broken-ns') throw new Error('NO_DISCOVERY')
      return [{ id: 'a' }, { id: 'a' }, { id: '' }, null, { id: 'b', contextWindow: 0 }]
    },
  })
  const result = await harness.api.discoverModels({ baseURL: 'https://gw.example/v1' })
  assert.deepEqual(tried, ['broken-ns', 'llm-pi-ai'])
  assert.deepEqual(result.models, [{ id: 'a' }, { id: 'b' }])
})

test('discoverModels surfaces the last failure and validates its input', async () => {
  const harness = createHarness({
    discover: async () => { throw new Error('NO_DISCOVERY') },
  })
  await assert.rejects(harness.api.discoverModels({ baseURL: 'https://gw.example/v1' }), /NO_DISCOVERY/)
  await assert.rejects(harness.api.discoverModels({}), /provider 或 baseURL/)
})

test('discoverModels rejects runtimes without the discovery seam', async () => {
  const harness = createHarness({})
  await assert.rejects(harness.api.discoverModels({ provider: 'acme' }), /不支持模型发现/)
})

test('discoverModels prefers the adapter catalog of an existing route', async () => {
  let discoverCalls = 0
  const harness = createHarness({
    providers: [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    listModels: async (provider) => [
      { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { provider, id: 'deepseek-pro', name: 'DeepSeek Pro' },
    ],
    discover: async () => {
      discoverCalls += 1
      return []
    },
  })
  const result = await harness.api.discoverModels({ provider: 'deepseek-account' })
  assert.equal(discoverCalls, 0)
  assert.deepEqual(result.models, [
    { id: 'deepseek-flash', name: 'DeepSeek Flash' },
    { id: 'deepseek-pro', name: 'DeepSeek Pro' },
  ])
})

test('an empty catalog falls through to endpoint discovery', async () => {
  const calls = []
  const harness = createHarness({
    listModels: async () => [],
    discover: async (ns) => {
      calls.push(ns)
      return [{ id: 'm1' }]
    },
  })
  const result = await harness.api.discoverModels({ provider: 'acme' })
  assert.deepEqual(calls, ['llm-pi-ai'])
  assert.deepEqual(result.models, [{ id: 'm1' }])
})

test('an existing route without catalog or discovery gets an actionable message', async () => {
  const harness = createHarness({
    listModels: async () => [],
    discover: async () => { throw new Error('no model discovery is registered for "llm-deepseek-account"') },
  })
  await assert.rejects(
    harness.api.discoverModels({ provider: 'deepseek-account' }),
    /无法获取 deepseek-account 的模型列表.*手动填写/,
  )
})

test('updateAccount patches only the submitted fields', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({
    id: 'deepseek',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    warnBelow: 10,
    criticalBelow: 2,
    balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  })
  const snapshot = await harness.api.updateAccount({ id: 'deepseek', warnBelow: 5, label: '主账户' })
  const account = snapshot.accounts.find((entry) => entry.id === 'deepseek')
  assert.equal(account.label, '主账户')
  assert.equal(account.warnBelow, 5)
  assert.equal(account.criticalBelow, 2)
  assert.equal(account.provider, 'deepseek-official')
  assert.equal(account.model, 'deepseek-v4-flash')
  assert.equal(account.balance.kind, 'deepseek')
  assert.equal(account.balance.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.deepEqual(harness.persisted.at(-1), ['deepseek'])
})

test('updateAccount deep-merges quota thresholds without dropping the product', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({
    id: 'volc',
    provider: 'volcengine',
    model: 'deepseek-v4',
    quota: { kind: 'arkcli-plan', product: 'coding-plan', warnPercent: 20, criticalPercent: 5 },
  })
  const snapshot = await harness.api.updateAccount({ id: 'volc', quota: { warnPercent: 35 } })
  const account = snapshot.accounts.find((entry) => entry.id === 'volc')
  assert.equal(account.quota.kind, 'arkcli-plan')
  assert.equal(account.quota.product, 'coding-plan')
  assert.equal(account.quota.warnPercent, 35)
  assert.equal(account.quota.criticalPercent, 5)
})

test('updateAccount deep-merges the balance section when the probe changes', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({
    id: 'gateway',
    provider: 'custom-gw',
    model: 'm1',
    balance: { kind: 'none', startAmount: 50 },
  })
  const snapshot = await harness.api.updateAccount({
    id: 'gateway',
    balance: { kind: 'http', url: 'https://gw.example/balance', jsonPath: 'data.remaining' },
  })
  const account = snapshot.accounts.find((entry) => entry.id === 'gateway')
  assert.equal(account.balance.kind, 'http')
  assert.equal(account.balance.url, 'https://gw.example/balance')
  assert.equal(account.balance.startAmount, 50)
})

test('updateAccount keeps extra models when only the primary model changes', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({
    id: 'ling',
    provider: 'ant-ling',
    model: 'Ling-3.1-flash',
    models: ['Ling-3.1-flash-economy'],
    balance: { kind: 'none' },
  })
  const snapshot = await harness.api.updateAccount({ id: 'ling', model: 'Ling-3.1-mini' })
  const account = snapshot.accounts.find((entry) => entry.id === 'ling')
  assert.equal(account.model, 'Ling-3.1-mini')
  assert.deepEqual(account.models, ['Ling-3.1-mini', 'Ling-3.1-flash-economy'])
})

test('updateAccount stores the Alibaba Cloud AccessKey pair on edit', async () => {
  const stored = []
  const harness = createHarness({
    credentials: { set: async (ref, value) => { stored.push({ ref, value }) } },
  })
  await harness.api.saveAccount({
    id: 'dashscope',
    provider: 'dashscope',
    model: 'qwen-plus',
    balance: { kind: 'aliyun', accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET' },
  })
  await harness.api.updateAccount({
    id: 'dashscope',
    accessKey: 'LTAI-new',
    accessKeySecret: 'secret-new',
    balance: { kind: 'aliyun', accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET' },
  })
  assert.deepEqual(stored, [
    { ref: 'ALIYUN_ACCESS_KEY_ID', value: 'LTAI-new' },
    { ref: 'ALIYUN_ACCESS_KEY_SECRET', value: 'secret-new' },
  ])
})

test('updateAccount rejects unknown ids and a missing id', async () => {
  const harness = createHarness()
  await harness.api.saveAccount({ id: 'kimi', provider: 'moonshotai-cn', model: 'kimi-k2', balance: { kind: 'moonshot' } })
  await assert.rejects(harness.api.updateAccount({ id: 'ghost', label: 'x' }), /不存在/)
  await assert.rejects(harness.api.updateAccount({ label: 'x' }), /账户 ID不能为空/)
})
