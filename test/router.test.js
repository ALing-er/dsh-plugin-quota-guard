import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { accountForRoute, isEligible, selectTarget } from '../lib/router.js'

const accounts = normalizeConfig({
  accounts: [
    { id: 'deepseek', provider: 'deepseek-official', model: 'deepseek-v4-flash', models: ['deepseek-v4-pro'], priority: 10, warnBelow: 10, criticalBelow: 2 },
    { id: 'kimi', provider: 'moonshotai-cn', model: 'kimi-k2', priority: 20, balance: { kind: 'moonshot' } },
    { id: 'zhipu', provider: 'zai-coding-cn', model: 'glm-4.6', priority: 30, balance: { kind: 'none' } },
  ],
}).accounts

test('accountForRoute prefers the account serving the exact model', () => {
  assert.equal(accountForRoute(accounts, 'deepseek-official', 'deepseek-v4-pro')?.id, 'deepseek')
  assert.equal(accountForRoute(accounts, 'deepseek-official', 'unknown-model')?.id, 'deepseek')
  assert.equal(accountForRoute(accounts, 'nobody', 'm'), undefined)
})

test('a healthy route is never rewritten', () => {
  const states = new Map([['deepseek', { status: 'ok', remaining: 100 }]])
  assert.equal(selectTarget(accounts, states, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 1000), undefined)
})

test('unknown state keeps the current route', () => {
  const states = new Map([['deepseek', { status: 'unknown', remaining: null }]])
  assert.equal(selectTarget(accounts, states, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 1000), undefined)
})

test('an exhausted owner fails over to the healthiest candidate', () => {
  const states = new Map([
    ['deepseek', { status: 'exhausted', remaining: 0, blockedUntil: 0 }],
    ['kimi', { status: 'ok', remaining: 4 }],
    ['zhipu', { status: 'warn', remaining: 1 }],
  ])
  assert.deepEqual(
    selectTarget(accounts, states, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 1000),
    { id: 'kimi', provider: 'moonshotai-cn', model: 'kimi-k2' },
  )
})

test('blocked candidates are skipped even when they have headroom', () => {
  const states = new Map([
    ['deepseek', { status: 'critical', remaining: 1, blockedUntil: 0 }],
    ['kimi', { status: 'ok', remaining: 100, blockedUntil: 5000 }],
    ['zhipu', { status: 'unknown', remaining: null, blockedUntil: 0 }],
  ])
  assert.deepEqual(
    selectTarget(accounts, states, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 1000),
    { id: 'zhipu', provider: 'zai-coding-cn', model: 'glm-4.6' },
  )
})

test('cooldown expiry makes an account eligible again', () => {
  assert.equal(isEligible(accounts[1], { status: 'ok', blockedUntil: 5000 }, 1000), false)
  assert.equal(isEligible(accounts[1], { status: 'ok', blockedUntil: 5000 }, 6000), true)
  assert.equal(isEligible(accounts[1], { status: 'exhausted', blockedUntil: 0 }, 6000), false)
})

test('same-provider failover keeps the model when the target serves it', () => {
  const sameProvider = normalizeConfig({
    accounts: [
      { id: 'a', provider: 'deepseek-official', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], priority: 10 },
      { id: 'b', provider: 'deepseek-official', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], priority: 20 },
    ],
  }).accounts
  const states = new Map([
    ['a', { status: 'exhausted', remaining: 0, blockedUntil: 0 }],
    ['b', { status: 'ok', remaining: 10 }],
  ])
  // The target route is identical, so there is nothing worth rewriting.
  assert.equal(selectTarget(sameProvider, states, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, 1000), undefined)

  const downgrade = normalizeConfig({
    accounts: [
      { id: 'pro', provider: 'deepseek-official', model: 'deepseek-v4-pro', priority: 10 },
      { id: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash', priority: 20 },
    ],
  }).accounts
  const downgradeStates = new Map([
    ['pro', { status: 'exhausted', remaining: 0, blockedUntil: 0 }],
    ['flash', { status: 'ok', remaining: 10 }],
  ])
  assert.deepEqual(
    selectTarget(downgrade, downgradeStates, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, 1000),
    { id: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  )
})

test('a token ledger never owns a model it does not monitor', () => {
  const bailian = normalizeConfig({
    accounts: [{
      id: 'qwen',
      provider: 'dashscope',
      model: 'qwen3.8-27b',
      balance: { kind: 'none' },
      quota: { kind: 'tokens', startTokens: 1_000_000 },
    }],
  }).accounts
  // The monitored model owns its own usage…
  assert.equal(accountForRoute(bailian, 'dashscope', 'qwen3.8-27b')?.id, 'qwen')
  // …but a different model on the same route must not be charged to it.
  assert.equal(accountForRoute(bailian, 'dashscope', 'deepseek-v4-flash-0731'), undefined)

  // The same rule covers a free allowance read from the platform.
  const free = normalizeConfig({
    accounts: [{
      id: 'free',
      provider: 'dashscope',
      model: 'qwen3.8-27b',
      balance: { kind: 'none' },
      quota: { kind: 'bailian-free' },
    }],
  }).accounts
  assert.equal(accountForRoute(free, 'dashscope', 'deepseek-v4-flash-0731'), undefined)
})

