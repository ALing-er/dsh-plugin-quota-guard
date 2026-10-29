import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig, serializeAccount } from '../lib/config.js'
import { createController } from '../lib/controller.js'
import { probeQuota } from '../lib/quota-probe.js'

/**
 * Build one normalized account.
 * @param {object} raw - account fields.
 * @returns {object} normalized account.
 */
function accountOf(raw) {
  return normalizeConfig({ accounts: [{ id: 'a', provider: 'p', model: 'm', ...raw }] }).accounts[0]
}

test('quota defaults to warn 20% / switch 5%', () => {
  const account = accountOf({ quota: { kind: 'arkcli-plan' } })
  assert.equal(account.quota.kind, 'arkcli-plan')
  assert.equal(account.quota.product, 'coding-plan')
  assert.equal(account.quota.warnPercent, 20)
  assert.equal(account.quota.criticalPercent, 5)
})

test('quota percentages are validated', () => {
  assert.throws(() => accountOf({ quota: { kind: 'arkcli-plan', warnPercent: 5, criticalPercent: 10 } }), /criticalPercent/)
  assert.throws(() => accountOf({ quota: { kind: 'arkcli-plan', warnPercent: 120 } }), /percentage/)
  assert.throws(() => accountOf({ quota: { kind: 'http', url: 'https://x.example' } }), /jsonPath/)
})

test('a generic quota endpoint yields per-model remaining percentages', async () => {
  const account = accountOf({
    quota: { kind: 'http', url: 'https://gw.example/quotas', jsonPath: 'data.quotas' },
  })
  const result = await probeQuota(account, {
    resolveApiKey: async () => undefined,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { quotas: [
        { model: 'm1', remaining: 20, total: 100 },
        { label: 'm2', remainingPercent: 52.5 },
        { label: 'ignored' },
      ] } }),
    }),
    timeoutMs: 1000,
  })
  assert.equal(result.kind, 'quota')
  assert.equal(result.remainingPercent, 20)
  assert.deepEqual(result.periods.map((period) => period.label), ['m1', 'm2'])
  assert.equal(result.periods[1].remainingPercent, 52.5)
})

test('level 2 drives the status and switching thresholds', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{ id: 'ark', provider: 'arkcli-coding-plan', model: 'deepseek-v4.1-flash', quota: { kind: 'arkcli-plan' } }],
    fetchImpl: async () => assert.fail('must not fetch for a quota account'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
    quotaProbe: async () => ({
      kind: 'quota',
      source: 'arkcli-plan',
      product: 'coding-plan',
      periods: [
        { label: 'session', remainingPercent: 92 },
        { label: 'weekly', remainingPercent: 4 },
      ],
      remainingPercent: 4,
    }),
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.status, 'critical')
  assert.equal(account.remainingPercent, 4)
  assert.equal(account.quota.periods.length, 2)
  // The probe payload and the configured thresholds share one field: the table
  // and the settings page read `warnPercent`/`criticalPercent` from it.
  assert.equal(account.quota.warnPercent, 20)
  assert.equal(account.quota.criticalPercent, 5)
  assert.equal(account.source, 'arkcli-plan')
})

test('level 3 reports that nothing is queryable and points at the console', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'plain',
      provider: 'some-gateway',
      model: 'm',
      siteUrl: 'https://console.example.com/usage',
    }],
    fetchImpl: async () => assert.fail('must not fetch without a probe'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.status, 'unknown')
  assert.match(account.note, /无法获取余额与模型剩余额度/)
  assert.match(account.note, /https:\/\/console\.example\.com\/usage/)
  assert.equal(account.siteUrl, 'https://console.example.com/usage')
  assert.equal(account.quota, null)
})

test('each call is priced from its own usage sample', () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ds',
      provider: 'deepseek-platform',
      model: 'deepseek-flash',
      currency: 'CNY',
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    }],
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  controller.noteUsage('deepseek-platform', 'deepseek-flash', {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
  })
  const [account] = controller.snapshot().accounts
  assert.equal(account.spent, 6)
  assert.equal(account.lastCost, 6)
})

