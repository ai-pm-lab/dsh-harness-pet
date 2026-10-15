/**
 * translate-config.js — 翻译接口的配置
 *
 * 配置文件放在 userData 下，用户可以直接编辑：
 *
 *     ~/Library/Application Support/胖头鱼/translate.json
 *
 * 为什么用"可编辑的 JSON 文件"而不是设置界面：
 * 接口地址、模型名、提示词这些东西，做成界面要写一堆表单校验，
 * 而目标用户（会自己配 API 的人）**更愿意直接改文件** ——
 * 改完保存即生效，比点五层菜单快。
 *
 * ⚠️ 文件里有 API key，所以：
 *   - 权限设成 0600（只有本人可读）
 *   - **绝不写进日志**
 *   - 绝不进 git（它在 userData 里，本来就不在仓库里）
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 默认配置。首次运行会写成文件，用户照着改。 */
const DEFAULTS = {
  _说明: '翻译接口配置。改完保存即生效，不用重启。key 只存在这个文件里，不会进日志。',
  _provider说明: 'mymemory = 免费无需 key；google = 免费无需 key；llm = 任意 OpenAI 兼容接口',

  provider: 'mymemory',

  llm: {
    _说明: 'provider 选 llm 时用这一组。任何 OpenAI 兼容接口都行：DeepSeek、OpenAI、Kimi、本地 Ollama…',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    _prompt说明: '{text} 会被替换成待翻译的原文。',
    prompt: '把下面的内容翻译成简体中文。只输出译文，不要任何解释、不要加引号。\n\n{text}',
  },
}

/** 各字段的合法取值，用来挡掉明显写错的配置 */
const PROVIDERS = new Set(['mymemory', 'google', 'llm'])

let cachedPath = null

function configPath (userDataDir) {
  if (!cachedPath) cachedPath = path.join(userDataDir, 'translate.json')
  return cachedPath
}

/**
 * 读配置。**每次翻译都重新读** —— 文件很小（几百字节），
 * 而"改完保存即生效"这个体验值这点开销。
 */
function load (userDataDir) {
  const file = configPath(userDataDir)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalize(raw)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[translate] 配置读不了（用默认值）: ${error.message}`)
    }
    return normalize({})
  }
}

/** 首次运行时把默认配置写出来，让用户有个能照着改的模板 */
function ensureFile (userDataDir) {
  const file = configPath(userDataDir)
  try {
    if (fs.existsSync(file)) return file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 })
    console.log(`[translate] 已生成配置文件: ${file}`)
  } catch (error) {
    console.warn(`[translate] 写配置文件失败: ${error.message}`)
  }
  return file
}

/**
 * 保存配置。
 *
 * 只写我们认识的字段（provider + llm 那四个），并且**保留文件里原有的
 * 说明字段** —— 用户可能自己在里面加了备注，不该被我们覆盖掉。
 */
function save (userDataDir, next) {
  const file = configPath(userDataDir)
  const normalized = normalize(next)

  let existing = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* 第一次保存，或文件坏了，都从空开始 */ }

  const merged = {
    ...DEFAULTS,
    ...existing,                       // 保留用户的备注 / 未知字段
    provider: normalized.provider,
    llm: { ...DEFAULTS.llm, ...(existing.llm ?? {}), ...normalized.llm },
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  console.log(`[translate] 配置已保存（provider=${normalized.provider}）`)
  return normalized
}

/** 补齐缺省值、挡掉非法值 */
function normalize (raw) {
  const llm = raw?.llm ?? {}
  const provider = PROVIDERS.has(raw?.provider) ? raw.provider : DEFAULTS.provider

  return {
    provider,
    llm: {
      baseUrl: typeof llm.baseUrl === 'string' && llm.baseUrl.trim()
        ? llm.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULTS.llm.baseUrl,
      apiKey: typeof llm.apiKey === 'string' ? llm.apiKey.trim() : '',
      model: typeof llm.model === 'string' && llm.model.trim()
        ? llm.model.trim()
        : DEFAULTS.llm.model,
      prompt: typeof llm.prompt === 'string' && llm.prompt.includes('{text}')
        ? llm.prompt
        : DEFAULTS.llm.prompt,
    },
  }
}

/** 给日志用的摘要 —— **不含 key** */
function describe (config) {
  if (config.provider !== 'llm') return config.provider
  const hasKey = config.llm.apiKey ? '有 key' : '⚠️ 没填 key'
  return `llm(${config.llm.model} @ ${config.llm.baseUrl}, ${hasKey})`
}

module.exports = {
  load,
  save,
  ensureFile,
  normalize,
  describe,
  DEFAULTS,
  configPath,
}
