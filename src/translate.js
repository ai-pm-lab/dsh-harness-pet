/**
 * translate.js — 英译中
 *
 * 三种接口，由 translate-config.js 决定用哪个：
 *   1. MyMemory  （免费、无需 key，实测可用）
 *   2. Google 的 translate_a/single 免费端点（免费，部分网络下不通）
 *   3. **任意 OpenAI 兼容接口**（DeepSeek / OpenAI / Kimi / 本地 Ollama…）
 *      在配置文件里填 baseUrl + key + model 即可。
 *
 * 选定的接口失败时会**自动退到其他接口** —— 配的大模型偶尔抽风时，
 * 至少还能翻出来，而不是干脆不显示。
 *
 * ⚠️ 隐私：选中的文字会发到第三方服务器。这一点在 README 里写明了，
 * 用户可以在设置里关掉整个功能。
 */

'use strict'

/** 单个请求的超时。翻译接口偶尔会卡住，不能让它拖死轮询。 */
const TIMEOUT_MS = 8000
/** 大模型比翻译接口慢得多，给宽一点 */
const LLM_TIMEOUT_MS = 10000
/** 大模型失败后的冷却时长。到点自动重试，key 修好了不用重启。 */
const FAIL_COOLDOWN_MS = 60000

/** 结果缓存。同一个词反复划到不该反复请求。 */
const CACHE_LIMIT = 300
const cache = new Map()