test('cached input tokens are billed at the cache rate', () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ds',
      provider: 'deepseek-platform',
      model: 'deepseek-flash',
      pricing: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
    }],
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  // `inputTokens` is the uncached prompt size, so the cache bucket adds to it
  // rather than being carved out of it: 1M at 2/M plus 400k at 0.5/M.
  controller.noteUsage('deepseek-platform', 'deepseek-flash', {
    inputTokens: 1_000_000,
    cacheReadTokens: 400_000,
  })
  const [account] = controller.snapshot().accounts
  assert.ok(Math.abs(account.spent - 2.2) < 1e-9)
})

test('a starting balance survives normalization and serialization', () => {
  const account = accountOf({ balance: { kind: 'none', startAmount: 50 } })
  assert.equal(account.balance.startAmount, 50)
  assert.equal(serializeAccount(account).balance.startAmount, 50)
  assert.throws(() => accountOf({ balance: { kind: 'none', startAmount: -1 } }), /startAmount/)
})

test('an account without a balance endpoint estimates the remaining amount', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ling',
      provider: 'ant-ling',
      model: 'Ling-3.1-flash',
      currency: 'CNY',
      balance: { kind: 'none', startAmount: 20 },
      pricing: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
    }],
    fetchImpl: async () => assert.fail('must not fetch without a probe'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  // 4M input at 0.5/M plus 2M output at 1.5/M = 5 CNY.
  controller.noteUsage('ant-ling', 'Ling-3.1-flash', {
    inputTokens: 4_000_000,
    outputTokens: 2_000_000,
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.status, 'ok')
  assert.equal(account.source, 'estimate')
  assert.equal(account.spent, 5)
  assert.equal(account.remaining, 15)
  assert.equal(account.currency, 'CNY')
  assert.match(account.note, /期初余额/)
})

test('the estimated balance drives the warn and switch thresholds', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ling',
      provider: 'ant-ling',
      model: 'Ling-3.1-flash',
      balance: { kind: 'none', startAmount: 5 },
      pricing: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
      warnBelow: 2,
      criticalBelow: 1,
    }],
    fetchImpl: async () => assert.fail('must not fetch without a probe'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  // 8M input plus 0.4M output = 4.6 CNY, leaving 0.4 of the 5 starting balance.
  controller.noteUsage('ant-ling', 'Ling-3.1-flash', {
    inputTokens: 8_000_000,
    outputTokens: 400_000,
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.ok(Math.abs(account.remaining - 0.4) < 1e-9)
  assert.equal(account.status, 'critical')
})

test('restored spend continues the estimate after a restart', async () => {
  let written
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ling',
      provider: 'ant-ling',
      model: 'Ling-3.1-flash',
      currency: 'CNY',
      balance: { kind: 'none', startAmount: 20 },
      pricing: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
    }],
    savedSpend: new Map([['ling', { spent: 12, lastCost: 1.2 }]]),
    fetchImpl: async () => assert.fail('must not fetch without a probe'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async (accounts, spend) => { written = spend },
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.spent, 12)
  assert.equal(account.remaining, 8)
  assert.equal(written.ling.spent, 12)
})

test('usage of an unmonitored model on the same route is not charged to another model', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen3.8-27b',
      balance: { kind: 'none' },
      quota: { kind: 'tokens', startTokens: 1_000_000 },
    }],
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  // The session actually talked to dashscope/deepseek-v4-flash-0731, which has
  // no account of its own.
  controller.noteUsage('dashscope', 'deepseek-v4-flash-0731', {
    inputTokens: 100_000,
    outputTokens: 50_000,
    cacheReadTokens: 73_000,
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.remainingPercent, 100)
  assert.equal(account.spent, 0)
})

test('the snapshot reports the route the foreground is using', () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [],
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  assert.equal(controller.snapshot().current, null)
  controller.noteRoute('dashscope', 'qwen3.8-27b')
  assert.deepEqual(controller.snapshot().current, { provider: 'dashscope', model: 'qwen3.8-27b', at: 1000 })
})

test('a Bailian account reads its free allowance from the CLI listing', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen3.8-27b',
      balance: { kind: 'none' },
      quota: { kind: 'bailian-free', warnPercent: 20, criticalPercent: 5 },
    }],
    freeQuotaProbe: async () => ({
      ok: true,
      models: [
        { model: 'qwen3.8-flash', remaining: 962181, total: 1000000, remainingPercent: 96.2 },
        { model: 'qwen3.8-27b', remaining: 150000, total: 1000000, remainingPercent: 15, expires: '2026-11-18' },
      ],
    }),
    fetchImpl: async () => assert.fail('must not fetch for a CLI reading'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.remainingPercent, 15)
  assert.equal(account.status, 'warn')
  assert.equal(account.quota.source, 'bailian-free')
  assert.match(account.note, /免费额度剩余/)
  assert.match(account.note, /2026-11-18 到期/)
})

