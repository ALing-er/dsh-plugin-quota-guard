import { test } from 'node:test'
import assert from 'node:assert/strict'

import { queryFreeQuota, detectCli, installCli } from '../lib/bailian.js'

test('detectCli distinguishes a missing binary from a working install', async () => {
  const missing = Object.assign(new Error('spawn bl ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(
    await detectCli({ run: async () => { throw missing } }),
    { ok: false, reason: '未安装 bl CLI（npm i -g bailian-cli）' },
  )
  assert.deepEqual(await detectCli({ run: async () => '2.6.2\n' }), { ok: true, version: '2.6.2' })
})

test('installCli delegates to the provided installer', async () => {
  assert.deepEqual(await installCli({ run: async () => ({ ok: true }) }), { ok: true })
  assert.deepEqual(
    await installCli({ run: async () => ({ ok: false, reason: 'npm 安装失败：offline' }) }),
    { ok: false, reason: 'npm 安装失败：offline' },
  )
})

test('a GBK “command not found” message is decoded before matching', async () => {
  // GBK bytes for 不是内部或外部命令, as cmd.exe prints on a Chinese system.
  const gbk = Buffer.from('b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee', 'hex')
  const result = await queryFreeQuota({
    run: async () => { throw Object.assign(new Error('Command failed'), { stderr: gbk }) },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /未安装 bl CLI/)
})

test('queryFreeQuota normalizes the CLI listing', async () => {
  let asked = []
  const result = await queryFreeQuota({
    run: async (args) => {
      asked = args
      return JSON.stringify([
        {
          model: 'qwen3.8-27b',
          type: 'Text',
          remaining: 975716,
          total: 1000000,
          remainingPercent: 97.6,
          expires: '2026-11-25',
          autoStop: true,
        },
        { model: '', remaining: 1 },
        { model: 'qwen3-asr-flash', remaining: 35986, total: 36000 },
      ])
    },
  })
  assert.deepEqual(asked, ['usage', 'free', '--all', '--output', 'json'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.models.map((model) => model.model), ['qwen3.8-27b', 'qwen3-asr-flash'])
  assert.equal(result.models[0].remainingPercent, 97.6)
  assert.equal(result.models[0].expires, '2026-11-25')
  assert.equal(result.models[0].autoStop, true)
  assert.equal(result.models[0].hasQuota, true)
  // The percentage is derived when the CLI omits it.
  assert.ok(Math.abs(result.models[1].remainingPercent - 99.9611) < 1e-3)
})

test('a spent allowance answers with nulls and is flagged', async () => {
  let asked = []
  const result = await queryFreeQuota({
    model: 'deepseek-v4-flash-0731',
    run: async (args) => {
      asked = args
      return JSON.stringify([{
        model: 'deepseek-v4-flash-0731',
        type: 'Text',
        remaining: null,
        total: null,
        remainingPercent: null,
        expires: null,
        autoStop: true,
      }])
    },
  })
  assert.deepEqual(asked, ['usage', 'free', '--model', 'deepseek-v4-flash-0731', '--output', 'json'])
  assert.equal(result.ok, true)
  assert.equal(result.models[0].hasQuota, false)
  assert.equal(result.models[0].remainingPercent, 0)
})

test('a missing CLI becomes an install hint', async () => {
  const error = new Error('spawn bl ENOENT')
  const result = await queryFreeQuota({ run: async () => { throw error } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /npm i -g bailian-cli/)
})

test('an unauthenticated CLI becomes a login hint', async () => {
  const error = new Error('Command failed')
  error.stderr = 'Not authenticated'
  const result = await queryFreeQuota({ run: async () => { throw error } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /bl auth login/)
})

test('a non-JSON reply is rejected', async () => {
  const result = await queryFreeQuota({ run: async () => 'not json' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /JSON/)
})

test('an error document from the CLI is reported verbatim', async () => {
  const result = await queryFreeQuota({
    run: async () => JSON.stringify({ error: 'NoPermission' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /NoPermission/)
})