function cacheGet (key) {
  if (!cache.has(key)) return null
  // 命中后挪到末尾，实现最粗略的 LRU
  const value = cache.get(key)
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheSet (key, value) {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
}

async function requestJson (url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 有些端点会拒绝没有 UA 的请求
        'User-Agent': 'Mozilla/5.0 (Macintosh) dsh-pet/0.1',
        Accept: 'application/json, text/plain, */*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** MyMemory：免费、无 key。单次上限约 500 字节。 */
async function viaMyMemory (text, from, to) {
  const url = 'https://api.mymemory.translated.net/get'
    + `?q=${encodeURIComponent(text)}`
    + `&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`
  const data = await requestJson(url)
  const out = data?.responseData?.translatedText
  if (typeof out !== 'string' || !out.trim()) throw new Error('空结果')
  // MyMemory 在超限时会返回一句英文告警，当作失败处理
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('超出限额')
  return out
}

/** Google 的免费端点。返回的是嵌套数组，结构不稳定，取值时层层兜底。 */
async function viaGoogle (text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t`
    + `&q=${encodeURIComponent(text)}`
  const data = await requestJson(url)
  const segments = Array.isArray(data?.[0]) ? data[0] : []
  const out = segments.map((s) => (Array.isArray(s) ? s[0] : '')).join('')
  if (!out.trim()) throw new Error('空结果')
  return out
}

/**
 * 任意 OpenAI 兼容接口。
 *
 * 用 /chat/completions 而不是各家自己的协议 —— DeepSeek、OpenAI、Kimi、
 * 本地 Ollama 都兼容它，用户换服务商只要改 baseUrl 和 model。
 */
async function viaLlm (text, from, to, cfg) {
  const { baseUrl, apiKey, model, prompt } = cfg.llm
  if (!apiKey) throw new Error('配置文件里没填 llm.apiKey')

  const body = {
    model,
    messages: [{ role: 'user', content: prompt.replace('{text}', text) }],
    temperature: 0.2,      // 翻译要稳定，不要发挥
    stream: false,
    // ⚠️ **必须显式给 max_tokens。**
    //
    //    不给的话用服务端的默认值，而各家的默认差很多（有的只有 512）——
    //    长段落翻译到一半就被**硬截断**，而且**不报错**。
    //    用户看到的是译文末尾突然冒出半句英文，比如
    //    `…the composer Vision control's responsive-design fix (is…`
    //    （实测报上来的就是这个）。
    //
    //    2048 tokens ≈ 1500 个汉字，而原文上限是 1200 字符（见 shouldTranslate 附近），
    //    翻成中文远用不到这么多 —— 给足余量，不必担心超。
    max_tokens: 2048,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // 把响应体带上 —— 401/404 之类的排查全靠它。**注意别把 key 打出去**，
      // 这里只取服务端返回的内容，请求头不进日志。
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`)
    }
    const data = await res.json()
    const out = data?.choices?.[0]?.message?.content
    if (typeof out !== 'string' || !out.trim()) throw new Error('空结果')
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** 不需要任何配置的免费接口，兜底用 */
const PROVIDERS_FREE = [
  { id: 'mymemory', name: 'MyMemory', run: viaMyMemory },
  { id: 'google', name: 'Google', run: viaGoogle },
]

/**
 * 测一个配置通不通。给设置弹窗的「测试」按钮用。
 *
 * 真发一次最小请求，**只测大模型**（免费接口不需要测，永远可用）。
 * 返回耗时，好让用户对"慢不慢"有个概念。
 *
 * ⚠️ 失败时把原因带回去，但**绝不回显 apiKey** ——
 * 服务端的错误响应里理论上不该有 key，但也不能假设。
 */
async function testConnection (config) {
  const startedAt = Date.now()
  try {
    await viaLlm('hello', 'en', 'zh-CN', config)
    return { ok: true, ms: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: sanitizeError(describeFetchError(error), config?.llm?.apiKey),
    }
  }
}

/**
 * 把 Node fetch 的错误翻译成人能看懂的话。
 *
 * ⚠️ 为什么需要这一步：
 * Node 的 fetch 失败时，`error.message` **永远只是 "fetch failed"** ——
 * 真正的原因（DNS 解析不了？连接被拒？证书过期？）藏在 `error.cause` 里。
 * 直接把 message 抛给用户，界面上就只会显示"fetch failed"，
 * 等于什么都没说。
 *
 * 踩坑记录：设置弹窗的测试按钮上就显示成了
 * 「测试失败，请检查网络或API：fetch failed」—— 后面那半句毫无帮助。
 */
function describeFetchError (error) {
  if (error?.name === 'AbortError') return `请求超时（${LLM_TIMEOUT_MS / 1000} 秒）`

  const cause = error?.cause
  const code = cause?.code ?? error?.code

  const byCode = {
    // ⚠️ ENOTFOUND 同时对应"域名写错"和"完全没网"两种情况，
    // 从这个错误码本身分不出来。所以文案必须把两种可能都带上 ——
    // 之前只写"检查 API 地址"，用户明明是自己断了网，却被指去查地址。
    ENOTFOUND: '连不上网络，或 API 地址写错了（域名解析失败）',
    EAI_AGAIN: '域名解析超时，检查网络或 DNS',
    ECONNREFUSED: '连接被拒绝，服务没在运行或端口不对',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    CERT_HAS_EXPIRED: '服务端证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '服务端用了自签名证书',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链验证失败',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名和地址不匹配',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_SOCKET: '连接中断',
  }
  if (code && byCode[code]) return byCode[code]

  // 认证/权限类的 HTTP 状态，单说一句更有用
  const http = /HTTP (\d{3})/.exec(String(error?.message ?? ''))
  if (http) {
    const status = Number(http[1])
    if (status === 401 || status === 403) return `${status} —— API Key 不对或没权限`
    if (status === 404) return '404 —— API 地址或模型名不对'
    if (status === 429) return '429 —— 请求太频繁或额度用完了'
    if (status >= 500) return `${status} —— 服务端出错，稍后再试`
  }

  // 兜底：至少有 cause 的描述，比 "fetch failed" 强
  return cause?.message || error?.message || '未知错误'
}

/** 把错误信息里可能出现的 key 抹掉再往外传 */
function sanitizeError (message, apiKey) {
  let out = String(message ?? '')
  if (apiKey && apiKey.length >= 8) {
    out = out.split(apiKey).join('***')
  }
  return out.slice(0, 200)
}

/**
 * 最后一次"全军覆没"的原因。
 *
 * 存在模块级是因为 translate() 的约定是"成功返回对象、失败返回 null"，
 * 改成抛异常或返回错误对象会影响所有调用点。这里退一步用一个只读快照，
 * 调用方在拿到 null 之后读一次即可。
 */
let lastFailureReason = ''

function getLastFailureReason () {
  return lastFailureReason
}

/** 全部接口。provider 选中的排最前，其余按顺序兜底。 */
/**
 * 大模型失败后的冷却截止时刻。
 *
 * 为什么需要：大模型挂了或 key 填错时，**每次翻译都要等满超时**（10 秒）
 * 才出机翻结果。用户连续复制几段，每段都卡 10 秒，比不翻译还难受。
 *
 * 冷却期内直接用免费接口；到点自动重试大模型 —— key 修好了不用重启。
 */
let llmCooldownUntil = 0

/** 冷却还剩多少毫秒（0 = 不在冷却） */
function llmCooldownLeft () {
  return Math.max(0, llmCooldownUntil - Date.now())
}

/** 记一次大模型失败，进入冷却 */
function markLlmFailed () {
  llmCooldownUntil = Date.now() + FAIL_COOLDOWN_MS
}

/** 手动清掉冷却（用户在设置里改了配置 / 测试成功时调用） */
function clearLlmCooldown () {
  llmCooldownUntil = 0
}

function providersFor (config) {
  // 兜底：没传配置时只用免费接口。
  // 防御这一下的理由 —— 配置是后加的，调用方漏传就会直接抛错，
  // 而这种错发生在翻译链路里，表现是"复制了没反应"，很难查。
  if (!config?.provider) return PROVIDERS_FREE

  const all = [
    { id: 'llm', name: '大模型', run: viaLlm, needsConfig: true },
    { id: 'mymemory', name: 'MyMemory', run: viaMyMemory },
    { id: 'google', name: 'Google', run: viaGoogle },
  ]
  const primary = all.find((p) => p.id === config.provider)
  if (!primary) return all.filter((p) => !p.needsConfig)

  // 大模型在冷却中 → 直接用免费接口，别再卡一次超时
  if (primary.id === 'llm' && llmCooldownLeft() > 0) {
    return all.filter((p) => !p.needsConfig)
  }

  // 选中的排第一，剩下的兜底（免费接口不需要配置，随时可用）
  return [primary, ...all.filter((p) => p !== primary && !p.needsConfig)]
}

/**
 * 翻译一段文字。
 * @returns {Promise<{text: string, provider: string}|null>} 全部接口都失败时返回 null
 */
async function translate (text, { from = 'en', to = 'zh-CN', config } = {}) {
  const key = `${from}>${to}:${text}`
  const hit = cacheGet(key)
  if (hit) return { ...hit, cached: true }

  const providers = providersFor(config)
  const wanted = providers[0]

  // ⚠️ 冷却期是个容易漏掉的分支。
  //
  // 冷却时 providersFor 直接把大模型剔掉了，于是 providers[0] 变成 MyMemory，
  // 从"首选 vs 实际"看不出发生过降级 —— 结果气泡上**不显示提示行**，
  // 用户以为这就是大模型翻的。
  //
  // 但冷却期内用的确实是机翻，该提示就得提示。所以这里显式判断一次。
  const skippedByCooldown = config?.provider === 'llm'
    && !providers.some((p) => p.id === 'llm')

  let firstFailure = skippedByCooldown
    ? `大模型刚失败过，${Math.ceil(llmCooldownLeft() / 1000)} 秒后自动重试`
    : null
  lastFailureReason = ''

  for (const provider of providers) {
    try {
      const out = await provider.run(text, from, to, config)
      const fellBack = skippedByCooldown || provider !== wanted
      const result = {
        text: out.trim(),
        provider: provider.name,
        // 降级了 → 调用方据此在气泡上提示"以下为机翻"
        fallbackFrom: fellBack ? (skippedByCooldown ? '大模型' : wanted.name) : null,
        fallbackReason: firstFailure,
      }
      cacheSet(key, result)
      if (provider.id === 'llm') clearLlmCooldown()
      return result
    } catch (error) {
      console.warn(`[translate] ${provider.name} 失败: ${describeFetchError(error)}`)
      lastFailureReason = sanitizeError(describeFetchError(error), config?.llm?.apiKey)
      if (provider === wanted) {
        firstFailure = lastFailureReason
        // 大模型失败 → 进冷却，后面的翻译不再卡超时
        if (provider.id === 'llm') markLlmFailed()
      }
    }
  }
  return null
}

/**
 * 值不值得翻译。
 *
 * 判定放宽一点没关系 —— 真翻译了不通顺也只是多一条气泡，
 * 但**误判成英文去请求接口**会浪费配额，所以宁可严一点。
 */
function looksTranslatable (raw) {
  const text = String(raw ?? '').trim()
  if (text.length < 2 || text.length > 1200) return false

  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  if (letters < 2) return false

  // 拉丁字母要占「可见字符」的一半以上 —— 这样中英混排的句子不会被误判
  const visible = text.replace(/\s/g, '').length
  if (letters / visible < 0.5) return false

  // 已经含很多汉字就不用翻了
  const han = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (han / visible > 0.2) return false

  return true
}

module.exports = {
  translate,
  looksTranslatable,
  testConnection,
  llmCooldownLeft,
  clearLlmCooldown,
  sanitizeError,
  describeFetchError,
  getLastFailureReason,
  CACHE_LIMIT,
}
