/**
 * lib/account.js — DSH 账号与余额（「我的」页数据源）
 *
 * 数据全部来自宿主的 `deepseekAccount` 服务（`@deepseek-ai/dsh-deepseek-account-platform`
 * 提供实现，`@deepseek-ai/dsh-deepseek-account` 定义抽象）。
 *
 * —— 为什么不用 accountController ——
 *
 * `accountController` 是 Typert Remote 服务，只对浏览器/客户端远程暴露，
 * 宿主插件从 ctx 里拿不到同名 Service（catalog 里也查不到）。
 * 而 `deepseekAccount` 是**宿主本地**的 Service，`ctx.get('deepseekAccount')`
 * 能直接拿到，方法齐全：getState / getProfile / getBalance / getUnnotifiedBonuses。
 *
 * —— 参数契约（照抄 typert.host.js 的 schema）——
 *
 * 每个读到明细的方法都要一个 AccountClientMetadata：
 *   { version: string, locale: string, timezoneOffsetSeconds: number }
 * 宿主用它拼 Platform 请求头（x-client-version / x-client-locale /
 * x-client-timezone-offset）。缺字段会直接抛 schema 校验错误，
 * 所以这里**永远补齐三个字段**，不依赖调用方传。
 *
 * timezoneOffsetSeconds 的口径是「本地比 UTC 快多少秒」：
 *   -(new Date()).getTimezoneOffset() * 60
 * 注意不是 getTimezoneOffset() 本身（那个符号是反的）。
 *
 * —— 关于失败 ——
 *
 * getProfile / getBalance 在**未登录**或**凭据在查询途中被换掉**时返回 null。
 * 这是正常状态，不是错误 —— 所以返回 `{ok:true, value:null}` 让 App 显示
 * 「未登录」，而不是弹一个看不懂的失败。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const err = (code, message) => ({ ok: false, error: { code, message } })

function safeGet(ctx, name) {
  try {
    const v = ctx.get(name)
    if (v !== undefined && v !== null) return v
  } catch {}
  return undefined
}

/**
 * 宿主 DSH 的版本号。
 *
 * Platform 会把它塞进 x-client-version，用来判断客户端是否太旧。
 * 写死一个假版本号迟早会和真实宿主错位，所以**从安装目录的 package.json 读**，
 * 读不到才回落到一个已知可用的值。
 *
 * 候选顺序：
 *   1. $DSH_HOME/../resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json（标准安装）
 *   2. process.execPath 同级往上找（Host 就在 dsh 目录里跑）
 *   3. 兜底常量
 */
function harnessVersion() {
  const candidates = []
  // Host 进程的 argv[1] 就是 dsh 的入口脚本，走到 dsh 包根即可
  try {
    const entry = process.argv?.[1] ?? ''
    if (entry !== '') {
      // .../@deepseek-ai/dsh/lib/xxx.js 或 .../@deepseek-ai/dsh/xxx.js
      const idx = entry.replace(/\\/g, '/').indexOf('/@deepseek-ai/dsh/')
      if (idx > 0) {
        candidates.push(join(entry.replace(/\\/g, '/').slice(0, idx), '@deepseek-ai', 'dsh', 'package.json'))
      }
    }
  } catch {}
  for (const p of candidates) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'))?.version
      if (typeof v === 'string' && v !== '') return v
    } catch {}
  }
  return '0.2.0-rc.2'
}

/** 缓存版本号：读盘一次就够，它不会在进程生命周期里变。 */
let cachedVersion = ''

/**
 * 拼 AccountClientMetadata。
 *
 * locale 只影响 Platform 返回的文案语言，用 zh-CN 和桌面端一致。
 * timezoneOffsetSeconds 取**调用当时**的值 —— 跨时区飞行后重启 App 就正确。
 */
function clientMeta() {
  if (cachedVersion === '') cachedVersion = harnessVersion()
  return {
    version: cachedVersion,
    locale: 'zh-CN',
    timezoneOffsetSeconds: -(new Date()).getTimezoneOffset() * 60,
  }
}

/**
 * 把 Platform 返回的余额字符串规范化成「两位小数的十进制串」。
 *
 * —— 为什么要在后端也做一遍 ——
 *
 * Platform 原样返回的是 `32.2317866000000000` 这种浮点尾巴。
 * App 侧虽然会格式化，但这串东西会**沿着接口流到任何消费者**
 * （网页版、调试台的 curl 输出、以后可能加的通知文案），
 * 一旦哪里忘了格式化，就会把 16 位小数甩给用户看。
 *
 * 所以在源头收一次口：所有出口拿到的都是 `32.23` 这样的串。
 * 口径完全照 Platform Web：
 *   - 正数**截断**到分（12.345 → 12.34，不四舍五入）
 *   - 正数不足一分 → `0.00`（App 会另外显示成 `<0.01`）
 *   - 负数四舍五入，绝对值至少 0.01
 *   - 解析不了就原样返回（宁可显示怪值，也不要伪造一个 0）
 */
