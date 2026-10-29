/**
 * HTTP routes consumed by the Settings page (same origin as the web app).
 *
 * @module dsh-plugin-quota-guard/routes
 */

/** URL prefix owned by this plugin. */
export const API_PREFIX = '/api/quota-guard'

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Reject a request whose method does not match the route.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string} method - expected method.
 * @returns {boolean} whether the request may proceed.
 */
function requireMethod(req, res, method) {
  if (req.method === method) return true
  res.writeHead(405, { allow: method })
  res.end()
  return false
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<unknown>} parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Wrap one GET operation.
 * @param {string} path - exact path.
 * @param {() => Promise<unknown>} run - operation.
 * @returns {object} route definition.
 */
function getRoute(path, run) {
  return {
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      return run().then(
        (value) => json(res, 200, value),
        (error) => json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
    },
  }
}

/**
 * Wrap one POST operation.
 * @param {string} path - exact path.
 * @param {(body: any) => Promise<unknown>} run - operation.
 * @returns {object} route definition.
 */
function postRoute(path, run) {
  return {
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      return readJsonBody(req).then(
        (body) => Promise.resolve()
          .then(() => run(body === null || typeof body !== 'object' ? {} : body))
          .then(
            (value) => json(res, 200, value),
            (error) => json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }),
          ),
        () => json(res, 400, { ok: false, error: 'invalid-json' }),
      )
    },
  }
}

/**
 * Build the route family for one API instance.
 * @param {object} api - operations from {@link createApi}.
 * @returns {object[]} route definitions.
 */
export function createRoutes(api) {
  return [
    getRoute(`${API_PREFIX}/state`, () => api.state()),
    postRoute(`${API_PREFIX}/refresh`, () => api.refresh()),
    postRoute(`${API_PREFIX}/accounts`, (body) => api.saveAccount(body)),
    postRoute(`${API_PREFIX}/accounts/update`, (body) => api.updateAccount(body)),
    postRoute(`${API_PREFIX}/accounts/delete`, (body) => api.deleteAccount(body)),
    postRoute(`${API_PREFIX}/accounts/reorder`, (body) => api.reorderAccount(body)),
    postRoute(`${API_PREFIX}/switch-order`, (body) => api.setSwitchOrder(body)),
    postRoute(`${API_PREFIX}/recommendations`, (body) => api.recommendations(body)),
    postRoute(`${API_PREFIX}/switch-model`, (body) => api.switchModel(body)),
    postRoute(`${API_PREFIX}/providers`, (body) => api.createProvider(body)),
    postRoute(`${API_PREFIX}/discover`, (body) => api.discoverModels(body)),
  ]
}
