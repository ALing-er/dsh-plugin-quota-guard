/**
 * quota-guard Settings section (browser half).
 *
 * Loaded through the package's `dsh.client` declaration and served by the
 * module loader, so this file is plain ESM-in-a-factory: no JSX, no imports —
 * React arrives through `require("react")`.
 *
 * @module dsh-plugin-quota-guard/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-quota-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    const API = '/api/quota-guard'
    /** How often an open Settings page re-reads the snapshot. */
    const POLL_EVERY_MS = 15000
    /** Data age that makes the page re-probe accounts on its own. */
    const REFRESH_EVERY_MS = 30000
    const STYLE_TAG = 'dsh-plugin-quota-guard/styles'

    const CSS = `
.qg-root{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;color:var(--dsw-alias-label-primary);font-size:14px}
.qg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.qg-title{font-size:18px;font-weight:600;line-height:1.3}
.qg-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55;margin-top:4px;max-width:640px}
.qg-actions{display:flex;gap:8px;flex:none}
.qg-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;border-radius:6px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;transition:background .12s}
.qg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.qg-btn:disabled{opacity:.55;cursor:default}
.qg-btn-primary{background:var(--dsw-alias-button-info-fill,#2563eb);border-color:transparent;color:#fff}
.qg-btn-danger{color:var(--dsw-alias-label-error,#c62828)}
.qg-error{border:1px solid var(--dsw-alias-label-error,#c62828);color:var(--dsw-alias-label-error,#c62828);border-radius:6px;padding:8px 12px;font-size:13px;line-height:1.5}
.qg-ok{border:1px solid #1a8f4c;color:#1a8f4c;border-radius:6px;padding:8px 12px;font-size:13px;line-height:1.5}
.qg-list{display:flex;flex-direction:column;gap:10px}
.qg-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,#fff);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.qg-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.qg-name{font-weight:600;line-height:1.3}
.qg-route{color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px;word-break:break-all}
.qg-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.qg-balance{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.qg-pill{border-radius:999px;padding:1px 10px;font-size:12px;border:1px solid currentColor;line-height:1.6;white-space:nowrap}
.qg-pill-ok{color:#1a8f4c}
.qg-pill-warn{color:#b26a00}
.qg-pill-critical{color:#c62828}
.qg-pill-exhausted{color:#c62828}
.qg-pill-unknown{color:var(--dsw-alias-label-tertiary)}
.qg-meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.qg-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:22px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}
.qg-form{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-2,#fff)}
.qg-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:10px}
.qg-tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.qg-tab-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.qg-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);min-width:0}
.qg-input{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);min-width:0}
.qg-input:focus{outline:2px solid var(--dsw-alias-button-info-fill,#2563eb);outline-offset:-1px}
.qg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.qg-foot{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all;line-height:1.5}
.qg-models{display:flex;flex-direction:column;gap:8px;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px}
.qg-model-list{display:flex;flex-direction:column;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:2px}
.qg-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:2px 10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.qg-model-row:last-child{border-bottom:none}
.qg-model-main{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.qg-model-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.qg-model-pct{font-weight:600;font-variant-numeric:tabular-nums}
.qg-model-meta{grid-column:1 / -1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.45;word-break:break-word}
.qg-model-periods{grid-column:1 / -1;margin-top:2px}
.qg-model-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.qg-model-actions .qg-btn{padding:2px 8px;font-size:12px}
.qg-models-head{display:flex;align-items:center;gap:10px}
.qg-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow:auto}
.qg-kind-chips{max-height:none;padding-bottom:6px;margin-bottom:2px;border-bottom:1px dashed var(--dsw-alias-border-l2)}
.qg-kind-chips .qg-chip{font-size:11px;padding:2px 9px;opacity:.85}
.qg-kind-chips .qg-chip-on{opacity:1}
.qg-chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qg-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.qg-chip-on{border-color:var(--dsw-alias-button-info-fill,#2563eb);color:var(--dsw-alias-button-info-fill,#2563eb)}
.qg-quota{display:flex;flex-direction:column;gap:6px}
.qg-qrow{display:grid;grid-template-columns:92px 1fr 64px;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.qg-bar{height:6px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.qg-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-button-info-fill,#2563eb)}
.qg-qval{text-align:right;font-variant-numeric:tabular-nums}
.qg-site a{color:var(--dsw-alias-button-info-fill,#2563eb);word-break:break-all}
.qg-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.qg-switch .qg-btn{padding:3px 10px;font-size:12px}
.qg-switch .qg-tab-on{color:var(--dsw-alias-label-primary)}
.qg-advanced{grid-column:1 / -1;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px}
.qg-advanced>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}
.qg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:60}
.qg-modal{background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;border-radius:10px;padding:18px 20px;max-width:460px;width:calc(100% - 40px);box-shadow:0 18px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:10px}
.qg-command{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--dsw-alias-bg-layer-1,#f6f6f6);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;word-break:break-all;user-select:all}
`

    /** Inject the section stylesheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-quota-guard'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const STATUS_TEXT = Object.freeze({
      ok: '正常',
      warn: '预警',
      critical: '不足',
      exhausted: '耗尽',
      unknown: '未知',
    })

    const PROBE_OPTIONS = [
      { value: 'auto', label: '自动识别' },
      { value: 'deepseek', label: 'DeepSeek 余额接口' },
      { value: 'moonshot', label: 'Moonshot 余额接口' },
      { value: 'aliyun', label: '阿里云账户余额（AccessKey）' },
      { value: 'http', label: 'HTTP 接口（自定义 JSON）' },
      { value: 'none', label: '不查询（错误码驱动）' },
    ]

    const PROTOCOL_OPTIONS = [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ]

    const QUOTA_OPTIONS = [
      { value: 'none', label: '不查询' },
      { value: 'arkcli-plan', label: '火山方舟套餐额度（arkcli）' },
      { value: 'tokens', label: '本地 token 额度（期初 − 用量）' },
      { value: 'bailian-free', label: '百炼免费额度（bl CLI 实测）' },
      { value: 'http', label: 'HTTP 接口（自定义 JSON）' },
    ]

    /**
     * Default shape of the "existing provider" form. Used for both the initial
     * state and the reset performed when the form is reopened, so a previous
     * edit never leaks into a fresh "add" draft.
     * @returns {object} blank form state.
     */
    function blankExisting() {
      return {
        provider: '',
        startTokens: '',
        model: '',
        label: '',
        probe: 'auto',
        quotaKind: 'none',
        apiKey: '',
        apiKeyEnv: '',
        accessKeyEnv: '',
        accessKeySecretEnv: '',
        accessKey: '',
        accessKeySecret: '',
        startAmount: '',
        priceIn: '',
        priceOut: '',
        warnBelow: '10',
        criticalBelow: '2',
        priority: '100',
        siteUrl: '',
        balanceUrl: '',
        balanceBaseUrl: '',
        balanceJsonPath: '',
        balanceAvailablePath: '',
        balanceCurrency: '',
        quotaWarnPercent: '20',
        quotaCriticalPercent: '5',
        quotaProduct: '',
        quotaUrl: '',
        quotaJsonPath: '',
      }
    }

    /**
     * Console page to consult when neither balance nor quota is queryable.
     * @param {string} provider - route id.
     * @returns {string} URL, or an empty string when unknown.
     */
    function siteFor(provider) {
      const id = String(provider).toLowerCase()
      if (id.includes('deepseek')) return 'https://platform.deepseek.com/usage'
      if (id.includes('ark') || id.includes('volc') || id.includes('coding')) {
        return 'https://console.volcengine.com/ark/region:cn-beijing/overview'
      }
      if (id.includes('dashscope') || id.includes('aliyun') || id.includes('bailian') || id.includes('qwen')) {
        return 'https://usercenter2.aliyun.com/finance/expense/overview'
      }
      if (id.includes('ant-ling') || id.includes('antling')) return 'https://chat.ant-ling.com/open'
      if (id.includes('moonshot') || id.includes('kimi')) return 'https://platform.moonshot.cn/console/account'
      return ''
    }

    /**
     * Platform presets for the "new provider" card. Selecting one fills the
     * endpoint, protocol, default model, and probe kind; only the API key and
     * the final model choice are left to the user.
     */
    const PROVIDER_PRESETS = Object.freeze([
      { value: '', label: '自定义' },
      {
        value: 'deepseek',
        label: 'DeepSeek 开放平台',
        route: 'deepseek-platform',
        displayName: 'DeepSeek 平台',
        api: 'openai-completions',
        baseURL: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-chat',
        probe: 'deepseek',
        quotaKind: 'none',
        warnBelow: '10',
        criticalBelow: '2',
        note: '余额接口可直接查询（CNY），密钥需为 platform.deepseek.com 生成的 sk- 开头平台 key。',
      },
      {
        value: 'volcengine-coding',
        label: '火山引擎 Coding Plan',
        route: 'volcengine-coding',
        displayName: '火山方舟 Coding Plan',
        api: 'openai-completions',
        baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        modelId: '',
        probe: 'none',
        quotaKind: 'arkcli-plan',
        warnBelow: '',
        criticalBelow: '',
        apiKeyEnv: 'ARKCLI_CODING_PLAN_API_KEY',
        note: '订阅套餐没有余额接口；直接复用你已存的 ARKCLI_CODING_PLAN_API_KEY，无需再粘 key。已有 arkcli-coding-plan 路由时，直接用「使用已有提供方」登记即可。',
      },
      {
        value: 'volcengine',
        label: '火山引擎方舟（按量）',
        route: 'volcengine',
        displayName: '火山方舟',
        api: 'openai-completions',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        modelId: '',
        probe: 'none',
        quotaKind: 'none',
        warnBelow: '',
        criticalBelow: '',
        note: '按量计费端点；模型填 doubao-… 型号或接入点 ep-…；方舟没有余额接口，按错误码驱动切换。',
      },
      {
        value: 'dashscope',
        label: '阿里云百炼',
        route: 'dashscope',
        displayName: '阿里云百炼',
        api: 'openai-completions',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelId: 'qwen-plus',
        probe: 'none',
        quotaKind: 'bailian-free',
        startTokens: '',
        warnBelow: '',
        criticalBelow: '',
        note: '百炼的免费额度只能用官方 CLI 读取：先在终端执行 bl auth login --console 登录，额度来源选「百炼免费额度（bl CLI 实测）」即可显示每个模型的真实剩余。模型列表用「获取模型列表」拉取后逐个添加。',
      },
      {
        value: 'ant-ling',
        label: '蚂蚁百灵',
        route: 'ant-ling',
        displayName: '蚂蚁百灵',
        api: 'openai-completions',
        baseURL: 'https://api.ant-ling.com/v1',
        modelId: 'Ling-3.1-flash',
        probe: 'none',
        quotaKind: 'none',
        priceIn: '0.5',
        priceOut: '1.5',
        warnBelow: '5',
        criticalBelow: '1',
        note: '在 chat.ant-ling.com/open 创建令牌后把令牌填到 API Key。平台没有余额/额度查询接口，改用「期初余额 − 本地累计花费」估算：把官网当前余额填到「期初余额」，单价按 Ling-3.1-flash 限时 2.5 折（输入 0.5、输出 1.5 元/百万 token）。估算只统计 dsh 内的调用，以官网为准。',
      },
    ])

    /**
     * Same-origin JSON request.
     * @param {string} path - endpoint.
     * @param {object} [body] - POST body when present.
     * @returns {Promise<any>} parsed JSON.
     */
    async function request(path, body) {
      const init = body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(path, init)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.error !== undefined) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * Render a money value.
     * @param {number | null} value - amount.
     * @param {string | null} currency - ISO code.
     * @returns {string}
     */
    function money(value, currency) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '-'
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === null ? '' : `${currency} `
      return `${symbol}${value.toFixed(Math.abs(value) >= 100 ? 0 : 2)}`
    }

    /**
     * Render a timestamp.
     * @param {number} value - epoch milliseconds.
     * @returns {string}
     */
    function when(value) {
      if (typeof value !== 'number' || value <= 0) return '未检测'
      return new Date(value).toLocaleString('zh-CN', { hour12: false })
    }

    /**
     * Parse a numeric form field.
     * @param {string} value - raw input.
     * @param {number} [fallback] - value used when empty.
     * @returns {number | undefined}
     */
    function numberOr(value, fallback) {
      const trimmed = String(value ?? '').trim()
      if (trimmed === '') return fallback
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    /**
     * Build a store-safe account id from a route/model pair.
     * @param {string} text - source text.
     * @returns {string}
     */
    function slug(text) {
      const normalized = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      return normalized === '' ? `account-${Date.now().toString(36)}` : normalized
    }

    /**
     * Guess the balance dialect from a provider id.
     * @param {string} provider - route id.
     * @returns {string} probe kind.
     */
    function inferProbe(provider) {
      const id = String(provider).toLowerCase()
      if (id.includes('deepseek')) return 'deepseek'
      if (id.includes('moonshot') || id.includes('kimi')) return 'moonshot'
      return 'none'
    }

    /**
     * Model families that are not chat/completion models, so a "add every
     * language model" sweep skips them (Bailian lists embeddings, ASR, image and
     * video models on the same compatible endpoint).
     */
    const NON_LLM_MODEL = /(embedding|rerank|paraformer|cosyvoice|sambert|tts|asr|speech|ocr|wanx|wan2|image|video|audio|realtime|livetranslate)/i

    /**
     * Version-pinned snapshots such as `qwen-plus-2025-01-25` or `-1017`; they
     * alias the same model family and share its allowance, so the sweep adds
     * the family once instead of every historical build.
     */
    const SNAPSHOT_SUFFIX = /-\d{4}(-\d{2}-\d{2})?$/

    /**
     * Families the discovery picker can filter by, in display order.
     */
    const MODEL_KINDS = [
      ['text', '大语言'],
      ['embedding', '向量'],
      ['rerank', '重排'],
      ['image', '图像'],
      ['video', '视频'],
      ['audio', '语音'],
      ['other', '其他'],
    ]

    /** Filter buttons, including the unfiltered view. */
    const KIND_FILTERS = [['all', '全部'], ...MODEL_KINDS]

    /**
     * Family of one discovered model. The server classifies every id and, when
     * the platform publishes one, also passes its own type label; the keyword
     * fallback only matters for a reply from an older plugin build.
     * @param {object} model - discovered model.
     * @returns {string} family key.
     */
    function kindOfModel(model) {
      if (typeof model.kind === 'string' && model.kind !== '') return model.kind
      return NON_LLM_MODEL.test(String(model.id)) ? 'other' : 'text'
    }

    /**
     * Derive the default credential reference for a provider.
     * @param {string} provider - route id.
     * @returns {string}
     */
    function defaultRef(provider) {
      return `${String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    }

    /**
     * Render one labelled input.
     * @param {string} label - field label.
     * @param {object} input - input element.
     * @param {string} [hint] - helper line.
     * @returns {object} React element.
     */
    function field(label, input, hint) {
      return h('label', { className: 'qg-field' },
        h('span', null, label),
        input,
        hint === undefined ? null : h('span', { className: 'qg-hint' }, hint))
    }

    /**
     * Render one labelled select.
     * @param {string} label - field label.
     * @param {string} value - current value.
     * @param {Array<{value: string, label: string}>} options - choices.
     * @param {(next: string) => void} onChange - change handler.
     * @returns {object} React element.
     */
    function selectField(label, value, options, onChange) {
      return field(label, h('select', {
        className: 'qg-input',
        value,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))))
    }

    /**
     * The Settings section body.
     * @returns {object} React element.
     */
    function QuotaSection() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [mode, setMode] = React.useState(null)
      // Account id being edited; null means the form drafts a new account.
      const [editingId, setEditingId] = React.useState(null)
      const [existing, setExisting] = React.useState(blankExisting)
      const [custom, setCustom] = React.useState({
        route: '',
        startTokens: '',
        displayName: '',
        api: 'openai-completions',
        baseURL: '',
        apiKey: '',
        modelId: '',
        modelName: '',
        contextWindow: '',
        maxTokens: '',
        label: '',
        accessKey: '',
        accessKeySecret: '',
        startAmount: '',
        priceIn: '',
        priceOut: '',
        probe: 'auto',
        quotaKind: 'none',
        apiKeyEnv: '',
        accessKeyEnv: '',
        accessKeySecretEnv: '',
        warnBelow: '10',
        criticalBelow: '2',
        priority: '100',
        siteUrl: '',
        balanceUrl: '',
        balanceBaseUrl: '',
        balanceJsonPath: '',
        balanceAvailablePath: '',
        balanceCurrency: '',
        quotaWarnPercent: '20',
        quotaCriticalPercent: '5',
        quotaProduct: '',
        quotaUrl: '',
        quotaJsonPath: '',
      })
      const [discovered, setDiscovered] = React.useState([])
      // The picker opens on chat models: that is what most accounts monitor,
      // and a platform's full catalog is mostly embedding / speech rows.
      const [kindFilter, setKindFilter] = React.useState('text')
      // Bailian's per-model free allowance, returned alongside the listing when
      // the CLI can read it.
      const [freeQuota, setFreeQuota] = React.useState([])
      const [preset, setPreset] = React.useState('')
      const [discoverBusy, setDiscoverBusy] = React.useState(false)
      const [discoverError, setDiscoverError] = React.useState('')
      const [allProviders, setAllProviders] = React.useState(false)
      /** Same-platform candidates keyed by provider, for exhausted cards. */
      const [recommendations, setRecommendations] = React.useState({})
      const [switchNotice, setSwitchNotice] = React.useState('')
      /** Login dialog popped once per page session when the CLI is not logged in. */
      const [loginPrompt, setLoginPrompt] = React.useState(false)
      const loginPrompted = React.useRef(false)

      /**
       * Load the status document.
       * @param {boolean} [silent] - suppress the error banner for polls.
       * @returns {Promise<object | undefined>} the snapshot, when the read succeeded.
       */
      const load = React.useCallback(async (silent) => {
        try {
          const next = await request(`${API}/state`)
          setSnapshot(next)
          if (!silent) setError('')
          return next
        } catch (failure) {
          if (!silent) setError(failure instanceof Error ? failure.message : String(failure))
          return undefined
        }
      }, [])

      /**
       * Re-probe every account without touching the form state, so a page that
       * was left open keeps showing live numbers.
       * @returns {Promise<void>}
       */
      const autoRefresh = React.useCallback(async () => {
        try {
          const next = await request(`${API}/refresh`, {})
          setSnapshot(next)
        } catch {
          // A background refresh must not replace the page with an error banner.
        }
      }, [])

      React.useEffect(() => {
        /** Whether the oldest account has not been checked for too long. */
        function stale(next) {
          if (next === null || next === undefined || next.accounts.length === 0) return false
          const oldest = Math.min(...next.accounts.map((account) => account.checkedAt ?? 0))
          return Date.now() - oldest >= REFRESH_EVERY_MS
        }
        async function tick() {
          const next = await load(true)
          // Opening the page and every poll re-probe stale accounts automatically;
          // no click on「刷新余额」is needed.
          if (stale(next)) await autoRefresh()
        }
        void tick()
        const timer = setInterval(() => { void tick() }, POLL_EVERY_MS)
        return () => clearInterval(timer)
      }, [load, autoRefresh])

      /**
       * Find the credential reference a provider already declares.
       * @param {string} id - provider route.
       * @returns {string | undefined}
       */
      function providerRef(id) {
        if (snapshot === null || id === '') return undefined
        const entry = snapshot.providers.find((provider) => provider.id === id)
        return entry !== undefined && typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : undefined
      }

      /**
       * Credential reference used when the field is left alone.
       * @param {string} id - provider route.
       * @returns {string}
       */
      function autoRef(id) {
        if (id === '') return ''
        return providerRef(id) ?? defaultRef(id)
      }

      /**
       * Ask the host which models the current form's endpoint advertises.
       * @returns {Promise<void>}
       */
      async function discoverModels() {
        setDiscoverBusy(true)
        setDiscoverError('')
        try {
          const body = mode === 'existing'
            ? { provider: existing.provider }
            : {
              provider: custom.route.trim() === '' ? undefined : custom.route.trim(),
              baseURL: custom.baseURL.trim() === '' ? undefined : custom.baseURL.trim(),
              api: custom.api,
              apiKey: custom.apiKey.trim() === '' ? undefined : custom.apiKey.trim(),
            }
          if (mode === 'existing' && existing.provider === '') throw new Error('先选择提供方')
          if (mode !== 'existing' && body.provider === undefined && body.baseURL === undefined) {
            throw new Error('先填写 Provider ID 或 Base URL')
          }
          const result = await request(`${API}/discover`, body)
          const models = Array.isArray(result.models) ? result.models : []
          setDiscovered(models)
          setFreeQuota(Array.isArray(result.freeQuota) ? result.freeQuota : [])
          if (models.length === 0) setDiscoverError('端点没有返回任何模型')
        } catch (failure) {
          setDiscovered([])
          setFreeQuota([])
          setDiscoverError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setDiscoverBusy(false)
        }
      }

      /**
       * Apply one platform preset to the "new provider" draft.
       * @param {string} value - preset key.
       * @returns {void}
       */
      function applyPreset(value) {
        setPreset(value)
        setDiscovered([])
        setDiscoverError('')
        const found = PROVIDER_PRESETS.find((entry) => entry.value === value)
        if (found === undefined || value === '') return
        setCustom((current) => ({
          ...current,
          route: found.route,
          displayName: found.displayName,
          api: found.api,
          baseURL: found.baseURL,
          modelId: found.modelId,
          modelName: '',
          contextWindow: '',
          maxTokens: '',
          label: found.label,
          probe: found.probe,
          quotaKind: found.quotaKind ?? 'none',
          apiKeyEnv: found.apiKeyEnv ?? (autoRef(found.route) || defaultRef(found.route)),
          accessKeyEnv: found.accessKeyEnv ?? '',
          accessKeySecretEnv: found.accessKeySecretEnv ?? '',
          startAmount: '',
          startTokens: found.startTokens ?? '',
          priceIn: found.priceIn ?? '',
          priceOut: found.priceOut ?? '',
          warnBelow: found.warnBelow,
          criticalBelow: found.criticalBelow,
          siteUrl: '',
          balanceUrl: '',
          balanceBaseUrl: '',
          balanceJsonPath: '',
          balanceAvailablePath: '',
          balanceCurrency: '',
          quotaWarnPercent: '20',
          quotaCriticalPercent: '5',
          quotaProduct: '',
          quotaUrl: '',
          quotaJsonPath: '',
        }))
      }

      /**
       * Point the "existing provider" card at one route and preselect its probe.
       * @param {string} id - provider route.
       * @returns {void}
       */
      function selectProvider(id) {
        const entry = providers.find((provider) => provider.id === id)
        // While editing, switching the provider only retargets the route; the
        // prefilled probe and quota settings stay as they were.
        if (editingId !== null) {
          setExisting((current) => ({ ...current, provider: id }))
          setDiscovered([])
          setDiscoverError('')
          return
        }
        // Alibaba Cloud balances are queried with an AccessKey pair, which is
        // independent of whatever bearer key the route itself uses.
        setExisting((current) => ({
          ...current,
          provider: id,
          apiKeyEnv: autoRef(id),
          label: current.label.trim() === '' ? (entry?.name ?? id) : current.label,
          siteUrl: current.siteUrl.trim() === '' ? (siteFor(id) || '') : current.siteUrl,
          ...defaultsFor(id, entry),
        }))
        setDiscovered([])
        setDiscoverError('')
        // One less click: list the route's models as soon as a platform is chosen.
        void discoverProvider(id)
      }

      /**
       * Load one provider's routable models without touching the open form.
       * @param {string} provider - route id.
       * @returns {Promise<void>}
       */
      async function discoverProvider(provider) {
        if (provider === '') return
        setDiscoverBusy(true)
        setDiscoverError('')
        try {
          const result = await request(`${API}/discover`, { provider })
          setDiscovered(Array.isArray(result.models) ? result.models : [])
          setFreeQuota(Array.isArray(result.freeQuota) ? result.freeQuota : [])
        } catch (failure) {
          setDiscovered([])
          setFreeQuota([])
          setDiscoverError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setDiscoverBusy(false)
        }
      }

      /**
       * Adopt one discovered model into the open form.
       * @param {object} model - discovered model.
       * @returns {void}
       */
      function pickModel(model) {
        if (mode === 'existing') {
          setExisting((current) => ({ ...current, model: model.id }))
          return
        }
        setCustom((current) => ({
          ...current,
          modelId: model.id,
          modelName: typeof model.name === 'string' ? model.name : '',
          contextWindow: model.contextWindow === undefined ? current.contextWindow : String(model.contextWindow),
          maxTokens: model.maxTokens === undefined ? current.maxTokens : String(model.maxTokens),
        }))
      }

      /**
       * Run one mutation and adopt the returned snapshot.
       * @param {string} path - endpoint.
       * @param {object} body - request body.
       * @returns {Promise<void>}
       */
      async function mutate(path, body) {
        setBusy(true)
        setError('')
        try {
          const next = await request(path, body)
          setSnapshot(next)
          setMode(null)
          setEditingId(null)
          setDiscovered([])
          setDiscoverError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Build the balance probe block for one account.
       * @param {string} probeValue - selected probe kind.
       * @param {string} ref - credential reference input.
       * @param {string} provider - route id.
       * @param {{id: string, secret: string}} [accessKey] - Alibaba Cloud AccessKey references.
       * @param {string} [startAmount] - balance as seen in the console, used by the estimate.
       * @returns {object} balance config.
       */
      function balanceOf(probeValue, ref, provider, accessKey = { id: '', secret: '' }, startAmount = '', http = {}) {
        const kind = probeValue === 'auto' ? inferProbe(provider) : probeValue
        if (kind === 'none') {
          const start = numberOr(startAmount)
          // No balance endpoint: the remaining amount is estimated from this
          // starting figure minus the locally accumulated spend.
          return start === undefined ? { kind: 'none' } : { kind: 'none', startAmount: start }
        }
        if (kind === 'aliyun') {
          return {
            kind,
            accessKeyEnv: accessKey.id.trim() === '' ? 'ALIYUN_ACCESS_KEY_ID' : accessKey.id.trim(),
            accessKeySecretEnv: accessKey.secret.trim() === '' ? 'ALIYUN_ACCESS_KEY_SECRET' : accessKey.secret.trim(),
          }
        }
        if (kind === 'http') {
          const block = {
            kind,
            url: http.url.trim(),
            jsonPath: http.jsonPath.trim(),
          }
          if (http.availablePath.trim() !== '') block.availablePath = http.availablePath.trim()
          if (http.baseUrl.trim() !== '') block.baseUrl = http.baseUrl.trim()
          if (http.currency.trim() !== '') block.currency = http.currency.trim()
          const configured = ref.trim()
          if (configured !== '') block.apiKeyEnv = configured
          return block
        }
        const configured = ref.trim()
        return { kind, apiKeyEnv: configured === '' ? autoRef(provider) || defaultRef(provider) : configured }
      }

      /**
       * Build the optional price table used to cost every call.
       * @param {string} priceIn - input price per million tokens.
       * @param {string} priceOut - output price per million tokens.
       * @returns {object | undefined} pricing config, or undefined when empty.
       */
      function pricingOf(priceIn, priceOut) {
        const input = numberOr(priceIn)
        const output = numberOr(priceOut)
        if (input === undefined && output === undefined) return undefined
        return {
          ...(input === undefined ? {} : { inputPerMTok: input }),
          ...(output === undefined ? {} : { outputPerMTok: output }),
        }
      }

      /**
       * Build the quota section shared by both account forms; the "existing" and
       * "custom" drafts carry the same quota field names.
       * @param {object} form - form state.
       * @returns {object} quota config.
       */
      function quotaOf(form) {
        if (form.quotaKind === 'none') return { kind: 'none' }
        return {
          kind: form.quotaKind,
          ...(form.quotaKind === 'arkcli-plan' ? { product: 'coding-plan' } : {}),
          ...(form.quotaKind === 'tokens' ? { startTokens: numberOr(form.startTokens, 1000000) } : {}),
          ...(form.quotaKind === 'http'
            ? {
              url: form.quotaUrl.trim(),
              jsonPath: form.quotaJsonPath.trim(),
              ...(form.quotaProduct.trim() === '' ? {} : { product: form.quotaProduct.trim() }),
            }
            : {}),
          warnPercent: numberOr(form.quotaWarnPercent, 20),
          criticalPercent: numberOr(form.quotaCriticalPercent, 5),
        }
      }

      /**
       * First missing field of an HTTP probe, when one is selected.
       * @param {object} form - form state.
       * @returns {string | undefined} message to show.
       */
      function probeIssue(form) {
        if (form.probe === 'http' && (form.balanceUrl.trim() === '' || form.balanceJsonPath.trim() === '')) {
          return 'HTTP 余额探针需要填写接口 URL 和 JSON 路径'
        }
        if (form.quotaKind === 'http' && (form.quotaUrl.trim() === '' || form.quotaJsonPath.trim() === '')) {
          return 'HTTP 额度探针需要填写接口 URL 和 JSON 路径'
        }
        return undefined
      }

      /**
       * Build the account body the "existing provider" form describes for one
       * model. Shared by single saves and the "add every language model" sweep.
       * @param {string} model - model id.
       * @param {string} [label] - display name; omitted while editing.
       * @returns {object} request body without `id`.
       */
      function existingBody(model, label) {
        const warn = numberOr(existing.warnBelow)
        const critical = numberOr(existing.criticalBelow)
        return {
          ...(existing.apiKey.trim() === '' ? {} : { apiKey: existing.apiKey.trim() }),
          accessKey: existing.accessKey.trim() === '' ? undefined : existing.accessKey.trim(),
          accessKeySecret: existing.accessKeySecret.trim() === '' ? undefined : existing.accessKeySecret.trim(),
          ...(label === undefined ? {} : { label }),
          provider: existing.provider,
          model,
          priority: numberOr(existing.priority, 100),
          pricing: pricingOf(existing.priceIn, existing.priceOut),
          balance: balanceOf(existing.probe, existing.apiKeyEnv, existing.provider, {
            id: existing.accessKeyEnv,
            secret: existing.accessKeySecretEnv,
          }, existing.startAmount, {
            url: existing.balanceUrl,
            baseUrl: existing.balanceBaseUrl,
            jsonPath: existing.balanceJsonPath,
            availablePath: existing.balanceAvailablePath,
            currency: existing.balanceCurrency,
          }),
          quota: quotaOf(existing),
          siteUrl: existing.siteUrl.trim() === ''
            ? (editingId === null ? (siteFor(existing.provider) || undefined) : '')
            : existing.siteUrl.trim(),
          ...(warn === undefined ? {} : { warnBelow: warn }),
          ...(critical === undefined ? {} : { criticalBelow: critical }),
        }
      }

      /**
       * Submit the "existing provider" card.
       * @param {Event} event - form submit.
       * @returns {Promise<void>}
       */
      async function submitExisting(event) {
        event.preventDefault()
        if (existing.provider === '') {
          setError('请选择提供方')
          return
        }
        const model = existing.model.trim()
        if (model === '') {
          setError('请填写模型 ID')
          return
        }
        const probeFailure = probeIssue(existing)
        if (probeFailure !== undefined) {
          setError(probeFailure)
          return
        }
        const payload = existingBody(model,
          existing.label.trim() === '' ? (editingId === null ? `${existing.provider} / ${model}` : undefined) : existing.label.trim())
        if (editingId === null) {
          // Saving a provider/model pair that is already monitored updates that
          // account in place, which is how existing accounts gain a start balance.
          const known = snapshot === null
            ? undefined
            : snapshot.accounts.find((account) => account.provider === existing.provider && account.model === model)
          await mutate(`${API}/accounts`, {
            ...payload,
            id: known === undefined ? slug(`${existing.provider}-${model}`) : known.id,
            models: [model],
          })
          return
        }
        // Editing keeps the stored id and carries over any extra models bound
        // to the account; only the primary model is replaced by the form value.
        const current = snapshot === null ? undefined : snapshot.accounts.find((account) => account.id === editingId)
        const extras = (current?.models ?? []).filter((entry) => entry !== current?.model && entry !== model)
        const balance = payload.balance
        if (existing.probe === 'none' && existing.startAmount.trim() === '' && balance.startAmount === undefined) {
          balance.startAmount = null
        }
        await mutate(`${API}/accounts/update`, {
          ...payload,
          id: editingId,
          models: extras,
          balance,
        })
      }

      /**
       * Models "全部加入" would register: language models, and — for a Bailian
       * free-quota account — only those the CLI reported an allowance for.
       * @returns {object[]}
       */
      function addableModels() {
        const kind = mode === 'existing' ? existing.quotaKind : custom.quotaKind
        return discovered
          .filter((model) => kindOfModel(model) === 'text' && !SNAPSHOT_SUFFIX.test(String(model.id)))
          .filter((model) => kind !== 'bailian-free' || freeQuota.length === 0
            || freeQuota.some((row) => row.model === model.id))
      }

      /**
       * Register every discovered language model of the selected provider with
       * the settings currently in the form (one account per model).
       * @returns {Promise<void>}
       */
      async function addAllModels() {
        const targets = addableModels()
        setBusy(true)
        setError('')
        try {
          const known = new Set(accounts.map((account) => `${account.provider}\u0000${account.model}`))
          let latest = snapshot
          let added = 0
          for (const model of targets) {
            if (known.has(`${existing.provider}\u0000${model.id}`)) continue
            latest = await request(`${API}/accounts`, {
              ...existingBody(model.id, `${existing.label.trim() || existing.provider} / ${model.id}`),
              id: slug(`${existing.provider}-${model.id}`),
              models: [model.id],
            })
            added += 1
          }
          setSnapshot(latest)
          setMode(null)
          setEditingId(null)
          setDiscovered([])
          setDiscoverError('')
          if (added === 0) setError('这些模型都已经在监控列表里了')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Submit the "new provider" card: route + key + account in one call.
       * @param {Event} event - form submit.
       * @returns {Promise<void>}
       */
      async function submitCustom(event) {
        event.preventDefault()
        const route = custom.route.trim()
        const modelId = custom.modelId.trim()
        if (route === '') {
          setError('请填写 Provider ID')
          return
        }
        if (custom.baseURL.trim() === '') {
          setError('请填写 Base URL')
          return
        }
        if (modelId === '') {
          setError('请填写模型 ID')
          return
        }
        const probeFailure = probeIssue(custom)
        if (probeFailure !== undefined) {
          setError(probeFailure)
          return
        }
        const warn = numberOr(custom.warnBelow)
        const critical = numberOr(custom.criticalBelow)
        const contextWindow = numberOr(custom.contextWindow)
        const maxTokens = numberOr(custom.maxTokens)
        const model = {
          id: modelId,
          ...(custom.modelName.trim() === '' ? {} : { name: custom.modelName.trim() }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
        }
        await mutate(`${API}/providers`, {
          route,
          displayName: custom.displayName.trim(),
          api: custom.api,
          baseURL: custom.baseURL.trim(),
          apiKey: custom.apiKey.trim(),
          credentialRef: custom.apiKeyEnv.trim() === '' ? undefined : custom.apiKeyEnv.trim(),
          models: [model],
          accessKey: custom.accessKey.trim() === '' ? undefined : custom.accessKey.trim(),
          accessKeySecret: custom.accessKeySecret.trim() === '' ? undefined : custom.accessKeySecret.trim(),
          account: {
            id: slug(`${route}-${modelId}`),
            label: custom.label.trim() === '' ? `${custom.displayName.trim() || route} / ${modelId}` : custom.label.trim(),
            model: modelId,
            models: [modelId],
            priority: numberOr(custom.priority, 100),
            pricing: pricingOf(custom.priceIn, custom.priceOut),
            balance: balanceOf(custom.probe, custom.apiKeyEnv, route, {
              id: custom.accessKeyEnv,
              secret: custom.accessKeySecretEnv,
            }, custom.startAmount, {
              url: custom.balanceUrl,
              baseUrl: custom.balanceBaseUrl,
              jsonPath: custom.balanceJsonPath,
              availablePath: custom.balanceAvailablePath,
              currency: custom.balanceCurrency,
            }),
            quota: quotaOf(custom),
            siteUrl: siteFor(route) || undefined,
            ...(warn === undefined ? {} : { warnBelow: warn }),
            ...(critical === undefined ? {} : { criticalBelow: critical }),
          },
        })
      }

      /**
       * Remove one monitored account after confirmation.
       * @param {string} id - account id.
       * @returns {Promise<void>}
       */
      async function remove(id) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm('从额度监控中移除这个账户？如果它是该提供方的最后一个账户，提供方路由也会一并释放（该平台将无法再被调用）。')) return
        await mutate(`${API}/accounts/delete`, { id })
      }

      /**
       * Switch the second-level failover between health ranking and manual order.
       * @param {'auto' | 'manual'} value - ordering mode.
       * @returns {Promise<void>}
       */
      async function chooseSwitchOrder(value) {
        await mutate(`${API}/switch-order`, { switchOrder: value })
      }

      /**
       * Check the local toolchain and install what the plugin needs (Bailian CLI).
       * @returns {Promise<void>}
       */
      async function setupCli() {
        setBusy(true)
        setError('')
        setSwitchNotice('')
        try {
          const result = await request(`${API}/setup-cli`, {})
          setSwitchNotice(result.ok ? `环境准备完成：${result.detail}` : `环境准备失败：${result.detail}`)
          if (result.needsLogin === true) {
            loginPrompted.current = true
            setLoginPrompt(true)
          }
          const next = await request(`${API}/refresh`, { force: true })
          setSnapshot(next)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Copy the CLI login command to the clipboard.
       * @returns {Promise<void>}
       */
      async function copyLoginCommand() {
        try {
          await navigator.clipboard.writeText('bl auth login --console')
          setSwitchNotice('已复制：bl auth login --console，请到终端执行')
        } catch {
          setSwitchNotice('请手动复制：bl auth login --console')
        }
      }

      /**
       * Re-read the allowances after the user finished logging the CLI in.
       * @returns {Promise<void>}
       */
      async function finishLogin() {
        setBusy(true)
        setError('')
        try {
          const next = await request(`${API}/refresh`, { force: true })
          setSnapshot(next)
          if (next.cli?.needsLogin === true) {
            setSwitchNotice('仍检测到未登录：请确认命令在 dsh 所在的同一 Windows 用户下执行')
          } else {
            setLoginPrompt(false)
            setSwitchNotice('登录已生效，额度已开始读取')
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Remove every monitored model of one platform in one step.
       * @param {string} provider - route id.
       * @param {number} count - models about to be removed.
       * @returns {Promise<void>}
       */
      async function clearPlatform(provider, count) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(`移除该平台下全部 ${count} 个模型？如果这是该提供方的最后一个账户，提供方路由也会一并释放。`)) return
        await mutate(`${API}/accounts/clear`, { provider })
      }

      /**
       * Switch the foreground onto one recommended model.
       * @param {string} provider - provider id.
       * @param {string} model - model id.
       * @returns {Promise<void>}
       */
      async function switchTo(provider, model) {
        setBusy(true)
        setError('')
        setSwitchNotice('')
        try {
          const next = await request(`${API}/switch-model`, { provider, model })
          setSnapshot(next)
          setSwitchNotice(next.switched === 'session'
            ? `已切换到 ${provider} / ${model}，前台模型选择已同步`
            : next.switched === 'default'
              ? `已把 ${provider} / ${model} 设为新会话默认模型；当前会话未能同步${next.switchError === '' || next.switchError === undefined ? '' : `（${next.switchError}）`}`
              : `已登记 ${provider} / ${model}；当前会话无法同步${next.switchError === '' || next.switchError === undefined ? '' : `（${next.switchError}）`}`)
          try {
            const rows = await request(`${API}/recommendations`, { provider })
            if (Array.isArray(rows.models)) setRecommendations({ [provider]: rows.models })
          } catch {
            // Keep the previous list when the refresh fails.
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Open the "existing provider" card prefilled with one stored account.
       * @param {object} account - snapshot account from /state.
       * @returns {void}
       */
      function openEdit(account) {
        const balance = account.balance ?? {}
        const quota = account.quota ?? {}
        setEditingId(account.id)
        setMode('existing')
        setDiscovered([])
        setDiscoverError('')
        setExisting({
          ...blankExisting(),
          provider: account.provider,
          model: account.model,
          label: account.label ?? '',
          probe: balance.kind ?? 'none',
          quotaKind: quota.kind ?? 'none',
          apiKey: '',
          apiKeyEnv: balance.apiKeyEnv ?? '',
          accessKeyEnv: balance.accessKeyEnv ?? '',
          accessKeySecretEnv: balance.accessKeySecretEnv ?? '',
          accessKey: '',
          accessKeySecret: '',
          startAmount: balance.startAmount === undefined ? '' : String(balance.startAmount),
          startTokens: quota.startTokens === undefined ? '' : String(quota.startTokens),
          priceIn: account.pricing?.inputPerMTok === undefined ? '' : String(account.pricing.inputPerMTok),
          priceOut: account.pricing?.outputPerMTok === undefined ? '' : String(account.pricing.outputPerMTok),
          warnBelow: account.warnBelow ?? '',
          criticalBelow: account.criticalBelow ?? '',
          priority: String(account.priority ?? 100),
          siteUrl: account.siteUrl ?? '',
          balanceUrl: balance.url ?? '',
          balanceBaseUrl: balance.baseUrl ?? '',
          balanceJsonPath: balance.jsonPath ?? '',
          balanceAvailablePath: balance.availablePath ?? '',
          balanceCurrency: balance.currency ?? '',
          quotaWarnPercent: String(quota.warnPercent ?? 20),
          quotaCriticalPercent: String(quota.criticalPercent ?? 5),
          quotaProduct: quota.product ?? '',
          quotaUrl: quota.url ?? '',
          quotaJsonPath: quota.jsonPath ?? '',
        })
      }

      const accounts = snapshot === null ? [] : snapshot.accounts
      // Providers whose per-model allowance the CLI can read: their platform
      // card lists every model, not only the monitored ones.
      const suggestionProviders = [...new Set(accounts
        .filter((account) => account.quota !== null && account.quota !== undefined && account.quota.source === 'bailian-free')
        .map((account) => account.provider))].join(',')

      React.useEffect(() => {
        if (suggestionProviders === '') {
          setRecommendations({})
          return undefined
        }
        let cancelled = false
        void (async () => {
          const next = {}
          for (const provider of suggestionProviders.split(',')) {
            try {
              const result = await request(`${API}/recommendations`, { provider })
              if (Array.isArray(result.models)) next[provider] = result.models
            } catch {
              // Suggestions are best-effort; the card explains the failure elsewhere.
            }
          }
          if (!cancelled) setRecommendations(next)
        })()
        return () => { cancelled = true }
      }, [suggestionProviders, snapshot === null ? 0 : snapshot.refreshedAt])

      // Pop the login dialog once when the CLI reports an unauthenticated state,
      // which is usually right after the automatic install.
      React.useEffect(() => {
        if (snapshot === null) return
        if (snapshot.cli?.needsLogin === true && !loginPrompted.current) {
          loginPrompted.current = true
          setLoginPrompt(true)
        }
      }, [snapshot])
      const providers = snapshot === null ? [] : snapshot.providers
      // Route the foreground last asked for, so its account can be marked and
      // lifted to the top instead of leaving the user to guess.
      const current = snapshot === null ? null : snapshot.current ?? null

      /**
       * Probe and quota-source defaults inferred from one route, shared by both
       * ways of registering an account so they never drift apart.
       * @param {string} id - route id.
       * @param {object | undefined} entry - its provider descriptor, when listed.
       * @returns {{probe: string, quotaKind: string}}
       */
      function defaultsFor(id, entry) {
        return {
          // A route that authenticates by login has no key a balance endpoint
          // would accept, so do not promise a number by default.
          probe: entry !== undefined && entry.apiKeyDetected === true ? 'none' : 'auto',
          quotaKind: /ark|volc|coding/.test(id)
            ? 'arkcli-plan'
            : /dashscope|bailian|qwen/.test(id) ? 'bailian-free' : 'none',
        }
      }

      /**
       * Whether an account serves the route currently in use.
       * @param {object} account - snapshot account.
       * @returns {boolean}
       */
      function accountInUse(account) {
        if (current === null) return false
        return account.provider === current.provider
          && (account.model === current.model || (account.models ?? []).includes(current.model))
      }

      const orderedAccounts = snapshot !== null && snapshot.switchOrder === 'manual'
        // Manual mode: the list itself is the failover order.
        ? [...accounts].sort((left, right) => left.priority - right.priority || String(left.id).localeCompare(String(right.id)))
        : [...accounts].sort(
          (left, right) => Number(accountInUse(right)) - Number(accountInUse(left)),
        )
      // The account serving the route in use, when one is monitored.
      const currentAccount = orderedAccounts.find((account) => accountInUse(account))

      /**
       * Human label of one provider route.
       * @param {string} provider - route id.
       * @returns {string}
       */
      function providerLabel(provider) {
        const known = providers.find((entry) => entry.id === provider)
        if (known !== undefined && typeof known.name === 'string' && known.name !== '') return known.name
        const first = accounts.find((account) => account.provider === provider)
        return first === undefined ? provider : first.label
      }

      /**
       * Remaining headroom used to order the models of one platform.
       * @param {object} account - snapshot account.
       * @returns {number}
       */
      function balanceScore(account) {
        return account.quota === null || account.quota === undefined
          ? Number(account.remaining ?? 0)
          : Number(account.remainingPercent ?? 0)
      }

      /**
       * Monitored accounts grouped by provider, with unregistered route models
       * appended so one platform reads as one card. Rows are sorted by remaining
       * balance, highest first.
       */
      const accountGroups = (() => {
        const groups = new Map()
        for (const account of orderedAccounts) {
          const group = groups.get(account.provider) ?? { provider: account.provider, accounts: [], extras: [], entries: [] }
          group.accounts.push(account)
          groups.set(account.provider, group)
        }
        for (const [provider, rows] of Object.entries(recommendations)) {
          const group = groups.get(provider)
          if (group === undefined) continue
          for (const row of rows) {
            const known = group.accounts.some((account) => account.model === row.model || (account.models ?? []).includes(row.model))
            if (!known) group.extras.push(row)
          }
        }
        for (const group of groups.values()) {
          group.entries = [
            ...group.accounts.map((account) => ({ kind: 'account', score: balanceScore(account), account })),
            ...group.extras.map((row) => ({ kind: 'extra', score: Number(row.remainingPercent ?? 0), row })),
          ].sort((left, right) => right.score - left.score)
        }
        return [...groups.values()]
      })()

      /**
       * Open the "add model" form already pointed at one provider.
       * @param {string} provider - route id.
       * @returns {void}
       */
      function addModelTo(provider) {
        setEditingId(null)
        setMode('existing')
        setDiscovered([])
        setDiscoverError('')
        const entry = providers.find((item) => item.id === provider)
        // Reuse the same defaults as picking the provider by hand, so a model
        // added from a platform card keeps the platform's quota source instead
        // of silently falling back to “not queried”.
        setExisting({
          ...blankExisting(),
          provider,
          apiKeyEnv: autoRef(provider),
          label: entry?.name ?? provider,
          siteUrl: siteFor(provider) || '',
          ...defaultsFor(provider, entry),
        })
        void discoverProvider(provider)
      }

      /**
       * Remaining amount of an account as display text.
       * @param {object} account - snapshot account.
       * @returns {string}
       */
      function remainingText(account) {
        if (account.quota !== null && account.quota !== undefined) {
          return `${Number(account.remainingPercent ?? 0).toFixed(1)}%`
        }
        return money(account.remaining, account.currency)
      }
      // The picker only offers routes that already have an account in this
      // section, so unrelated adapters do not clutter the list. The toggle
      // below reveals every registered route again.
      const monitoredIds = new Set(accounts.map((account) => account.provider))
      const selectableProviders = allProviders || accounts.length === 0
        ? providers
        : providers.filter((provider) => monitoredIds.has(provider.id))
      const selectedProvider = existing.provider === '' ? undefined : providers.find((provider) => provider.id === existing.provider)
      const loginAuth = selectedProvider !== undefined
        && selectedProvider.apiKeyDetected === true
        && existing.probe !== 'aliyun'
      const presetEntry = PROVIDER_PRESETS.find((entry) => entry.value === preset)
      const presetNote = presetEntry?.note ?? ''
      // A preset whose route already exists cannot be created again; the user
      // should register the account on the existing route instead.
      const presetRouteTaken = presetEntry?.route !== undefined
        && providers.some((provider) => provider.id === presetEntry.route)
      const discoveryReady = mode === 'existing'
        ? existing.provider !== ''
        : custom.route.trim() !== '' || custom.baseURL.trim() !== ''
      /**
       * Monitoring badge for one discovered model.
       *
       * The platform's `/models` reply carries no quota fields, so the only
       * remaining figure available while listing is the one this plugin already
       * tracks for that model.
       *
       * @param {string} modelId - model id.
       * @returns {string} suffix appended to the chip label.
       */
      function monitoringBadge(modelId) {
        const row = freeQuota.find((entry) => entry.model === modelId)
        if (row !== undefined) {
          return row.hasQuota === false
            ? ' · 免费额度已用完'
            : ` · 剩余 ${Number(row.remainingPercent ?? 0).toFixed(1)}%（实测）`
        }
        const provider = mode === 'existing' ? existing.provider : custom.route.trim()
        if (provider === '') return ''
        const account = accounts.find((entry) => entry.provider === provider
          && (entry.model === modelId || (entry.models ?? []).includes(modelId)))
        if (account === undefined) return ' · 未监控'
        if (account.quota === null || account.quota === undefined) {
          return ` · 剩余 ${money(account.remaining, account.currency)}`
        }
        return ` · 剩余 ${Number(account.remainingPercent ?? 0).toFixed(1)}%`
      }

      const kindCounts = new Map()
      for (const model of discovered) {
        const kind = kindOfModel(model)
        kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
      }
      const llmDiscovered = kindCounts.get('text') ?? 0
      const visibleDiscovered = kindFilter === 'all'
        ? discovered
        : discovered.filter((model) => kindOfModel(model) === kindFilter)
      // How many of the listed models actually carry a free allowance.
      const quotaMatched = discovered.filter((model) => freeQuota.some((row) => row.model === model.id)).length
      const modelsBlock = h('div', { className: 'qg-models' },
        h('div', { className: 'qg-models-head' },
          h('button', {
            type: 'button',
            className: 'qg-btn',
            disabled: busy || discoverBusy || !discoveryReady,
            onClick: () => { void discoverModels() },
          }, discoverBusy ? '获取中…' : '获取模型列表'),
          mode === 'existing' && editingId === null && addableModels().length > 0
            ? h('button', {
              type: 'button',
              className: 'qg-btn',
              disabled: busy,
              onClick: () => { void addAllModels() },
            }, `全部加入（${addableModels().length} 个）`)
            : null,
          h('span', { className: 'qg-hint' }, discovered.length === 0
            ? '从端点读取可用模型，点一下填入表单'
            : `共 ${discovered.length} 个，语言模型 ${llmDiscovered} 个${quotaMatched === 0 ? '' : `，其中有免费额度 ${quotaMatched} 个`}`)),
        discoverError === '' ? null : h('div', { className: 'qg-error' }, discoverError),
        // A platform's catalog mixes chat, embedding, rerank, image, video and
        // speech models; filtering keeps the picker readable and lets an account
        // be created for a non-chat model when that is what the platform bills.
        discovered.length === 0 ? null : h('div', { className: 'qg-chips qg-kind-chips' },
          KIND_FILTERS.map(([kind, label]) => {
            const count = kind === 'all' ? discovered.length : (kindCounts.get(kind) ?? 0)
            if (count === 0) return null
            return h('button', {
              key: kind,
              type: 'button',
              className: kindFilter === kind ? 'qg-chip qg-chip-on' : 'qg-chip',
              onClick: () => setKindFilter(kind),
            }, `${label} ${count}`)
          })),
        discovered.length > 0 && visibleDiscovered.length === 0
          ? h('div', { className: 'qg-hint' }, '该分类下没有模型，换一个分类看看')
          : null,
        discovered.length === 0 ? null : h('div', { className: 'qg-chips' }, visibleDiscovered.map((model) => {
          const selected = mode === 'existing' ? existing.model === model.id : custom.modelId === model.id
          const label = typeof model.name === 'string' && model.name !== '' && model.name !== model.id
            ? `${model.name}（${model.id}）`
            : model.id
          return h('button', {
            key: model.id,
            type: 'button',
            className: selected ? 'qg-chip qg-chip-on' : 'qg-chip',
            title: [
              model.contextWindow === undefined ? '' : `上下文 ${model.contextWindow}`,
              model.maxTokens === undefined ? '' : `输出 ${model.maxTokens}`,
            ].filter((part) => part !== '').join(' · '),
            onClick: () => pickModel(model),
          }, `${label}${monitoringBadge(model.id)}`)
        })))

      return h('div', { className: 'qg-root' },
        h('div', { className: 'qg-head' },
          h('div', null,
            h('div', { className: 'qg-title' }, '模型额度'),
            h('div', { className: 'qg-desc' }, current === null
              ? '监控各平台模型账户的余额；跌破阈值时预警，并把新请求自动改投到更健康的账户。'
              : `当前使用 ${current.provider} / ${current.model}${currentAccount === undefined
                ? '（未纳入监控）'
                : ` · 剩余 ${remainingText(currentAccount)}`}；跌破阈值时预警，并把新请求自动改投到更健康的账户。`),
            snapshot !== null && snapshot.pendingSwitch
              ? h('div', { className: 'qg-hint', style: { marginTop: '6px' } },
                `已判定当前模型不可用：下一次请求会自动改投到 ${snapshot.pendingSwitch.provider} / ${snapshot.pendingSwitch.model}`
                + `（若同平台还有未登记但有免费额度的模型，会先切到它们，dsh 里的模型选择不会自行变化）。`)
              : null),
          h('div', { className: 'qg-actions' },
            h('button', {
              className: 'qg-btn',
              disabled: busy,
              title: '页面每 15 秒会自动刷新，过期数据无需手动刷新',
              onClick: () => { void mutate(`${API}/refresh`, { force: true }) },
            }, busy ? '处理中…' : '刷新余额'),
            h('button', {
              className: 'qg-btn qg-btn-primary',
              disabled: busy,
              onClick: () => {
                if (mode === null) {
                  setExisting(blankExisting())
                  setEditingId(null)
                  setMode('existing')
                } else {
                  setMode(null)
                  setEditingId(null)
                }
                setDiscovered([])
                setDiscoverError('')
              },
            }, mode === null ? '添加模型' : '收起'))),

        h('div', { className: 'qg-switch' },
          h('span', null, '二级切换顺序'),
          h('button', {
            type: 'button',
            className: snapshot !== null && snapshot.switchOrder === 'manual' ? 'qg-btn' : 'qg-btn qg-tab-on',
            disabled: busy,
            onClick: () => { void chooseSwitchOrder('auto') },
          }, '自动（按健康度）'),
          h('button', {
            type: 'button',
            className: snapshot !== null && snapshot.switchOrder === 'manual' ? 'qg-btn qg-tab-on' : 'qg-btn',
            disabled: busy,
            onClick: () => { void chooseSwitchOrder('manual') },
          }, '手动（按优先级）'),
          h('span', { className: 'qg-hint' }, snapshot !== null && snapshot.switchOrder === 'manual'
            ? '手动模式按编辑里的「优先级」在同一平台内决定切换顺序；列表始终按余额从高到低展示'
            : '自动模式按健康度、优先级、剩余额度排序；列表按余额从高到低展示')),

        error === '' ? null : h('div', { className: 'qg-error' }, error),
        switchNotice === '' ? null : h('div', { className: 'qg-ok' }, switchNotice),
        snapshot !== null && snapshot.lastSwitch !== null && snapshot.lastSwitch !== undefined
          && snapshot.lastSwitch.mode !== 'session'
          ? h('div', { className: 'qg-error' },
            `上次一键切换 ${snapshot.lastSwitch.provider} / ${snapshot.lastSwitch.model} 未同步前台：`
            + `${snapshot.lastSwitch.reason === '' ? '未知原因' : snapshot.lastSwitch.reason}`)
          : null,

        mode === null ? null : h('form', {
          className: 'qg-form',
          onSubmit: mode === 'existing' ? submitExisting : submitCustom,
        },
        h('div', { className: 'qg-tabs' },
          h('button', {
            type: 'button',
            className: mode === 'existing' ? 'qg-tab qg-tab-on' : 'qg-tab',
            onClick: () => {
              setMode('existing')
              setDiscovered([])
              setDiscoverError('')
            },
          }, '使用已有提供方'),
          h('button', {
            type: 'button',
            className: mode === 'custom' ? 'qg-tab qg-tab-on' : 'qg-tab',
            onClick: () => {
              setMode('custom')
              setEditingId(null)
              setDiscovered([])
              setDiscoverError('')
            },
          }, '新建提供方')),

        mode === 'existing'
          ? h('div', { className: 'qg-grid' },
            editingId === null ? null : h('div', { className: 'qg-hint', style: { gridColumn: '1 / -1' } },
              `正在编辑账户 ${editingId}：保存后立即生效，表单未覆盖的字段保持原值。`),
            editingId === null ? null : field('账户 ID', h('input', {
              className: 'qg-input',
              value: editingId,
              disabled: true,
            }), '创建后不可修改；更改提供方或主模型会立刻影响路由匹配'),
            selectField('提供方', existing.provider, [
              { value: '', label: selectableProviders.length === 0 ? '（没有已注册的提供方）' : '请选择…' },
              ...selectableProviders.map((provider) => ({ value: provider.id, label: `${provider.name}（${provider.id}）` })),
            ], (next) => selectProvider(next)),
            field('API Key', h('input', {
              className: 'qg-input',
              type: 'password',
              value: existing.apiKey,
              placeholder: providerRef(existing.provider) === undefined
                ? '粘贴该平台的 API Key'
                : '已配置，留空则不修改',
              onChange: (event) => setExisting({ ...existing, apiKey: event.target.value }),
            }), '只需填这一次，插件会存入 dsh 凭据库；其余接入参数已按平台自动配置'),
            field('提供方范围', h('label', {
              className: 'qg-hint',
              style: { display: 'flex', alignItems: 'center', gap: '6px' },
            },
            h('input', {
              type: 'checkbox',
              checked: allProviders,
              onChange: (event) => setAllProviders(event.target.checked),
            }),
            '显示未接入监控的提供方'), '默认只列出已有监控账户的提供方'),
            field('模型 ID', h('input', {
              className: 'qg-input',
              value: existing.model,
              placeholder: 'deepseek-v4-flash',
              onChange: (event) => setExisting({ ...existing, model: event.target.value }),
            })),
            field('显示名', h('input', {
              className: 'qg-input',
              value: existing.label,
              placeholder: '可选',
              onChange: (event) => setExisting({ ...existing, label: event.target.value }),
            })),
            h('details', { className: 'qg-advanced' },
              h('summary', null, '高级设置（已按平台自动配置，通常无需修改）'),
              h('div', { className: 'qg-grid' },
            selectField('余额探针', existing.probe, PROBE_OPTIONS, (next) => setExisting({ ...existing, probe: next })),
            existing.probe === 'none'
              ? field('期初余额', h('input', {
                className: 'qg-input',
                value: existing.startAmount,
                inputMode: 'decimal',
                placeholder: '可选，如 50',
                onChange: (event) => setExisting({ ...existing, startAmount: event.target.value }),
              }), '官网当前余额；之后按本地累计花费递减，需同时填单价')
              : null,
            existing.probe === 'aliyun'
              ? field('AccessKey ID 引用', h('input', {
                className: 'qg-input',
                value: existing.accessKeyEnv,
                placeholder: 'ALIYUN_ACCESS_KEY_ID',
                onChange: (event) => setExisting({ ...existing, accessKeyEnv: event.target.value }),
              }), '阿里云 AccessKey 的变量名，不是密钥本身')
              : null,
            existing.probe === 'aliyun'
              ? field('AccessKey Secret 引用', h('input', {
                className: 'qg-input',
                value: existing.accessKeySecretEnv,
                placeholder: 'ALIYUN_ACCESS_KEY_SECRET',
                onChange: (event) => setExisting({ ...existing, accessKeySecretEnv: event.target.value }),
              }), '需要 AliyunBSSReadOnlyAccess 权限')
              : null,
            existing.probe === 'aliyun'
              ? field('AccessKey ID', h('input', {
                className: 'qg-input',
                value: existing.accessKey,
                placeholder: '可选：填写后存入上面这个引用',
                onChange: (event) => setExisting({ ...existing, accessKey: event.target.value }),
              }), '已在凭据库中时可留空')
              : null,
            existing.probe === 'aliyun'
              ? field('AccessKey Secret', h('input', {
                className: 'qg-input',
                type: 'password',
                value: existing.accessKeySecret,
                placeholder: '可选：填写后存入上面这个引用',
                onChange: (event) => setExisting({ ...existing, accessKeySecret: event.target.value }),
              }), '已在凭据库中时可留空')
              : null,
            existing.probe === 'http'
              ? field('余额接口 URL', h('input', {
                className: 'qg-input',
                value: existing.balanceUrl,
                placeholder: 'https://gateway.example/balance',
                onChange: (event) => setExisting({ ...existing, balanceUrl: event.target.value }),
              }), 'HTTP 探针的完整地址')
              : null,
            existing.probe === 'http'
              ? field('余额 JSON 路径', h('input', {
                className: 'qg-input',
                value: existing.balanceJsonPath,
                placeholder: 'data.remaining',
                onChange: (event) => setExisting({ ...existing, balanceJsonPath: event.target.value }),
              }), '从响应 JSON 提取剩余量的路径')
              : null,
            existing.probe === 'http'
              ? field('可用余额 JSON 路径（可选）', h('input', {
                className: 'qg-input',
                value: existing.balanceAvailablePath,
                placeholder: 'data.available',
                onChange: (event) => setExisting({ ...existing, balanceAvailablePath: event.target.value }),
              }))
              : null,
            existing.probe === 'http'
              ? field('Base URL（可选）', h('input', {
                className: 'qg-input',
                value: existing.balanceBaseUrl,
                placeholder: 'https://gateway.example',
                onChange: (event) => setExisting({ ...existing, balanceBaseUrl: event.target.value }),
              }))
              : null,
            existing.probe === 'http'
              ? field('币种（可选）', h('input', {
                className: 'qg-input',
                value: existing.balanceCurrency,
                placeholder: 'CNY',
                onChange: (event) => setExisting({ ...existing, balanceCurrency: event.target.value }),
              }))
              : null,
            selectField('额度来源', existing.quotaKind, QUOTA_OPTIONS, (next) => setExisting({ ...existing, quotaKind: next })),
            existing.quotaKind !== 'none'
              ? field('额度预警线（%）', h('input', {
                className: 'qg-input',
                value: existing.quotaWarnPercent,
                inputMode: 'decimal',
                onChange: (event) => setExisting({ ...existing, quotaWarnPercent: event.target.value }),
              }), '剩余百分比低于该值进入预警')
              : null,
            existing.quotaKind !== 'none'
              ? field('额度切换线（%）', h('input', {
                className: 'qg-input',
                value: existing.quotaCriticalPercent,
                inputMode: 'decimal',
                onChange: (event) => setExisting({ ...existing, quotaCriticalPercent: event.target.value }),
              }), '低于该值自动切换并阻断该账户')
              : null,
            existing.quotaKind === 'tokens'
              ? field('期初 token 额度', h('input', {
                className: 'qg-input',
                value: existing.startTokens,
                inputMode: 'numeric',
                placeholder: '默认 1000000',
                onChange: (event) => setExisting({ ...existing, startTokens: event.target.value }),
              }), '该模型剩余的 token 额度；之后按本地用量递减')
              : null,
            existing.quotaKind === 'bailian-free'
              ? h('div', { className: 'qg-hint', style: { gridColumn: '1 / -1' } },
                '需要本机已安装并登录百炼 CLI：npm i -g bailian-cli，然后 bl auth login --console。')
              : null,
            existing.quotaKind === 'arkcli-plan'
              ? field('套餐产品', h('input', { className: 'qg-input', value: 'coding-plan', disabled: true }), 'arkcli 探针目前只支持 coding-plan')
              : null,
            existing.quotaKind === 'http'
              ? field('额度接口 URL', h('input', {
                className: 'qg-input',
                value: existing.quotaUrl,
                placeholder: 'https://gateway.example/quota',
                onChange: (event) => setExisting({ ...existing, quotaUrl: event.target.value }),
              }))
              : null,
            existing.quotaKind === 'http'
              ? field('额度 JSON 路径', h('input', {
                className: 'qg-input',
                value: existing.quotaJsonPath,
                placeholder: 'data.remaining',
                onChange: (event) => setExisting({ ...existing, quotaJsonPath: event.target.value }),
              }))
              : null,
            existing.quotaKind === 'http'
              ? field('额度产品（可选）', h('input', {
                className: 'qg-input',
                value: existing.quotaProduct,
                placeholder: 'coding-plan',
                onChange: (event) => setExisting({ ...existing, quotaProduct: event.target.value }),
              }))
              : null,
            loginAuth
              ? h('div', { className: 'qg-hint' },
                '该提供方没有声明 API Key（使用登录鉴权），余额接口可能返回 401；可改用「不查询（错误码驱动）」。')
              : null,
            field('凭据引用', h('input', {
              className: 'qg-input',
              value: existing.apiKeyEnv,
              placeholder: autoRef(existing.provider) || '变量名，如 DEEPSEEK_API_KEY',
              onChange: (event) => setExisting({ ...existing, apiKeyEnv: event.target.value }),
            }), '留空则用该提供方已声明的引用；这里填变量名，不要粘贴密钥'),
            field('预警阈值', h('input', {
              className: 'qg-input',
              value: existing.warnBelow,
              inputMode: 'decimal',
              onChange: (event) => setExisting({ ...existing, warnBelow: event.target.value }),
            })),
            field('切换阈值', h('input', {
              className: 'qg-input',
              value: existing.criticalBelow,
              inputMode: 'decimal',
              onChange: (event) => setExisting({ ...existing, criticalBelow: event.target.value }),
            })),
            field('输入单价', h('input', {
              className: 'qg-input',
              value: existing.priceIn,
              inputMode: 'decimal',
              placeholder: '可选，如 2',
              onChange: (event) => setExisting({ ...existing, priceIn: event.target.value }),
            }), '每百万 token，用于计算每次花费'),
            field('输出单价', h('input', {
              className: 'qg-input',
              value: existing.priceOut,
              inputMode: 'decimal',
              placeholder: '可选，如 8',
              onChange: (event) => setExisting({ ...existing, priceOut: event.target.value }),
            }), '每百万 token，留空则不计输出费'),
            field('优先级', h('input', {
              className: 'qg-input',
              value: existing.priority,
              inputMode: 'numeric',
              onChange: (event) => setExisting({ ...existing, priority: event.target.value }),
            }), '数字越小越优先'),
            field('官网查询链接', h('input', {
              className: 'qg-input',
              value: existing.siteUrl,
              placeholder: siteFor(existing.provider) || 'https://…',
              onChange: (event) => setExisting({ ...existing, siteUrl: event.target.value }),
            }), '余额不可查时展示在账户卡片上；新建时留空按提供方自动推导，编辑时留空则清除'))))
          : h('div', { className: 'qg-grid' },
            selectField('平台预设', preset, PROVIDER_PRESETS.map((entry) => ({ value: entry.value, label: entry.label })), applyPreset),
            presetNote === ''
              ? null
              : h('div', { className: 'qg-hint', style: { gridColumn: '1 / -1' } }, presetNote),
            presetRouteTaken
              ? h('div', { className: 'qg-hint', style: { gridColumn: '1 / -1' } },
                `此平台已有路由 ${presetEntry.route}，不需要新建：`,
                h('button', {
                  className: 'qg-btn',
                  type: 'button',
                  style: { marginLeft: '8px' },
                  onClick: () => {
                    selectProvider(presetEntry.route)
                    setEditingId(null)
                    setMode('existing')
                  },
                }, '改用「已有提供方」'))
              : null,
            field('Provider ID', h('input', {
              className: 'qg-input',
              value: custom.route,
              placeholder: 'my-gateway',
              onChange: (event) => {
                const route = event.target.value
                const previousAuto = custom.apiKeyEnv === '' ? '' : autoRef(custom.route) || defaultRef(custom.route)
                const derived = route.trim() === '' ? '' : autoRef(route) || defaultRef(route)
                setCustom({
                  ...custom,
                  route,
                  apiKeyEnv: custom.apiKeyEnv === '' || custom.apiKeyEnv === previousAuto ? derived : custom.apiKeyEnv,
                })
                setDiscovered([])
                setDiscoverError('')
              },
            }), '小写字母开头，可含数字和连字符'),
            field('显示名', h('input', {
              className: 'qg-input',
              value: custom.displayName,
              placeholder: '可选',
              onChange: (event) => setCustom({ ...custom, displayName: event.target.value }),
            })),
            selectField('API 协议', custom.api, PROTOCOL_OPTIONS.map((value) => ({ value, label: value })), (next) => setCustom({ ...custom, api: next })),
            field('Base URL', h('input', {
              className: 'qg-input',
              value: custom.baseURL,
              placeholder: 'https://gateway.example/v1',
              onChange: (event) => setCustom({ ...custom, baseURL: event.target.value }),
            })),
            field('API Key', h('input', {
              className: 'qg-input',
              type: 'password',
              value: custom.apiKey,
              placeholder: '留空则依赖提供方原生认证',
              onChange: (event) => setCustom({ ...custom, apiKey: event.target.value }),
            })),
            field('模型 ID', h('input', {
              className: 'qg-input',
              value: custom.modelId,
              placeholder: 'my-model',
              onChange: (event) => setCustom({ ...custom, modelId: event.target.value }),
            })),
            field('模型显示名', h('input', {
              className: 'qg-input',
              value: custom.modelName,
              placeholder: '可选',
              onChange: (event) => setCustom({ ...custom, modelName: event.target.value }),
            })),
            field('上下文窗口', h('input', {
              className: 'qg-input',
              value: custom.contextWindow,
              inputMode: 'numeric',
              placeholder: '可选，如 262144',
              onChange: (event) => setCustom({ ...custom, contextWindow: event.target.value }),
            })),
            field('输出上限', h('input', {
              className: 'qg-input',
              value: custom.maxTokens,
              inputMode: 'numeric',
              placeholder: '可选，如 32768',
              onChange: (event) => setCustom({ ...custom, maxTokens: event.target.value }),
            })),
            field('账户显示名', h('input', {
              className: 'qg-input',
              value: custom.label,
              placeholder: '可选',
              onChange: (event) => setCustom({ ...custom, label: event.target.value }),
            })),
            selectField('余额探针', custom.probe, PROBE_OPTIONS, (next) => setCustom({ ...custom, probe: next })),
            custom.probe === 'none'
              ? field('期初余额', h('input', {
                className: 'qg-input',
                value: custom.startAmount,
                inputMode: 'decimal',
                placeholder: '可选，如 50',
                onChange: (event) => setCustom({ ...custom, startAmount: event.target.value }),
              }), '官网当前余额；之后按本地累计花费递减，需同时填单价')
              : null,
            custom.probe === 'aliyun'
              ? field('AccessKey ID 引用', h('input', {
                className: 'qg-input',
                value: custom.accessKeyEnv,
                placeholder: 'ALIYUN_ACCESS_KEY_ID',
                onChange: (event) => setCustom({ ...custom, accessKeyEnv: event.target.value }),
              }), '阿里云 AccessKey 的变量名，不是密钥本身')
              : null,
            custom.probe === 'aliyun'
              ? field('AccessKey Secret 引用', h('input', {
                className: 'qg-input',
                value: custom.accessKeySecretEnv,
                placeholder: 'ALIYUN_ACCESS_KEY_SECRET',
                onChange: (event) => setCustom({ ...custom, accessKeySecretEnv: event.target.value }),
              }), '需要 AliyunBSSReadOnlyAccess 权限')
              : null,
            custom.probe === 'aliyun'
              ? field('AccessKey ID', h('input', {
                className: 'qg-input',
                value: custom.accessKey,
                placeholder: '可选：填写后直接存入凭据库',
                onChange: (event) => setCustom({ ...custom, accessKey: event.target.value }),
              }), '已有凭据时可留空')
              : null,
            custom.probe === 'aliyun'
              ? field('AccessKey Secret', h('input', {
                className: 'qg-input',
                type: 'password',
                value: custom.accessKeySecret,
                placeholder: '可选：填写后直接存入凭据库',
                onChange: (event) => setCustom({ ...custom, accessKeySecret: event.target.value }),
              }), '已有凭据时可留空')
              : null,
            custom.probe === 'http'
              ? field('余额接口 URL', h('input', {
                className: 'qg-input',
                value: custom.balanceUrl,
                placeholder: 'https://gateway.example/balance',
                onChange: (event) => setCustom({ ...custom, balanceUrl: event.target.value }),
              }), 'HTTP 探针的完整地址')
              : null,
            custom.probe === 'http'
              ? field('余额 JSON 路径', h('input', {
                className: 'qg-input',
                value: custom.balanceJsonPath,
                placeholder: 'data.remaining',
                onChange: (event) => setCustom({ ...custom, balanceJsonPath: event.target.value }),
              }), '从响应 JSON 提取剩余量的路径')
              : null,
            custom.probe === 'http'
              ? field('可用余额 JSON 路径（可选）', h('input', {
                className: 'qg-input',
                value: custom.balanceAvailablePath,
                placeholder: 'data.available',
                onChange: (event) => setCustom({ ...custom, balanceAvailablePath: event.target.value }),
              }))
              : null,
            custom.probe === 'http'
              ? field('Base URL（可选）', h('input', {
                className: 'qg-input',
                value: custom.balanceBaseUrl,
                placeholder: 'https://gateway.example',
                onChange: (event) => setCustom({ ...custom, balanceBaseUrl: event.target.value }),
              }))
              : null,
            custom.probe === 'http'
              ? field('币种（可选）', h('input', {
                className: 'qg-input',
                value: custom.balanceCurrency,
                placeholder: 'CNY',
                onChange: (event) => setCustom({ ...custom, balanceCurrency: event.target.value }),
              }))
              : null,
            selectField('额度来源', custom.quotaKind, QUOTA_OPTIONS, (next) => setCustom({ ...custom, quotaKind: next })),
            custom.quotaKind !== 'none'
              ? field('额度预警线（%）', h('input', {
                className: 'qg-input',
                value: custom.quotaWarnPercent,
                inputMode: 'decimal',
                onChange: (event) => setCustom({ ...custom, quotaWarnPercent: event.target.value }),
              }), '剩余百分比低于该值进入预警')
              : null,
            custom.quotaKind !== 'none'
              ? field('额度切换线（%）', h('input', {
                className: 'qg-input',
                value: custom.quotaCriticalPercent,
                inputMode: 'decimal',
                onChange: (event) => setCustom({ ...custom, quotaCriticalPercent: event.target.value }),
              }), '低于该值自动切换并阻断该账户')
              : null,
            custom.quotaKind === 'tokens'
              ? field('期初 token 额度', h('input', {
                className: 'qg-input',
                value: custom.startTokens,
                inputMode: 'numeric',
                placeholder: '默认 1000000',
                onChange: (event) => setCustom({ ...custom, startTokens: event.target.value }),
              }), '该模型剩余的 token 额度；之后按本地用量递减')
              : null,
            custom.quotaKind === 'bailian-free'
              ? h('div', { className: 'qg-hint', style: { gridColumn: '1 / -1' } },
                '需要本机已安装并登录百炼 CLI：npm i -g bailian-cli，然后 bl auth login --console。')
              : null,
            custom.quotaKind === 'arkcli-plan'
              ? field('套餐产品', h('input', { className: 'qg-input', value: 'coding-plan', disabled: true }), 'arkcli 探针目前只支持 coding-plan')
              : null,
            custom.quotaKind === 'http'
              ? field('额度接口 URL', h('input', {
                className: 'qg-input',
                value: custom.quotaUrl,
                placeholder: 'https://gateway.example/quota',
                onChange: (event) => setCustom({ ...custom, quotaUrl: event.target.value }),
              }))
              : null,
            custom.quotaKind === 'http'
              ? field('额度 JSON 路径', h('input', {
                className: 'qg-input',
                value: custom.quotaJsonPath,
                placeholder: 'data.remaining',
                onChange: (event) => setCustom({ ...custom, quotaJsonPath: event.target.value }),
              }))
              : null,
            custom.quotaKind === 'http'
              ? field('额度产品（可选）', h('input', {
                className: 'qg-input',
                value: custom.quotaProduct,
                placeholder: 'coding-plan',
                onChange: (event) => setCustom({ ...custom, quotaProduct: event.target.value }),
              }))
              : null,
            field('凭据引用', h('input', {
              className: 'qg-input',
              value: custom.apiKeyEnv,
              placeholder: autoRef(custom.route) || '变量名，如 ARK_API_KEY',
              onChange: (event) => setCustom({ ...custom, apiKeyEnv: event.target.value }),
            }), '留空则自动按 Provider ID 派生；这里填变量名，不要粘贴密钥'),
            field('预警阈值', h('input', {
              className: 'qg-input',
              value: custom.warnBelow,
              inputMode: 'decimal',
              onChange: (event) => setCustom({ ...custom, warnBelow: event.target.value }),
            })),
            field('切换阈值', h('input', {
              className: 'qg-input',
              value: custom.criticalBelow,
              inputMode: 'decimal',
              onChange: (event) => setCustom({ ...custom, criticalBelow: event.target.value }),
            })),
            field('输入单价', h('input', {
              className: 'qg-input',
              value: custom.priceIn,
              inputMode: 'decimal',
              placeholder: '可选，如 2',
              onChange: (event) => setCustom({ ...custom, priceIn: event.target.value }),
            }), '每百万 token，用于计算每次花费'),
            field('输出单价', h('input', {
              className: 'qg-input',
              value: custom.priceOut,
              inputMode: 'decimal',
              placeholder: '可选，如 8',
              onChange: (event) => setCustom({ ...custom, priceOut: event.target.value }),
            }), '每百万 token，留空则不计输出费'),
            field('优先级', h('input', {
              className: 'qg-input',
              value: custom.priority,
              inputMode: 'numeric',
              onChange: (event) => setCustom({ ...custom, priority: event.target.value }),
            }), '数字越小越优先')),

        modelsBlock,

        h('div', { className: 'qg-actions' },
          h('button', { className: 'qg-btn qg-btn-primary', type: 'submit', disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { className: 'qg-btn', type: 'button', disabled: busy, onClick: () => { setMode(null); setEditingId(null) } }, '取消'))),

        accounts.length === 0
          ? h('div', { className: 'qg-empty' },
            snapshot === null
              ? '正在读取状态…'
              : '还没有监控任何账户。点「添加模型」选择现有提供方，或直接新建一个提供方接入。')
          : h('div', { className: 'qg-list' }, accountGroups.map((group) => h('div', { className: 'qg-card', key: group.provider },
            h('div', { className: 'qg-card-top' },
              h('div', null,
                h('div', { className: 'qg-name' },
                  providerLabel(group.provider),
                  group.accounts.some(accountInUse)
                    ? h('span', { className: 'qg-pill qg-pill-ok', style: { marginLeft: '8px' } }, '使用中')
                    : null),
                h('div', { className: 'qg-route' }, group.provider,
                  group.accounts.some((account) => account.quota !== null && account.quota !== undefined
                    && account.quota.source === 'bailian-free') ? ' · 免费额度（实测）' : '')),
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                group.accounts.some((account) => typeof account.note === 'string' && account.note.includes('未安装 bl CLI'))
                  ? h('button', {
                    className: 'qg-btn',
                    disabled: busy,
                    title: '检查并自动安装 bailian-cli',
                    onClick: () => { void setupCli() },
                  }, '安装百炼 CLI')
                  : null,
                h('button', {
                  className: 'qg-btn',
                  disabled: busy,
                  onClick: () => addModelTo(group.provider),
                }, '添加模型'),
                h('button', {
                  className: 'qg-btn qg-btn-danger',
                  disabled: busy,
                  onClick: () => { void clearPlatform(group.provider, group.accounts.length) },
                }, '清空模型'))),
            h('div', { className: 'qg-model-list' }, group.entries.map((entry) => {
              if (entry.kind === 'extra') {
                const row = entry.row
                return h('div', { className: 'qg-model-row', key: `extra-${row.model}` },
                  h('div', { className: 'qg-model-main' },
                    h('span', { className: 'qg-model-name' }, row.model),
                    h('span', { className: 'qg-model-pct' }, `${row.remainingPercent.toFixed(1)}%`),
                    h('span', { className: 'qg-pill qg-pill-ok' }, '可用')),
                  h('div', { className: 'qg-model-actions' },
                    h('button', {
                      className: 'qg-btn',
                      disabled: busy,
                      title: '切换到这个模型并同步前台（自动纳入监控）',
                      onClick: () => { void switchTo(group.provider, row.model) },
                    }, '切换并登记')),
                  h('div', { className: 'qg-model-meta' },
                    row.expires === undefined
                      ? '尚未登记；切换后自动纳入监控'
                      : `${row.expires} 到期；切换后自动纳入监控`))
              }
              const account = entry.account
              return h('div', { className: 'qg-model-row', key: account.id },
                h('div', { className: 'qg-model-main' },
                  h('span', { className: 'qg-model-name' }, account.model),
                  h('span', { className: 'qg-model-pct' }, account.quota === null || account.quota === undefined
                    ? money(account.remaining, account.currency)
                    : `${Number(account.remainingPercent ?? 0).toFixed(1)}%`),
                  h('span', { className: `qg-pill qg-pill-${account.status}` }, STATUS_TEXT[account.status] ?? account.status),
                  accountInUse(account)
                    ? h('span', { className: 'qg-pill qg-pill-ok' }, '使用中')
                    : null,
                  account.stale ? h('span', { className: 'qg-hint' }, '估算') : null),
                h('div', { className: 'qg-model-actions' },
                  accountInUse(account) ? null : h('button', {
                    className: 'qg-btn',
                    disabled: busy,
                    title: '切换到这个模型并同步前台',
                    onClick: () => { void switchTo(account.provider, account.model) },
                  }, '切换'),
                  h('button', {
                    className: 'qg-btn',
                    disabled: busy,
                    onClick: () => openEdit(account),
                  }, '编辑'),
                  h('button', {
                    className: 'qg-btn qg-btn-danger',
                    disabled: busy,
                    onClick: () => { void remove(account.id) },
                  }, '移除')),
                h('div', { className: 'qg-model-meta' },
                  account.quota === null || account.quota === undefined
                    ? `预警 ${account.warnBelow ?? '-'} · 切换 ${account.criticalBelow ?? '-'}`
                    : `预警 ${account.quota.warnPercent}% · 切换 ${account.quota.criticalPercent}%`,
                  ` · 优先级 ${account.priority} · 检查于 ${when(account.checkedAt)}`,
                  typeof account.balance.startAmount === 'number'
                    ? ` · 期初 ${money(account.balance.startAmount, account.currency)}`
                    : '',
                  account.spent > 0 ? ` · 累计花费 ${money(account.spent, account.currency)}` : '',
                  account.note === '' ? '' : ` · ${account.note}`),
                account.quota === null || account.quota === undefined || (account.quota.periods ?? []).length <= 1
                  ? null
                  : h('div', { className: 'qg-quota qg-model-periods' }, account.quota.periods.map((period) => h('div', { className: 'qg-qrow', key: period.label },
                    h('span', null, period.label),
                    h('div', { className: 'qg-bar' },
                      h('div', { className: 'qg-bar-fill', style: { width: `${Math.max(0, Math.min(100, period.remainingPercent))}%` } })),
                    h('span', { className: 'qg-qval' }, `${period.remainingPercent.toFixed(1)}%`)))))
            })),
            group.accounts.some((account) => account.siteUrl !== undefined && account.siteUrl !== '')
              ? h('div', { className: 'qg-hint qg-site' },
                '官网查询：',
                h('a', {
                  href: group.accounts.find((account) => account.siteUrl !== undefined && account.siteUrl !== '').siteUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                }, group.accounts.find((account) => account.siteUrl !== undefined && account.siteUrl !== '').siteUrl))
              : null))),

        snapshot === null || snapshot.storePath === ''
          ? null
          : h('div', { className: 'qg-foot' }, `账户配置保存在 ${snapshot.storePath}`),

        loginPrompt
          ? h('div', { className: 'qg-overlay' },
            h('div', { className: 'qg-modal' },
              h('div', { className: 'qg-name' }, '百炼 CLI 已安装，需要登录'),
              h('div', { className: 'qg-hint' },
                '模型免费额度只能通过官方 CLI 读取。请在终端（与 dsh 同一 Windows 用户）执行下面的命令，完成浏览器登录后回来点「已登录，刷新」。'),
              h('code', { className: 'qg-command' }, 'bl auth login --console'),
              h('div', { className: 'qg-actions', style: { justifyContent: 'flex-end' } },
                h('button', {
                  className: 'qg-btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => { void copyLoginCommand() },
                }, '复制命令'),
                h('button', {
                  className: 'qg-btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => setLoginPrompt(false),
                }, '稍后'),
                h('button', {
                  className: 'qg-btn qg-btn-primary',
                  type: 'button',
                  disabled: busy,
                  onClick: () => { void finishLogin() },
                }, busy ? '检测中…' : '已登录，刷新'))))
          : null)
    }

    /** Required client services. */
    const inject = ['slots']

    /**
     * Register the Settings section.
     * @param {object} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'quota-guard',
        order: 30,
        label: () => '模型额度',
      }, QuotaSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