test('a spent Bailian allowance is reported as exhausted', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'flash',
      provider: 'dashscope',
      model: 'deepseek-v4-flash-0731',
      balance: { kind: 'none' },
      quota: { kind: 'bailian-free', warnPercent: 20, criticalPercent: 5 },
    }],
    freeQuotaProbe: async ({ model }) => ({
      ok: true,
      models: [{ model, remaining: 0, total: 0, remainingPercent: 0, hasQuota: false }],
    }),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.status, 'exhausted')
  assert.equal(account.remainingPercent, 0)
  assert.match(account.note, /免费额度已用完/)
})

test('an unreadable Bailian listing explains itself', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen3.8-27b',
      balance: { kind: 'none' },
      quota: { kind: 'bailian-free' },
    }],
    freeQuotaProbe: async () => ({ ok: false, reason: 'bl 未登录（在终端执行 bl auth login --console）' }),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.status, 'unknown')
  assert.match(account.note, /无法读取百炼免费额度/)
  assert.match(account.note, /bl auth login/)
  // The page uses this flag to pop the login dialog on its own.
  assert.equal(controller.snapshot().cli.needsLogin, true)
})

test('every Bailian model out of quota hands the route to another provider', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [
      {
        id: 'pro',
        provider: 'dashscope',
        model: 'deepseek-v4-pro-0813',
        balance: { kind: 'none' },
        quota: { kind: 'bailian-free', warnPercent: 20, criticalPercent: 5 },
      },
      {
        id: 'flash',
        provider: 'dashscope',
        model: 'deepseek-v4-flash-0731',
        balance: { kind: 'none' },
        quota: { kind: 'bailian-free', warnPercent: 20, criticalPercent: 5 },
      },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', balance: { kind: 'none' } },
    ],
    freeQuotaProbe: async ({ model }) => ({
      ok: true,
      models: [{ model, remaining: 0, total: 0, remainingPercent: 0, hasQuota: false }],
    }),
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const snapshot = controller.snapshot()
  assert.deepEqual(
    snapshot.accounts.map((account) => [account.id, account.status]),
    [['pro', 'exhausted'], ['flash', 'exhausted'], ['ant-ling', 'unknown']],
  )
  // The third level: both Bailian models are spent, so the request is rewritten
  // onto the other platform's route.
  assert.deepEqual(
    await controller.routeOverride({ provider: 'dashscope', model: 'deepseek-v4-pro-0813' }),
    { provider: 'ant-ling', model: 'Ling-3.1-flash' },
  )
  // The page can show where the next request will go before it happens.
  controller.noteRoute('dashscope', 'deepseek-v4-pro-0813')
  assert.deepEqual(controller.snapshot().pendingSwitch, {
    provider: 'ant-ling',
    model: 'Ling-3.1-flash',
  })
})

test('an exhausted model adopts an unregistered same-platform model with free quota', async () => {
  const persisted = []
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [
      {
        id: 'pro',
        label: '阿里云百炼',
        provider: 'dashscope',
        model: 'deepseek-v4-pro-0813',
        priority: 10,
        balance: { kind: 'none' },
        quota: { kind: 'bailian-free', warnPercent: 20, criticalPercent: 5 },
      },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', priority: 20, balance: { kind: 'none' } },
    ],
    providerModels: async (provider) => (provider === 'dashscope'
      ? ['deepseek-v4-pro-0813', 'qwen3.8-flash', 'kimi-k3']
      : []),
    freeQuotaProbe: async (options) => {
      // `--all`: several models still carry a free allowance.
      if (options.model === undefined) {
        return {
          ok: true,
          models: [
            { model: 'qwen3.8-flash', remaining: 948341, total: 1000000, remainingPercent: 94.8, hasQuota: true },
            { model: 'kimi-k3', remaining: 999507, total: 1000000, remainingPercent: 99.95, hasQuota: true },
          ],
        }
      }
      return { ok: true, models: [{ model: options.model, remaining: 0, total: 0, remainingPercent: 0, hasQuota: false }] }
    },
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async (accounts) => { persisted.push(accounts.map((account) => account.id)) },
  })
  await controller.refreshAll()

  // The monitored list has no healthy Bailian sibling, so the middle tier runs
  // before the cross-vendor fallback.
  assert.deepEqual(
    await controller.routeOverride({ provider: 'dashscope', model: 'deepseek-v4-pro-0813' }),
    { provider: 'dashscope', model: 'kimi-k3' },
  )

  const adopted = controller.accounts().find((account) => account.model === 'kimi-k3')
  assert.ok(adopted !== undefined)
  assert.equal(adopted.provider, 'dashscope')
  assert.equal(adopted.quota.kind, 'bailian-free')
  assert.equal(adopted.priority, 11)
  assert.ok(persisted.at(-1).includes(adopted.id))
})

