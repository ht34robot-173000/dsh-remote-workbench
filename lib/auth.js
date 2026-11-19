/**
 * lib/auth.js — 设备配对与访问控制
 *
 * 目的：远程端（手机/别的电脑）第一次访问时，必须用宿主机上生成的配对码
 * 换一张长期设备 cookie。之后每次请求凭 cookie 放行。
 *
 * 三条硬规则：
 *  1. 配对码只在宿主机 loopback 上能取到（`/rw/pair/new`），远程端拿不到。
 *  2. 配对码一次性，默认 10 分钟过期。
 *  3. 设备 cookie 是服务端随机串的 HMAC，客户端改不动。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const COOKIE_NAME = 'rw_device'
const PAIR_TTL_MS = 10 * 60 * 1000
const COOKIE_MAX_AGE = 365 * 24 * 3600

/** 一次性下载票据有效期。够浏览器发起请求即可，不要太长。 */
const TICKET_TTL_MS = 60 * 1000

export function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

function statePath() {
  return join(homeDir(), 'remote-workbench.json')
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 定长比较，避免时序侧信道。 */
function same(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export class DeviceAuth {
  constructor() {
    this.file = statePath()
    this.state = this.load()
    this.pair = null
    // 一次性下载票据：token -> 过期时间戳。只在内存里，重启即失效（安全侧）。
    this.tickets = new Map()
  }

  load() {
    try {
      if (!existsSync(this.file)) return { secret: null, devices: {} }
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return {
        secret: typeof raw.secret === 'string' ? raw.secret : null,
        devices: raw.devices && typeof raw.devices === 'object' ? raw.devices : {},
      }
    } catch {
      return { secret: null, devices: {} }
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    } catch {}
  }

  /** 签名密钥：首次跑时生成并落盘，重启后已有 cookie 仍然有效。 */
  ensureSecret() {
    if (!this.state.secret) {
      this.state.secret = b64url(randomBytes(32))
      this.save()
    }
    return this.state.secret
  }

  sign(deviceId, deviceSecret) {
    return b64url(createHmac('sha256', this.ensureSecret()).update(`${deviceId}.${deviceSecret}`).digest())
  }

  /** 生成一次性配对码（只允许 loopback 调用方拿）。 */
  newPair() {
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const nonce = b64url(randomBytes(16))
    this.pair = { code, nonce, expiresAt: Date.now() + PAIR_TTL_MS, used: false }
    return { code, nonce, expiresAt: this.pair.expiresAt }
  }

  pairInfo() {
    if (!this.pair || this.pair.used || Date.now() > this.pair.expiresAt) return null
    return { code: this.pair.code, expiresAt: this.pair.expiresAt }
  }

  /** 用配对码/一次性 nonce 换设备凭据。 */
  accept(offered) {
    const p = this.pair
    if (!p || p.used || Date.now() > p.expiresAt) return { ok: false, code: 'invalid-token' }
    const token = String(offered ?? '').trim()
    if (!token) return { ok: false, code: 'invalid-token' }
    if (!same(p.code, token) && !same(p.nonce, token)) return { ok: false, code: 'invalid-token' }

    p.used = true
    const deviceId = b64url(randomBytes(12))
    const deviceSecret = b64url(randomBytes(32))
    this.state.devices[deviceId] = {
      secret: deviceSecret,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    this.save()
    return { ok: true, deviceId, cookie: `${deviceId}.${this.sign(deviceId, deviceSecret)}` }
  }

  /** 校验请求里的设备 cookie。 */
  verify(req) {
    const raw = this.cookieOf(req)
    if (!raw) return null
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) return null
    const deviceId = raw.slice(0, dot)
    const sig = raw.slice(dot + 1)
    const row = this.state.devices[deviceId]
    if (!row) return null
    if (!same(sig, this.sign(deviceId, row.secret))) return null
    row.lastSeenAt = Date.now()
    return { deviceId }
  }

  cookieOf(req) {
    const header = req.headers?.cookie
    if (typeof header !== 'string') return null
    for (const part of header.split(';')) {
      const at = part.indexOf('=')
      if (at === -1) continue
      if (part.slice(0, at).trim() === COOKIE_NAME) return part.slice(at + 1).trim()
    }
    return null
  }

  /** 撤销全部设备（宿主机上操作）。 */
  revokeAll() {
    this.state.devices = {}
    this.pair = null
    this.save()
    return true
  }

  listDevices() {
    return Object.entries(this.state.devices).map(([id, row]) => ({
      id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    }))
  }

  // ——————— 一次性下载票据 ———————

  /**
   * 票据存储：token -> 过期时间戳。
   *
   * 为什么需要它：下载是由**系统浏览器/下载器**发起的 GET，
   * 那个请求不带 `rw_device` cookie（不同 UA、不同 cookie jar），
   * 硬要 cookie 就必然 401「设备未配对」。
   *
   * 安全考虑（相比把 cookie 塞进 URL）：
   *   - 票据 60 秒过期
   *   - 用一次立刻作废（consumeTicket 里删除）
   *   - 只对下载生效，不能拿它调别的 API
   *   - 随机 32 字节，不可猜
   */
  issueTicket() {
    if (!this.tickets) this.tickets = new Map()
    // 顺手清掉过期的，避免长跑进程里无限堆积
    const now = Date.now()
    for (const [k, exp] of this.tickets) {
      if (exp <= now) this.tickets.delete(k)
    }
    const token = b64url(randomBytes(32))
    this.tickets.set(token, now + TICKET_TTL_MS)
    return token
  }

  /** 核销票据：存在且没过期才放行，用完即删。 */
  consumeTicket(token) {
    if (typeof token !== 'string' || token === '') return false
    if (!this.tickets) return false
    const exp = this.tickets.get(token)
    if (exp === undefined) return false
    this.tickets.delete(token)
    return exp > Date.now()
  }
}

export function setCookieHeader(cookie) {
  return `${COOKIE_NAME}=${cookie}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
}

export { COOKIE_NAME }
