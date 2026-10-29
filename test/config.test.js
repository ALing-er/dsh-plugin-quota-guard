import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'

test('defaults: no accounts, ten minute interval, QUOTA_EXCEEDED recovery', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.intervalMs, 600000)
  assert.equal(config.autoSwitch, true)
  assert.deepEqual(config.quotaErrorCodes, ['QUOTA_EXCEEDED'])
  assert.deepEqual(config.accounts, [])
  assert.equal(config.alert.format, 'generic')
  assert.equal(config.alert.webhookUrl, undefined)
  // The second-level failover stays automatic unless the user opts out.
  assert.equal(config.switchOrder, 'auto')
  // Routing data must not be older than a minute before a switch decision.
  assert.equal(config.routeFreshMs, 60000)
  // Same-platform unregistered models are adopted automatically.
  assert.equal(config.autoAdoptModels, true)
  // Missing local tools (Bailian CLI) are installed on demand.
  assert.equal(config.autoInstallCli, true)
})

test('switchOrder only accepts auto or manual', () => {
  assert.equal(normalizeConfig({ switchOrder: 'manual' }).switchOrder, 'manual')
  assert.throws(() => normalizeConfig({ switchOrder: 'random' }), /switchOrder/)
})

test('account normalization folds the default model into models', () => {
  const config = normalizeConfig({
    accounts: [{
      id: 'deepseek',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      warnBelow: 10,
      criticalBelow: 2,
      balance: { kind: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    }],
  })
  const [account] = config.accounts
  assert.deepEqual(account.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(account.label, 'deepseek')
  assert.equal(account.priority, 100)
  assert.equal(account.balance.kind, 'deepseek')
})

test('unknown balance kind is rejected', () => {
  assert.throws(() => normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', balance: { kind: 'carrier-pigeon' } }],
  }), /accounts\[0\]\.balance\.kind/)
})

test('duplicate account ids are rejected', () => {
  assert.throws(() => normalizeConfig({
    accounts: [
      { id: 'same', provider: 'p', model: 'm' },
      { id: 'same', provider: 'q', model: 'n' },
    ],
  }), /duplicates "same"/)
})

test('criticalBelow above warnBelow is rejected', () => {
  assert.throws(() => normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', warnBelow: 2, criticalBelow: 5 }],
  }), /criticalBelow/)
})

test('http probe requires url and jsonPath', () => {
  assert.throws(() => normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', balance: { kind: 'http', jsonPath: 'data.total' } }],
  }), /url/)
  assert.throws(() => normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', balance: { kind: 'http', url: 'https://x.example/credits' } }],
  }), /jsonPath/)
})

test('pricing must contain at least one positive price', () => {
  assert.throws(() => normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', pricing: { inputPerMTok: 0 } }],
  }), /pricing/)
})

test('webhook url and format are validated', () => {
  assert.throws(() => normalizeConfig({ alert: { webhookUrl: 'not-a-url' } }), /webhookUrl/)
  assert.throws(() => normalizeConfig({ alert: { format: 'sms' } }), /format/)
})

test('cache prices fall back to the uncached input price', () => {
  const config = normalizeConfig({
    accounts: [{ id: 'a', provider: 'p', model: 'm', pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
  })
  assert.equal(config.accounts[0].pricing.cacheReadPerMTok, 2)
  assert.equal(config.accounts[0].pricing.cacheWritePerMTok, 2)
})
