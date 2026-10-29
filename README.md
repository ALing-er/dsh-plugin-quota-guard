# dsh-plugin-quota-guard

一个给 dsh（DeepSeek Harness）用的模型额度守卫插件：**看着多个平台的余额/额度，快见底时告警，并且在某个平台额度耗尽时自动把请求切到还有余量的同平台（或同协议）模型上。**

零运行时依赖，服务端与设置页都由插件自身提供。

## 它解决什么问题

用 dsh 跑长任务时，模型请求往往绑在某个平台（provider）的某个模型上。额度用尽的那一刻，任务会因为一个 `QUOTA_EXCEEDED` 错误整段失败——而通常你手上还有别的平台、别的模型、或者同一个平台另一个有免费额度的模型可用。

quota-guard 做的事：

1. **盯着**：按配置的间隔探测每个账户的余额（DeepSeek / Moonshot / 阿里云 BSS / 任意 HTTP 接口）或周期额度（方舟 arkcli 套餐 / 百炼免费额度 / token 记账）。
2. **提前说**：余额低于预警线时发飞书 / 钉钉 / 通用 webhook 告警；设置页里也有完整状态表。
3. **自动切**：请求发出前如果当前账户已 blocked 或状态达到 `critical` / `exhausted`，把请求改投到另一个合格账户；如果额度错误码已经打回来了，就记一笔冷却并从错误里重试。

## 安装

本插件是一个 Cordis 插件包，通过 `package.json` 里的 `dsh.bundle.patch` 声明安装时要插入的 loader 配置：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  }
}
```

`cordis.patch.yml` 大致是这样一行：

```yaml
- insert:
    - id: quota-guard
      name: dsh-plugin-quota-guard
      config:
        intervalMs: 600000
        autoSwitch: true
        switchOrder: auto
        accounts: []
```

装好后在 dsh Web 的**设置 → 模型额度**里就能看到面板；也可以用 `/quota` 命令直接打印状态表。

> 注意：patch 对同一 `id` 的条目是**整行 config 覆盖**，不做深合并。如果你在 profile 里自己写了一段 `quota-guard` 的 config，会整份替换掉包里的默认值。

## 配置

所有字段都是可选的，缺省值如下（改 `cordis.patch.yml` 或在设置页里改）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMs` | `600000`（10 分钟，最小 30000） | 全量刷新间隔 |
| `probeTimeoutMs` | `8000` | 单次余额探测超时 |
| `autoSwitch` | `true` | 是否允许请求前自动改投 |
| `switchOrder` | `auto` | 选路策略：`auto` 按状态/余量，`manual` 按 `priority` |
| `routeFreshMs` | `60000`（最小 5000） | 决策前数据的新鲜度阈值 |
| `autoAdoptModels` | `true` | 同平台还有免费额度的未登记模型，自动推荐/采纳 |
| `switchOnQuotaError` | `true` | 命中 `quotaErrorCodes` 时冷却并重试 |
| `quotaErrorCodes` | `["QUOTA_EXCEEDED"]` | 视为额度耗尽的错误码 |
| `quotaCooldownMs` | `900000`（15 分钟） | 额度错误后的冷却时长 |
| `staleAfterMs` | `21600000`（6 小时） | 超过多久没探测成功就转 `unknown` |
| `alert.minIntervalMs` | `1800000`（30 分钟） | 同类告警去抖 |
| `alert.onSwitch` | `true` | 自动切换时也发 webhook |

每个账户（`accounts[]`）可以配 `provider`、`model`、`models`、`priority`、`warnBelow`、`criticalBelow`、`currency`、`siteUrl`、`pricing`、`balance`、`quota`。

### 账户示例

```yaml
accounts:
  - id: deepseek-v4
    label: DeepSeek V4
    provider: deepseek
    model: deepseek-v4-1-flash-economy-261017
    currency: CNY
    warnBelow: 20
    criticalBelow: 5
    balance:
      kind: deepseek            # 直接读 /user/balance
      apiKeyEnv: DEEPSEEK_API_KEY
    pricing:
      inputPerMTok: 1
      outputPerMTok: 2

  - id: bailian-qwen
    label: 百炼 Qwen
    provider: qwen-token-plan-cn
    model: qwen3-coder-plus
    quota:
      kind: bailian-free        # 走 bailian-cli 读免费额度
```

### 支持的探测方式

余额（`balance.kind`）：

| 值 | 数据来源 |
|---|---|
| `none` | 不探测余额，只按用量估算 |
| `deepseek` | `GET {baseUrl}/user/balance` |
| `moonshot` | `GET {baseUrl}/v1/users/me/balance` |
| `aliyun` | 阿里云 BSS `QueryAccountBalance`（需 `AliyunBSSReadOnlyAccess`） |
| `http` | 任意接口 + `jsonPath` / `availablePath` |

额度（`quota.kind`）：

| 值 | 数据来源 |
|---|---|
| `none` | 不探测 |
| `arkcli-plan` | `arkcli usage plan --format json`（方舟套餐/用量） |
| `bailian-free` | `bailian-cli`（`bl usage free`，读免费额度） |
| `tokens` | 本地记账：起始 token 数减去已用 input/output/cache |
| `http` | 任意接口 + `jsonPath` 数组，按 `remainingPercent` 或 `remaining/total` 算 |

所有探测都遵循**永不抛异常**的约定：失败只会退化成 `unavailable` 并附一句原因（例如「凭据无效或无权查余额」「auth.login_required」），控制器据此把状态降级为 `unknown` 或用用量估算兜底。

## 自动切换是怎么决策的

- 候选账户来自当前请求的 `provider`/`model`，优先**同 provider 同 model**，其次同 provider 内 `models` 声明覆盖该模型的账户。
- 已被 block（冷却中）或状态为 `critical` / `exhausted` 的账户被剔除。
- 排序：同平台优先 → `manual` 模式按 `priority`，`auto` 模式按状态等级（ok < warn < unknown < critical < exhausted）→ 再按剩余量降序。
- 目标是「同一个账户/同一个模型」时不做无意义的切换。

## 数据存哪

状态文件默认 `~/.dsh/quota-guard.json`（`DSH_HOME` 存在时为 `$DSH_HOME/quota-guard.json`），原子写入（临时文件 + rename），记录账户、累计用量、花费锚点和告警去抖状态。API 密钥不写这里——走 dsh 的 credentials 服务。

## 开发

```bash
node --test        # 138 个用例，约 2 秒，零依赖
```

目录：

```
lib/
  index.js        插件入口：事件挂载、命令、路由装配
  controller.js   状态机：探测、记账、选路决策、告警
  api.js          管理 API：账户 CRUD、探测、切换
  routes.js       HTTP 路由注册（12 条）
  client.js       设置页 UI（ModuleLoader + 宿主 React）
  probes.js       余额探针（DeepSeek/Moonshot/阿里云/通用 HTTP）
  quota-probe.js  周期额度探针（arkcli-plan / 通用 HTTP）
  router.js       纯函数选路
  alerts.js       告警文案、状态表、webhook 投递
  store.js        JSON 原子持久化
  config.js       默认值与校验
test/             对应各模块的单元测试
cordis.patch.yml  安装时注入的 loader 配置
```

## License

MIT
