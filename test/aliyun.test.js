import { test } from 'node:test'
import assert from 'node:assert/strict'

import { percentEncode, queryAccountBalance, signParams, signedUrl } from '../lib/aliyun.js'
import { normalizeConfig, serializeAccount } from '../lib/config.js'
import { probeBalance } from '../lib/probes.js'

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

test('percentEncode matches the RFC 3986 variant Alibaba Cloud expects', () => {
  assert.equal(percentEncode('a b'), 'a%20b')
  assert.equal(percentEncode('*'), '%2A')
  assert.equal(percentEncode('~'), '~')
  assert.equal(percentEncode('/'), '%2F')
})

test('signParams reproduces the documented Alibaba Cloud example', () => {
  const signature = signParams({
    AccessKeyId: 'testid',
    Action: 'DescribeRegions',
    Format: 'XML',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
    SignatureVersion: '1.0',
    Timestamp: '2016-02-23T12:46:24Z',
    Version: '2014-05-26',
  }, 'testsecret')
  assert.equal(signature, 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=')
})

test('signedUrl carries the RPC parameters and a matching signature', () => {
  const url = signedUrl({
    accessKeyId: 'testid',
    accessKeySecret: 'secret',
    now: Date.UTC(2024, 0, 2, 3, 4, 5),
  })
  const params = new URL(url).searchParams
  assert.equal(params.get('Action'), 'QueryAccountBalance')
  assert.equal(params.get('Version'), '2017-12-14')
  assert.equal(params.get('AccessKeyId'), 'testid')
  assert.equal(params.get('Timestamp'), '2024-01-02T03:04:05Z')

  const unsigned = {}
  for (const [key, value] of params) if (key !== 'Signature') unsigned[key] = value
  assert.equal(params.get('Signature'), signParams(unsigned, 'secret'))
})

test('queryAccountBalance reads Data.AvailableAmount', async () => {
  const result = await queryAccountBalance({
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    timeoutMs: 1000,
    fetchImpl: jsonFetch({ Code: 'Success', Data: { AvailableAmount: '88.50', Currency: 'CNY' } }),
  })
  assert.deepEqual(result, { ok: true, amount: 88.5, currency: 'CNY' })
})

test('queryAccountBalance surfaces API error codes', async () => {
  const result = await queryAccountBalance({
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    timeoutMs: 1000,
    fetchImpl: jsonFetch({ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /InvalidAccessKeyId\.NotFound/)
})

test('queryAccountBalance keeps the error code from a 400 body', async () => {
  const result = await queryAccountBalance({
    accessKeyId: 'id',
    accessKeySecret: 'wrong',
    timeoutMs: 1000,
    fetchImpl: jsonFetch({ Code: 'SignatureDoesNotMatch', Message: 'Specified signature is not matched.' }, 400),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /HTTP 400/)
  assert.match(result.reason, /SignatureDoesNotMatch/)
})

test('queryAccountBalance hints at permissions on 403', async () => {
  const result = await queryAccountBalance({
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    timeoutMs: 1000,
    fetchImpl: jsonFetch({}, 403),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /AliyunBSSReadOnlyAccess/)
})

test('aliyun probe turns the balance API into a balance result', async () => {
  const account = accountOf({
    balance: {
      kind: 'aliyun',
      accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID',
      accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET',
    },
  })
  const result = await probeBalance(account, {
    fetchImpl: jsonFetch({ Code: 'Success', Data: { AvailableAmount: '12.30', Currency: 'CNY' } }),
    resolveApiKey: async (ref) => (ref === 'ALIYUN_ACCESS_KEY_ID' ? 'id' : 'secret'),
    timeoutMs: 1000,
  })
  assert.equal(result.kind, 'balance')
  assert.equal(result.remaining, 12.3)
  assert.equal(result.currency, 'CNY')
  assert.equal(result.source, 'aliyun-balance')
})

test('aliyun probe reports a missing AccessKey reference', async () => {
  const account = accountOf({
    balance: { kind: 'aliyun', accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET' },
  })
  const result = await probeBalance(account, {
    fetchImpl: jsonFetch({ Code: 'Success' }),
    resolveApiKey: async () => undefined,
    timeoutMs: 1000,
  })
  assert.equal(result.kind, 'unavailable')
  assert.match(result.reason, /ALIYUN_ACCESS_KEY_ID 未配置/)
})

test('aliyun balance requires both credential references', () => {
  assert.throws(
    () => accountOf({ balance: { kind: 'aliyun', accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID' } }),
    /accessKeySecretEnv/,
  )
})

test('serializeAccount keeps the AccessKey references', () => {
  const account = accountOf({
    balance: { kind: 'aliyun', accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET' },
  })
  assert.deepEqual(serializeAccount(account).balance, {
    kind: 'aliyun',
    accessKeyEnv: 'ALIYUN_ACCESS_KEY_ID',
    accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET',
  })
})