test('auto adoption can be turned off', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [], autoAdoptModels: false }),
    entries: [
      {
        id: 'pro',
        provider: 'dashscope',
        model: 'deepseek-v4-pro-0813',
        balance: { kind: 'none' },
        quota: { kind: 'bailian-free' },
      },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', balance: { kind: 'none' } },
    ],
    providerModels: async () => ['qwen3.8-flash'],
    freeQuotaProbe: async ({ model }) => ({
      ok: true,
      models: [model === 'qwen3.8-flash'
        ? { model, remaining: 900000, total: 1000000, remainingPercent: 90, hasQuota: true }
        : { model, remaining: 0, total: 0, remainingPercent: 0, hasQuota: false }],
    }),
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  assert.deepEqual(
    await controller.routeOverride({ provider: 'dashscope', model: 'deepseek-v4-pro-0813' }),
    { provider: 'ant-ling', model: 'Ling-3.1-flash' },
  )
})

test('recommendations list other models with free quota, best first', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'pro',
      provider: 'dashscope',
      model: 'deepseek-v4-pro-0813',
      balance: { kind: 'none' },
      quota: { kind: 'bailian-free' },
    }],
    providerModels: async () => ['deepseek-v4-pro-0813', 'qwen3.8-flash', 'kimi-k3', 'glm-5.3'],
    freeQuotaProbe: async (options) => (options.model === undefined
      ? {
        ok: true,
        models: [
          { model: 'qwen3.8-flash', remaining: 948341, total: 1000000, remainingPercent: 94.8, hasQuota: true, expires: '2026-11-13' },
          { model: 'kimi-k3', remaining: 999507, total: 1000000, remainingPercent: 99.95, hasQuota: true },
          { model: 'glm-5.3', remaining: 0, total: 0, remainingPercent: 0, hasQuota: false },
        ],
      }
      : { ok: true, models: [{ model: options.model, remaining: 0, total: 0, remainingPercent: 0, hasQuota: false }] }),
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const rows = await controller.recommendations('dashscope')
  assert.deepEqual(rows.map((row) => row.model), ['kimi-k3', 'qwen3.8-flash'])
  assert.equal(rows[0].remainingPercent, 99.95)
  assert.equal(rows[0].monitored, false)
  assert.equal(rows[1].expires, '2026-11-13')
})

