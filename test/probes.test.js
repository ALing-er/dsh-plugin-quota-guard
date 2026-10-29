import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probeBalance, readPath } from '../lib/probes.js'
import { normalizeConfig } from '../lib/config.js'

/**
 * Build one normalized account from a raw entry.
 * @param {object} raw - account fields.
 * @returns {object} normalized account.
 */
function accountOf(raw) {
  return normalizeConfig({ accounts: [{ id: 'x', provider: 'p', model: 'm', ...raw }] }).accounts[0]
}

/**
 * Build a fetch stub returning one JSON document.
 * @param {unknown} payload - JSON body.
 * @param {number} [status] - HTTP status.
 * @returns {typeof fetch}
 */
function jsonFetch(payload, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

test('readPath walks mappings and arrays', () => {
  assert.equal(readPath({ data: { list: [{ total: 7 }] } }, 'data.list.0.total'), 7)
  assert.equal(readPath({ data: null }, 'data.total'), undefined)
  assert.equal(readPath({ a: 1 }, undefined), undefined)
})

test('deepseek balance uses total_balance of the preferred currency', async () => {
  const account = accountOf({ currency: 'CNY', balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  const result = await probeBalance(account, {
    fetchImpl: jsonFetch({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '1.00' },
        { currency: 'CNY', total_balance: '42.10' },
      ],
    }),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(result.kind, 'balance')
  assert.equal(result.remaining, 42.1)
  assert.equal(result.currency, 'CNY')
})

test('deepseek is_available=false reports zero remaining', async () => {
  const account = accountOf({ balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  const result = await probeBalance(account, {
    fetchImpl: jsonFetch({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(result.remaining, 0)
})

test('moonshot balance reads data.available_balance', async () => {
  const account = accountOf({ balance: { kind: 'moonshot', apiKeyEnv: 'MOONSHOT_API_KEY' } })
  const result = await probeBalance(account, {
    fetchImpl: jsonFetch({ code: 0, status: true, data: { available_balance: 4.8, voucher_balance: 4, cash_balance: 0.8 } }),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(result.kind, 'balance')
  assert.equal(result.remaining, 4.8)
  assert.equal(result.currency, 'USD')
})

test('generic probe honours jsonPath and availablePath', async () => {
  const account = accountOf({
    balance: { kind: 'http', url: 'https://gw.example/credits', jsonPath: 'data.remaining', availablePath: 'data.active', currency: 'CNY' },
  })
  const affordable = await probeBalance(account, {
    fetchImpl: jsonFetch({ data: { remaining: '9.9', active: true } }),
    resolveApiKey: async () => undefined,
    timeoutMs: 1000,
  })
  assert.equal(affordable.remaining, 9.9)
  assert.equal(affordable.currency, 'CNY')

  const disabled = await probeBalance(account, {
    fetchImpl: jsonFetch({ data: { remaining: '9.9', active: false } }),
    resolveApiKey: async () => undefined,
    timeoutMs: 1000,
  })
  assert.equal(disabled.remaining, 0)
})

test('missing credential degrades instead of issuing a request', async () => {
  const account = accountOf({ balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  let called = false
  const result = await probeBalance(account, {
    fetchImpl: async () => { called = true },
    resolveApiKey: async () => undefined,
    timeoutMs: 1000,
  })
  assert.equal(called, false)
  assert.equal(result.kind, 'unavailable')
  assert.match(result.reason, /DEEPSEEK_API_KEY/)
})

test('non-2xx and malformed bodies degrade', async () => {
  const account = accountOf({ balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  const failed = await probeBalance(account, {
    fetchImpl: jsonFetch({}, 503),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(failed.kind, 'unavailable')
  assert.match(failed.reason, /503/)

  const rejected = await probeBalance(account, {
    fetchImpl: jsonFetch({}, 401),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(rejected.kind, 'unavailable')
  assert.match(rejected.reason, /401（凭据无效或无权查余额）/)

  const malformed = await probeBalance(account, {
    fetchImpl: jsonFetch({ is_available: true }),
    resolveApiKey: async () => 'sk-test',
    timeoutMs: 1000,
  })
  assert.equal(malformed.kind, 'unavailable')
})

test('kind none is unsupported', async () => {
  const account = accountOf({ balance: { kind: 'none' } })
  const result = await probeBalance(account, { fetchImpl: async () => assert.fail('must not fetch'), resolveApiKey: async () => undefined, timeoutMs: 1000 })
  assert.equal(result.kind, 'unsupported')
})