function normalizeAmount(raw) {
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) return raw

  const neg = text.startsWith('-')
  const body = neg ? text.slice(1) : text
  const [intPart, fracPart = ''] = body.split('.')

  let cents
  if (!neg) {
    // 正数：截断，不四舍五入
    cents = (fracPart + '00').slice(0, 2)
  } else {
    // 负数：四舍五入到分
    const scaled = Math.round(Number(body) * 100)
    cents = String(scaled % 100).padStart(2, '0')
  }

  const intNorm = intPart.replace(/^0+(?=\d)/, '') || '0'
  const out = `${intNorm}.${cents}`
  // 负数但绝对值不足一分 → 至少 0.01
  if (neg) {
    return Number(out) === 0 ? '-0.01' : `-${out}`
  }
  return out
}

/** 把一个钱包数组里的 balance 逐项规范化。 */
function normalizeWallets(list) {
  if (!Array.isArray(list)) return list
  return list.map((w) => {
    if (!w || typeof w !== 'object') return w
    return { ...w, balance: normalizeAmount(w.balance) }
  })
}

/** 把 balance 结果整块规范化（成功态才动，失败态原样透传）。 */
function normalizeBalance(result) {
  if (!result || typeof result !== 'object') return result
  if (result.status !== 'ready') return result
  return {
    ...result,
    value: normalizeWallets(result.value),
    bonusWallets: normalizeWallets(result.bonusWallets),
  }
}

export function makeAccountOps(ctx) {
  const account = () => safeGet(ctx, 'deepseekAccount')

  return {
    /**
     * 登录状态（轻量）。
     *
     * 只读本地凭据记录，**不发网络请求**，所以打开「我的」页时可以立刻返回。
     * 返回 { status:'signed-out'|'credential-stored', links:{usageUrl,topUpUrl}, attempt }
     */
    async state() {
      const svc = account()
      if (!svc) return err('account-unavailable', '宿主没有 deepseekAccount 服务（账号插件未挂载）')
      if (typeof svc.getState !== 'function') return err('state-unsupported', 'deepseekAccount 没有 getState 方法')
      try {
        const val = await svc.getState()
        return { ok: true, value: val ?? null }
      } catch (e) {
        return err(e?.code || 'state-failed', String(e?.message || e))
      }
    },

    /**
     * 账号资料（显示名 / 联系邮箱 / 头像）。
     *
     * 返回 null 表示未登录或凭据已失效 —— App 据此显示「未登录」。
     */
    async profile() {
      const svc = account()
      if (!svc) return err('account-unavailable', '宿主没有 deepseekAccount 服务')
      if (typeof svc.getProfile !== 'function') return err('profile-unsupported', 'deepseekAccount 没有 getProfile 方法')
      try {
        const val = await svc.getProfile(clientMeta())
        return { ok: true, value: val ?? null }
      } catch (e) {
        return err(e?.code || 'profile-failed', String(e?.message || e))
      }
    },

    /**
     * 充值钱包余额 + 赠金钱包。
     *
     * 形状（成功时）：
     *   { status:'ready', value:[{currency:'CNY'|'USD', balance:'12.34'}],
     *     bonusWallets:[{currency,balance}] }
     * 失败时宿主返回 { status:'failed' }，这里原样透传，让 App 显示「读取失败」
     * 而不是假装余额是 0（那会让用户以为钱没了）。
     */
    async balance() {
      const svc = account()
      if (!svc) return err('account-unavailable', '宿主没有 deepseekAccount 服务')
      if (typeof svc.getBalance !== 'function') return err('balance-unsupported', 'deepseekAccount 没有 getBalance 方法')
      try {
        const val = await svc.getBalance(clientMeta())
        // 源头规范化：别把 32.2317866000000000 这种浮点尾巴放出去
        return { ok: true, value: normalizeBalance(val) ?? null }
      } catch (e) {
        return err(e?.code || 'balance-failed', String(e?.message || e))
      }
    },

    /**
     * 一次取齐「我的」页要的东西，减少手机端的往返。
     *
     * 三个读取**并发**跑，且任何一个失败都不影响另外两个 ——
     * 余额接口偶尔会超时（Platform 侧 30s 上限），不该连带把资料页拖死。
     */
    async overview() {
      const svc = account()
      if (!svc) return err('account-unavailable', '宿主没有 deepseekAccount 服务（账号插件未挂载）')

      const meta = clientMeta()
      const settle = async (fn, label) => {
        if (typeof fn !== 'function') return { error: `${label}-unsupported` }
        try {
          const v = (await fn.call(svc, meta)) ?? null
          // balance 这一路要规范化；profile 不需要
          return { value: label === 'balance' ? normalizeBalance(v) : v }
        } catch (e) {
          return { error: e?.code || `${label}-failed`, message: String(e?.message || e) }
        }
      }

      const [state, profile, balance] = await Promise.all([
        (async () => {
          try {
            return { value: (await svc.getState()) ?? null }
          } catch (e) {
            return { error: e?.code || 'state-failed', message: String(e?.message || e) }
          }
        })(),
        settle(svc.getProfile, 'profile'),
        settle(svc.getBalance, 'balance'),
      ])

      return { ok: true, value: { state, profile, balance } }
    },
  }
}