test('a stale owner is re-probed before the failover decision', async () => {
  let clock = 1000
  let probes = 0
  const controller = createController({
    config: normalizeConfig({ accounts: [], routeFreshMs: 5000 }),
    entries: [
      {
        id: 'pro',
        provider: 'dashscope',
        model: 'deepseek-v4-pro-0813',
        balance: { kind: 'none' },
        quota: { kind: 'bailian-free' },
      },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', balance: { kind: 'none' } },
    ],
    freeQuotaProbe: async ({ model }) => {
      probes += 1
      // The first reading still has headroom, the second one is spent.
      const spent = probes >= 2
      return {
        ok: true,
        models: [{
          model,
          remaining: spent ? 0 : 500000,
          total: 1000000,
          remainingPercent: spent ? 0 : 50,
          hasQuota: !spent,
        }],
      }
    },
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => clock,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  assert.equal(controller.snapshot().accounts[0].status, 'ok')

  // Six seconds later the request must not trust the old reading.
  clock = 7000
  assert.deepEqual(
    await controller.routeOverride({ provider: 'dashscope', model: 'deepseek-v4-pro-0813' }),
    { provider: 'ant-ling', model: 'Ling-3.1-flash' },
  )
  assert.equal(probes, 2)
})

test('refreshStale only re-probes accounts past the freshness window', async () => {
  let clock = 1000
  const probed = []
  const controller = createController({
    config: normalizeConfig({ accounts: [], routeFreshMs: 5000 }),
    entries: [
      { id: 'a', provider: 'dashscope', model: 'm-a', balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'b', provider: 'dashscope', model: 'm-b', balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
    ],
    freeQuotaProbe: async ({ model }) => {
      probed.push(model)
      return { ok: true, models: [{ model, remaining: 900000, total: 1000000, remainingPercent: 90 }] }
    },
    fetchImpl: async () => assert.fail('nothing should be fetched'),
    now: () => clock,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  assert.deepEqual(probed, ['m-a', 'm-b'])

  // Still fresh: no extra CLI calls.
  clock = 2000
  await controller.refreshStale()
  assert.equal(probed.length, 2)

  // Both readings expired: the background loop probes them again.
  clock = 9000
  await controller.refreshStale()
  assert.equal(probed.length, 4)
})

test('the switch order is stored and survives a reload', async () => {
  const writes = []
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [],
    fetchImpl: async () => assert.fail('no accounts, no fetch'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async (accounts, spent, settings) => { writes.push(settings) },
  })
  assert.equal(controller.snapshot().switchOrder, 'auto')
  await controller.setSwitchOrder('manual')
  assert.equal(controller.snapshot().switchOrder, 'manual')
  assert.deepEqual(writes.at(-1), { switchOrder: 'manual' })
  await assert.rejects(controller.setSwitchOrder('sideways'), /switchOrder/)
})

test('re-anchoring the starting balance clears the ledger', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'ling',
      provider: 'ant-ling',
      model: 'Ling-3.1-flash',
      balance: { kind: 'none', startAmount: 20 },
      pricing: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
    }],
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  controller.noteUsage('ant-ling', 'Ling-3.1-flash', { inputTokens: 2_000_000 })
  await controller.upsertAccount({
    id: 'ling',
    provider: 'ant-ling',
    model: 'Ling-3.1-flash',
    balance: { kind: 'none', startAmount: 19.39 },
    pricing: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.spent, 0)
  assert.equal(account.remaining, 19.39)
})

test('a token allowance counts down from the local usage ledger', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen-plus',
      balance: { kind: 'none' },
      quota: { kind: 'tokens', startTokens: 1_000_000, warnPercent: 20, criticalPercent: 5 },
    }],
    fetchImpl: async () => assert.fail('must not fetch for a token ledger'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  // 600k uncached input + 50k cache read + 150k output = 800k of the 1M allowance.
  controller.noteUsage('dashscope', 'qwen-plus', {
    inputTokens: 600_000,
    outputTokens: 150_000,
    cacheReadTokens: 50_000,
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  assert.equal(account.remainingPercent, 20)
  assert.equal(account.status, 'warn')
  assert.equal(account.quota.source, 'token-ledger')
  assert.match(account.note, /期初 1M/)
})

test('a token allowance requires a starting figure', () => {
  assert.throws(() => accountOf({ quota: { kind: 'tokens' } }), /startTokens/)
})

test('the token ledger survives a restart', async () => {
  const controller = createController({
    config: normalizeConfig({ accounts: [] }),
    entries: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen-plus',
      balance: { kind: 'none' },
      quota: { kind: 'tokens', startTokens: 1_000_000, warnPercent: 20, criticalPercent: 5 },
    }],
    savedSpend: new Map([['qwen', {
      spent: 0,
      lastCost: null,
      usage: { input: 900_000, output: 0, cacheRead: 90_000, cacheWrite: 0 },
    }]]),
    fetchImpl: async () => assert.fail('must not fetch for a token ledger'),
    now: () => 1000,
    log: () => {},
    resolveApiKey: async () => undefined,
    persist: async () => {},
  })
  await controller.refreshAll()
  const [account] = controller.snapshot().accounts
  // 990k of 1M consumed → 1% left, under the 5% switch line.
  assert.equal(account.remainingPercent, 1)
  assert.equal(account.status, 'critical')
})
