import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createRoutes } from '../lib/routes.js'

/**
 * Minimal response recorder.
 * @returns {object} fake ServerResponse.
 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/**
 * Minimal request stream with an optional JSON body.
 * @param {string} method - HTTP method.
 * @param {unknown} [body] - body to stream as JSON.
 * @returns {object} fake IncomingMessage.
 */
function fakeRequest(method, body) {
  const req = new EventEmitter()
  req.method = method
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

/**
 * Find one route by path.
 * @param {string} path - exact path.
 * @returns {object} route.
 */
function routeOf(path) {
  const api = {
    state: async () => ({ accounts: [] }),
    refresh: async () => ({ refreshed: true }),
    saveAccount: async (body) => ({ saved: body.id }),
    updateAccount: async (body) => ({ updated: body.id }),
    deleteAccount: async (body) => ({ deleted: body.id }),
    createProvider: async () => ({ created: true }),
    discoverModels: async () => ({ models: [] }),
  }
  const route = createRoutes(api).find((entry) => entry.path === path)
  assert.ok(route, `missing route ${path}`)
  return route
}

test('GET on a mutating route is rejected with 405', async () => {
  const res = fakeResponse()
  routeOf('/api/quota-guard/refresh').handler(fakeRequest('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.deepEqual(res.headers, { allow: 'POST' })
})

test('POST /refresh with an empty body succeeds', async () => {
  const res = fakeResponse()
  await routeOf('/api/quota-guard/refresh').handler(fakeRequest('POST', {}), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { refreshed: true })
})

test('POST /accounts streams its JSON body to the operation', async () => {
  const res = fakeResponse()
  await routeOf('/api/quota-guard/accounts').handler(fakeRequest('POST', { id: 'deepseek' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { saved: 'deepseek' })
})

test('malformed JSON is rejected with 400', async () => {
  const res = fakeResponse()
  await routeOf('/api/quota-guard/accounts').handler(fakeRequest('POST', '{not json'), res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'invalid-json')
})

test('operation failures surface as 400 with the message', async () => {
  const failing = createRoutes({
    state: async () => ({}),
    refresh: async () => ({}),
    saveAccount: async () => { throw new Error('余额探针配置不完整') },
    deleteAccount: async () => ({}),
    createProvider: async () => ({}),
    discoverModels: async () => ({}),
  }).find((entry) => entry.path === '/api/quota-guard/accounts')
  const res = fakeResponse()
  await failing.handler(fakeRequest('POST', { id: 'x' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, '余额探针配置不完整')
})

test('POST /accounts/update streams its JSON body to the operation', async () => {
  const res = fakeResponse()
  await routeOf('/api/quota-guard/accounts/update').handler(fakeRequest('POST', { id: 'deepseek', warnBelow: 5 }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { updated: 'deepseek' })
})

test('POST /accounts/update failure surfaces as 400 with the message', async () => {
  const failing = createRoutes({
    state: async () => ({}),
    refresh: async () => ({}),
    saveAccount: async () => ({}),
    updateAccount: async () => { throw new Error('账户 ghost 不存在') },
    deleteAccount: async () => ({}),
    createProvider: async () => ({}),
    discoverModels: async () => ({}),
  }).find((entry) => entry.path === '/api/quota-guard/accounts/update')
  const res = fakeResponse()
  await failing.handler(fakeRequest('POST', { id: 'ghost' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, '账户 ghost 不存在')
})