test('a Bailian model fails over to another Bailian language model first', () => {
  const bailian = normalizeConfig({
    accounts: [
      { id: 'qwen-plus', provider: 'dashscope', model: 'qwen-plus', priority: 10, balance: { kind: 'none' }, quota: { kind: 'tokens', startTokens: 1_000_000 } },
      { id: 'qwen-max', provider: 'dashscope', model: 'qwen-max', priority: 90, balance: { kind: 'none' }, quota: { kind: 'tokens', startTokens: 1_000_000 } },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', priority: 1, balance: { kind: 'none' } },
    ],
  }).accounts
  const states = new Map([
    ['qwen-plus', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['qwen-max', { status: 'ok', remainingPercent: 95, blockedUntil: 0 }],
    ['ant-ling', { status: 'ok', remaining: 19, blockedUntil: 0 }],
  ])
  // The same-platform candidate wins even though ant-ling has a far better
  // priority and a real balance.
  assert.deepEqual(
    selectTarget(bailian, states, { provider: 'dashscope', model: 'qwen-plus' }, 1000),
    { id: 'qwen-max', provider: 'dashscope', model: 'qwen-max' },
  )
})

test('a platform with no healthy sibling still falls back across platforms', () => {
  const bailian = normalizeConfig({
    accounts: [
      { id: 'qwen-plus', provider: 'dashscope', model: 'qwen-plus', balance: { kind: 'none' } },
      { id: 'qwen-max', provider: 'dashscope', model: 'qwen-max', balance: { kind: 'none' } },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', balance: { kind: 'none' } },
    ],
  }).accounts
  const states = new Map([
    ['qwen-plus', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['qwen-max', { status: 'critical', remainingPercent: 2, blockedUntil: 0 }],
    ['ant-ling', { status: 'ok', remaining: 19, blockedUntil: 0 }],
  ])
  assert.deepEqual(
    selectTarget(bailian, states, { provider: 'dashscope', model: 'qwen-plus' }, 1000),
    { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash' },
  )
})

test('exhausting every model of a platform hands the route to another provider', () => {
  const bailian = normalizeConfig({
    accounts: [
      { id: 'pro', provider: 'dashscope', model: 'deepseek-v4-pro-0813', priority: 10, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'flash', provider: 'dashscope', model: 'deepseek-v4-flash-0731', priority: 20, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash', priority: 900, balance: { kind: 'none' } },
    ],
  }).accounts
  const states = new Map([
    ['pro', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['flash', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['ant-ling', { status: 'ok', remaining: 19, blockedUntil: 0 }],
  ])
  // The third level: no sibling left, so the cross-provider candidate wins
  // even though its priority is far worse.
  assert.deepEqual(
    selectTarget(bailian, states, { provider: 'dashscope', model: 'deepseek-v4-pro-0813' }, 1000),
    { id: 'ant-ling', provider: 'ant-ling', model: 'Ling-3.1-flash' },
  )
})

test('manual order outranks measured health inside one platform', () => {
  const bailian = normalizeConfig({
    accounts: [
      { id: 'owner', provider: 'dashscope', model: 'qwen-owner', priority: 30, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'first', provider: 'dashscope', model: 'qwen-first', priority: 10, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'second', provider: 'dashscope', model: 'qwen-second', priority: 20, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
    ],
  }).accounts
  const states = new Map([
    ['owner', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['first', { status: 'warn', remainingPercent: 15, blockedUntil: 0 }],
    ['second', { status: 'ok', remainingPercent: 95, blockedUntil: 0 }],
  ])
  const base = { provider: 'dashscope', model: 'qwen-owner' }
  // Automatic keeps the healthier model…
  assert.deepEqual(selectTarget(bailian, states, base, 1000), { id: 'second', provider: 'dashscope', model: 'qwen-second' })
  // …manual keeps the user's order.
  assert.deepEqual(
    selectTarget(bailian, states, base, 1000, { switchOrder: 'manual' }),
    { id: 'first', provider: 'dashscope', model: 'qwen-first' },
  )
})

test('manual order never resurrects an exhausted candidate', () => {
  const bailian = normalizeConfig({
    accounts: [
      { id: 'owner', provider: 'dashscope', model: 'qwen-owner', priority: 10, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'dead', provider: 'dashscope', model: 'qwen-dead', priority: 20, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
      { id: 'alive', provider: 'dashscope', model: 'qwen-alive', priority: 30, balance: { kind: 'none' }, quota: { kind: 'bailian-free' } },
    ],
  }).accounts
  const states = new Map([
    ['owner', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['dead', { status: 'exhausted', remainingPercent: 0, blockedUntil: 0 }],
    ['alive', { status: 'warn', remainingPercent: 12, blockedUntil: 0 }],
  ])
  assert.deepEqual(
    selectTarget(bailian, states, { provider: 'dashscope', model: 'qwen-owner' }, 1000, { switchOrder: 'manual' }),
    { id: 'alive', provider: 'dashscope', model: 'qwen-alive' },
  )
})

test('no eligible candidate leaves the call unchanged', () => {
  const states = new Map([
    ['deepseek', { status: 'exhausted', remaining: 0, blockedUntil: 0 }],
    ['kimi', { status: 'exhausted', remaining: 0, blockedUntil: 9000 }],
    ['zhipu', { status: 'critical', remaining: 0.5, blockedUntil: 0 }],
  ])
  assert.equal(selectTarget(accounts, states, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 1000), undefined)
})
