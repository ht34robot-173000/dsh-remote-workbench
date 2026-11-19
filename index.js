/**
 * dsh-remote-workbench — 远程工作台宿主侧
 *
 * 一条独立的路由前缀 `/rw`，自带配对鉴权，不依赖 dsh-mobile-plus。
 *
 * 路由表：
 *   GET  /rw/                   工作台页面
 *   POST /rw/pair/new           生成配对码（仅 loopback）
 *   GET  /rw/pair/info          当前配对码状态（仅 loopback）
 *   POST /rw/pair/accept        用配对码换设备 cookie
 *   POST /rw/pair/revoke        撤销所有设备（仅 loopback）
 *   GET  /rw/api/state          当前设备是否已配对 + 基础环境
 *   POST /rw/api/fs.list        列目录（含文件）
 *   POST /rw/api/fs.read        读文本
 *   POST /rw/api/fs.raw         读原始字节（预览）
 *   POST /rw/api/fs.write       写文本
 *   POST /rw/api/fs.mkdir       新建目录
 *   POST /rw/api/fs.touch       新建空文件
 *   POST /rw/api/fs.remove      删除
 *   POST /rw/api/fs.move        重命名/移动
 *   POST /rw/api/fs.copy        复制
 *   POST /rw/api/fs.upload      上传到指定目录
 *   GET  /rw/api/fs.download    下载（流式）
 *   POST /rw/api/session.list   会话列表
 *   POST /rw/api/session.history
 *   POST /rw/api/session.prompt 发消息
 *   POST /rw/api/session.cancel 中断
 *   POST /rw/api/session.models
 *   POST /rw/api/session.selectModel
 *   POST /rw/api/session.steer  运行中插话
 *   POST /rw/api/workspace.list
 *   POST /rw/api/command.list
 *   POST /rw/api/account.overview   「我的」页：账号资料 + 余额（一次取齐）
 *   POST /rw/api/account.state      登录状态（只读凭据，不发网络请求）
 *   POST /rw/api/account.profile    账号资料
 *   POST /rw/api/account.balance    钱包余额 + 赠金
 */
import { readFileSync } from 'node:fs'
import { hostname as osHostname, homedir as osHomedir, networkInterfaces } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeviceAuth, setCookieHeader, clearCookieHeader } from './lib/auth.js'
import { makeSessionOps } from './lib/session.js'
import { makeAccountOps } from './lib/account.js'
import { makeLiveHub } from './lib/live.js'
import {
  listDir, readText, readRaw, writeText, makeDir, makeFile, remove, move, copy,
  saveUpload, openDownload, mimeOf, listDrives,
} from './lib/fs-ops.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(ROOT, 'public')
const PREFIX = '/rw'
const MAX_JSON = 32 * 1024 * 1024

export const name = 'remote-workbench'
/**
 * 只声明这三个——它们是 dsh-mobile-plus 与 dsh-improved-inline-edit 里
 * 已经被真实环境验证过的组合，确定存在：
 *   webServer  挂路由
 *   agents     插话（agent.steer）
 *   commands   / 触发的命令列表
 *
 * 会话读写（sessionController / sessionQuery / sessions）故意不写进 inject：
 * 它们用 ctx.get() 探测即可（mobile-plus 就是这么做的），拿不到就返回
 * 明确错误。inject 里写不确定的服务会让宿主卡在「等待服务」直接启动失败。
 */
export const inject = ['webServer', 'agents', 'commands']

/** 读 JSON 请求体，超限直接抛。 */
async function readJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) {
      const err = new Error('payload-too-large')
      err.code = 'payload-too-large'
      throw err
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 发 JSON 响应。
 *
 * —— 关于压缩：**不要在这里自己 gzip**（2026-11-16 实测纠正）——
 *
 * 我一开始在这里加了 gzipSync，理由是「会话历史 928KB，压完能快 4 倍」。
 * 压缩收益是真的，但**这个库里已经有更上层在做**：
 *
 *   @deepseek-ai/dsh-host-webserver/lib/index.js
 *     import compressionMiddleware from "compression"
 *     DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024
 *     config.compression: "none" | "gzip"
 *
 * 宿主 `webServer` 在装路由时就套了 `compression` 中间件。所以：
 *
 * 1. 从 `ctx.webServer.register()` 注册的路由**默认就被压缩**（只要 profile 里
 *    `webServer.config.compression` 是 `gzip`，本机实测是开着的）。
 * 2. 我再压一遍属于重复劳动，而且会和外层打架 —— 实测外层会把我的
 *    `content-length` 改写成 `transfer-encoding: chunked`，
 *    两个 content-encoding 头也可能并存。
 *
 * **实测的压缩收益（真实数据，值得记下来）**：
 *
 *   session.list      105,127 B →  13,428 B  (12.8%)
 *   session.history   459,615 B → 119,861 B  (26.1%)
 *   account.overview      479 B →     271 B  (56.6%)
 *
 * 也就是「点开一个大会话」从 0.62 秒降到 0.13 秒（0.86 MB/s 上行下），约 4.6 倍。
 * 这个收益**由宿主那层 compression 提供**，不是这个函数。
 *
 * 所以这里保持最朴素的实现：只 `res.end(payload)`，压缩交给上层。
 * 如果哪天确认宿主没开压缩，改 profile 的
 * `webServer.config.compression: gzip` 即可，不必在插件里重写一遍。
 */
function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 探测本机的局域网地址，给「扫二维码自动填地址」用。
 *
 * 只挑 IPv4、跳过回环和 169.254 链路本地地址。
 * 优先 192.168 / 10. / 172.16-31 这种典型局域网段，其余的排后面 ——
 * 虚拟网卡（VMware / Hyper-V / WSL）经常先被枚举出来，而它们手机连不上。
 *
 * 探测失败返回空串，调用方退回手动填写，不抛异常。
 */
function detectLanUrl(port) {
  try {
    const nets = networkInterfaces()
    const candidates = []
    for (const list of Object.values(nets)) {
      for (const net of list ?? []) {
        if (net.family !== 'IPv4' || net.internal) continue
        if (net.address.startsWith('169.254.')) continue
        let score = 1
        if (net.address.startsWith('192.168.')) score = 3
        else if (net.address.startsWith('10.')) score = 2
        else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) score = 2
        candidates.push({ address: net.address, score })
      }
    }
    if (candidates.length === 0) return ''
    candidates.sort((a, b) => b.score - a.score)
    return `http://${candidates[0].address}:${port}`
  } catch {
    return ''
  }
}

/**
 * 「这个请求是不是真的来自本机」—— 配对码生成的唯一防线。
 *
 * ⚠️ 只看 `req.socket.remoteAddress` 是**不够**的，这是个真实漏洞：
 * cloudflared 跑在本机，公网请求经隧道进来时 TCP 连接**来自 127.0.0.1**，
 * 于是所有公网请求在 socket 层都长得像本机。实测过：
 *
 *     http://127.0.0.1:19387/rw/pair/new  → 200 {"code":"862741"}
 *     https://dsh.ht34robot.cyou/rw/pair/new → 200 {"code":"555247"}   ← 不该成功
 *
 * 后果不是「能看到配对码」这么轻：知道域名的人可以自己取码、自己配对，
 * 拿到完整设备 cookie → 文件全读写、发会话消息、远程重启 DSH。
 * 而且它返回 200，看起来一切正常 —— 正是本项目最爱踩的那类静默失败。
 *
 * 所以改成三重判定，任何一条不满足即拒绝：
 *
 *   1. **反代痕迹**：只要出现 CF-Connecting-IP / X-Forwarded-For / Forwarded
 *      任一头，就是经过了隧道或反代，直接拒。（cloudflared 必然带 CF-Connecting-IP）
 *   2. **Host 白名单**：Host 必须是回环地址本身。经隧道进来的是
 *      `dsh.ht34robot.cyou`，直接不匹配。
 *   3. **socket 地址**：最后才看 remoteAddress 是不是回环。
 *
 * 单独任何一条都能被绕过，三条叠加才是纵深防御。
 */
function isLoopback(req) {
  const headers = req.headers ?? {}

  // 1) 反代 / 隧道痕迹：有就绝对不是本机直连
  const proxyHeaders = [
    'cf-connecting-ip',
    'cf-ray',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-real-ip',
    'forwarded',
  ]
  for (const name of proxyHeaders) {
    if (headers[name] !== undefined) return false
  }

  // 2) Host 必须是回环本身（带不带端口都认）
  const rawHost = String(headers.host ?? '').toLowerCase().trim()
  if (rawHost === '') return false
  const hostname = rawHost.replace(/:\d+$/u, '')
  const hostOk =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  if (!hostOk) return false

  // 3) 最后看 socket 地址
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const auth = new DeviceAuth()
  auth.ensureSecret()
  const sessions = makeSessionOps(ctx)
  // 「我的」页的数据源：DSH 账号资料 + 余额。读的是宿主 deepseekAccount 服务。
  // 拿不到服务不致命 —— 接口会返回明确错误码，App 显示「账号服务不可用」。
  const account = makeAccountOps(ctx)
  const maxUpload = Number(config.maxUploadBytes) || 20 * 1024 * 1024
  const maxEntries = Number(config.maxDirEntries) || 5000
  const allowUnpairedRead = config.allowUnpairedRead === true

  const paired = (req) => auth.verify(req) !== null

  /** 所有 API 的统一闸门。 */
  const guard = (req, res) => {
    if (paired(req)) return true
    if (allowUnpairedRead) return true
    sendJson(res, 401, { ok: false, error: { code: 'unpaired', message: '设备未配对' } })
    return false
  }

  const routes = []

  /*
   * 实时状态流。
   *
   * 单独建一个 hub：它要持有长连接和宿主事件订阅，生命周期和插件一致。
   * 所有会话的 running 状态变化都从这里推给 App，App 不用轮询。
   */
  const live = makeLiveHub(ctx)

  // ---------- 页面 ----------
  routes.push({
    kind: 'exact', path: PREFIX,
    handler: (req, res) => serveIndex(req, res),
  })
  routes.push({
    kind: 'exact', path: `${PREFIX}/`,
    handler: (req, res) => serveIndex(req, res),
  })
  routes.push({
    kind: 'prefix', path: `${PREFIX}/assets`,
    handler: (req, res) => serveAsset(req, res),
  })

  function serveIndex(req, res) {
    try {
      const html = readFileSync(join(PUBLIC, 'index.html'))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(html)
    } catch (error) {
      sendText(res, 500, `工作台页面未找到：${error.message}`)
    }
  }

  function serveAsset(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const rel = url.pathname.slice(`${PREFIX}/assets/`.length)
    if (rel.includes('..') || rel.startsWith('/')) {
      sendText(res, 400, 'bad path')
      return
    }
    const file = join(PUBLIC, rel)
    try {
      const buf = readFileSync(file)
      res.writeHead(200, {
        'content-type': mimeOf(file),
        'cache-control': 'public, max-age=60',
      })
      res.end(buf)
    } catch {
      sendText(res, 404, 'not found')
    }
  }

  // ---------- 配对 ----------
  routes.push({
    kind: 'exact', path: `${PREFIX}/pair/new`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: { code: 'loopback-only' } })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      const p = auth.newPair()
      sendJson(res, 200, { ok: true, ...p })
    },
  })

  routes.push({
    kind: 'exact', path: `${PREFIX}/pair/info`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: { code: 'loopback-only' } })
      const info = auth.pairInfo()
      sendJson(res, 200, { ok: true, pair: info, devices: auth.listDevices() })
    },
  })

  routes.push({
    kind: 'exact', path: `${PREFIX}/pair/accept`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      let body
      try { body = await readJson(req, 8192) } catch { return sendJson(res, 400, { ok: false }) }
      const out = auth.accept(body?.token)
      if (!out.ok) return sendJson(res, 404, { ok: false, error: { code: out.code } })
      sendJson(res, 200, { ok: true, deviceId: out.deviceId }, { 'set-cookie': setCookieHeader(out.cookie) })
    },
  })

  routes.push({
    kind: 'exact', path: `${PREFIX}/pair/revoke`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: { code: 'loopback-only' } })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      auth.revokeAll()
      sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookieHeader() })
    },
  })

  routes.push({
    kind: 'exact', path: `${PREFIX}/api/state`,
    handler: (req, res) => {
      const device = auth.verify(req)
      sendJson(res, 200, {
        ok: true,
        paired: device !== null,
        device: device?.deviceId ?? null,
        platform: process.platform,
        hostname: osHostname(),
        home: osHomedir(),
        drives: listDrives(),
        maxUpload,
      })
    },
  })

  // ---------- 文件系统 ----------
  const fsRoute = (path, fn) => {
    routes.push({
      kind: 'exact', path: `${PREFIX}/api/${path}`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        let body
        try { body = await readJson(req, MAX_JSON) } catch (e) {
          /*
           * 413 要说清楚是「超上限」，并把上限报回去。
           * 手机端拿到 code/maxBytes 才能提示「换小文件」，
           * 而不是显示一个看不懂的 bad-payload。
           */
          return sendJson(res, 413, {
            ok: false,
            error: {
              code: e.code || 'bad-payload',
              message: e.code === 'payload-too-large'
                ? `请求体超过 ${Math.round(MAX_JSON / 1024 / 1024)}MB 上限（base64 编码会膨胀，实际文件约为此值的 3/4）`
                : '请求体解析失败',
              maxBytes: MAX_JSON,
            },
          })
        }
        const out = await fn(body)
        sendJson(res, out.ok ? 200 : 400, out)
      },
    })
  }

  fsRoute('fs.list', (b) => listDir(b, { maxEntries }))
  fsRoute('fs.read', readText)
  fsRoute('fs.write', writeText)
  fsRoute('fs.mkdir', makeDir)
  fsRoute('fs.touch', makeFile)
  fsRoute('fs.remove', remove)
  fsRoute('fs.move', move)
  fsRoute('fs.copy', copy)
  fsRoute('fs.upload', (b) => saveUpload(b))

  // 原始字节：直接写二进制响应，不走 JSON
  routes.push({
    kind: 'exact', path: `${PREFIX}/api/fs.raw`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      let body
      try { body = await readJson(req, 8192) } catch { return sendText(res, 400, 'bad payload') }
      const out = await readRaw(body)
      if (!out.ok) return sendJson(res, 404, out)
      res.writeHead(200, {
        'content-type': mimeOf(out.value.path),
        'content-length': String(out.value.size),
        'cache-control': 'no-store',
      })
      res.end(out.value.buffer)
    },
  })

  // 流式下载
  routes.push({
    kind: 'exact', path: `${PREFIX}/api/fs.download`,
    handler: async (req, res) => {
      /*
       * 下载的鉴权要特殊处理。
       *
       * 普通 API 靠 `rw_device` cookie 过 guard()，但**下载是交给系统浏览器/下载器
       * 发起的 GET**，那个请求不带我们的 cookie（不同 UA、不同 cookie jar），
       * 于是必然 401 —— 这就是「浏览器说设备未配对」的原因。
       *
       * 做法：先由已鉴权的 POST /api/fs.ticket 换一张一次性票据，
       * 再把票据拼进下载 URL（?ticket=xxx）。票据 60 秒过期、用一次就作废，
       * 即使 URL 被日志记下来也基本无风险 —— 比直接把设备 cookie 写进 URL 安全得多。
       */
      const url = new URL(req.url ?? '/', 'http://x')
      const ticket = url.searchParams.get('ticket') ?? ''

      // 票据优先；没有票据时仍允许带 cookie 的直连（App 内部走这条）
      if (ticket !== '') {
        if (!auth.consumeTicket(ticket)) {
          return sendText(res, 401, 'ticket-invalid')
        }
      } else if (!guard(req, res)) {
        return
      }

      const path = url.searchParams.get('path') ?? ''
      const out = await openDownload({ path })
      if (!out.ok) return sendText(res, 404, JSON.stringify(out))
      const name = encodeURIComponent(out.value.name)
      res.writeHead(200, {
        'content-type': mimeOf(out.value.name),
        'content-length': String(out.value.size),
        'content-disposition': `attachment; filename*=UTF-8''${name}`,
      })
      out.value.stream.pipe(res)
    },
  })

  // ---------- 配对辅助：告诉桌面面板「二维码里该装哪个地址」 ----------
  /*
   * 为什么需要这个接口 —— 二维码不能装 location.origin。
   *
   * 面板跑在桌面浏览器里，`location.origin` 是 `http://127.0.0.1:19387`。
   * 手机扫到 127.0.0.1 只会连自己，**必然连不上**。
   *
   * 所以地址由宿主决定，按优先级：
   *   1. 配置里的 publicUrl（named tunnel 的固定域名，最省事）
   *   2. 配置里的 lanUrl（手动指定，适合多网卡机器）
   *   3. 自动探测：取第一个非回环的 IPv4 局域网地址，拼 `http://<ip>:<port>`
   *
   * 返回里同时给两端候选，App 扫码后可以自己选：
   * 在家用局域网（快），出门用公网（慢但通）。
   */
  routes.push({
    kind: 'exact', path: `${PREFIX}/pair/endpoint`,
    handler: (req, res) => {
      if (!isLoopback(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'loopback-only' } })
      }
      const port = Number(ctx.webServer?.port) || 19387
      const lan = config.lanUrl || detectLanUrl(port)
      const pub = config.publicUrl || ''
      sendJson(res, 200, {
        ok: true,
        lan,
        public: pub,
        // 默认给公网：手机不保证和电脑同一个 Wi-Fi，公网是唯一必然可达的
        default: pub || lan,
      })
    },
  })

  // ---------- 会话 ----------
  const apiRoute = (path, fn) => {
    routes.push({
      kind: 'exact', path: `${PREFIX}/api/${path}`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        let body
        try { body = await readJson(req, MAX_JSON) } catch (e) {
          return sendJson(res, 413, { ok: false, error: { code: e.code || 'bad-payload' } })
        }
        try {
          const out = await fn(body)
          sendJson(res, 200, out)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(e?.message || e) } })
        }
      },
    })
  }

  apiRoute('session.list', (b) => sessions.listSessions(b))
  apiRoute('session.create', (b) => sessions.create(b))
  apiRoute('session.history', (b) => sessions.history(b))
  apiRoute('session.turns', (b) => sessions.turns(b))
  apiRoute('session.prompt', (b) => sessions.prompt(b))
  apiRoute('session.cancel', (b) => sessions.cancel(b))
  apiRoute('session.models', (b) => sessions.models(b))
  apiRoute('session.selectModel', (b) => sessions.selectModel(b))
  apiRoute('session.steer', (b) => sessions.steer(b))
  // 插话的排队状态与撤回：桌面端把待处理插话显示成可撤回气泡，
  // 手机端以前只有 toast，所以「插了像没插」。这两个接口补上那个反馈。
  apiRoute('session.steerPending', (b) => sessions.steerPending(b))
  apiRoute('session.steerRecall', (b) => sessions.steerRecall(b))
  // ask_user_question 的接入：列表 + 回答
  // 注意问答是「会话级」而不是「消息级」——宿主投影会一直记着 active/settled，
  // 所以 App 只需在进会话时拉一次、收到 SSE 提醒后再拉一次。
  apiRoute('session.questions', (b) => sessions.questions(b))
  apiRoute('session.answer', (b) => sessions.answer(b))
  // 按 attachmentId 取回图片字节（base64）：会话历史里的 image 块只有引用，
  // 不取回来就只能显示 [图片] 字样
  apiRoute('session.image', (b) => sessions.image(b))
  apiRoute('session.rename', (b) => sessions.rename(b))
  apiRoute('session.archive', (b) => sessions.archive(b))
  apiRoute('session.pin', (b) => sessions.setPin(b))
  apiRoute('session.fork', (b) => sessions.fork(b))
  apiRoute('session.pins', (b) => sessions.pins(b))
  apiRoute('workspace.list', (b) => sessions.workspaces(b))
  apiRoute('command.list', (b) => sessions.commands(b))
  // 执行宿主命令：手机端靠它调 /rewind 实现「撤回任意提问」
  apiRoute('command.execute', (b) => sessions.executeCommand(b))
  // 撤回候选（哪些提问可以回退到）
  apiRoute('session.rewindCandidates', (b) => sessions.rewindCandidates(b))
  // —— 「我的」页：DSH 账号与余额 ——
  // overview 一次取齐（并发三个读取），另外三个各自单独可用。
  // 余额读取走 Platform，偶发超时，所以 App 侧要允许缺失并显示「读取失败」，
  // 不能把失败当成 0。
  apiRoute('account.overview', () => account.overview())
  apiRoute('account.state', () => account.state())
  apiRoute('account.profile', () => account.profile())
  apiRoute('account.balance', () => account.balance())
  apiRoute('system.restart', (b) => sessions.restart(b))
  // 只读：进设置页先问「能不能重启」，避免盲点才知道不行
  apiRoute('system.restartStatus', () => sessions.restartStatus())

  /**
   * 换一次性下载票据。
   *
   * 浏览器下载器的 GET 不带我们的 cookie，所以不能直接用 fs.download。
   * 这个接口在已鉴权的上下文里签一张 60 秒、一次性的票，
   * 把票拼进下载 URL 交给浏览器。
   */
  apiRoute('fs.ticket', async (b) => {
    const path = typeof b?.path === 'string' ? b.path : ''
    if (path === '') return { ok: false, error: { code: 'invalid-input', message: '缺少 path' } }
    const ticket = auth.issueTicket()
    const url = `${PREFIX}/api/fs.download?path=${encodeURIComponent(path)}&ticket=${encodeURIComponent(ticket)}`
    return { ok: true, value: { url, ticket, expiresIn: 60 } }
  })

  /**
   * 实时状态流（SSE）。
   *
   * 不能用 apiRoute：那条只发 JSON 且必须结束响应，
   * 而 SSE 要保持连接一直开着，逐条 write。
   *
   * 路径参数不用查询串也能带：`?sessionId=xxx` 可选，
   * 不传就是订阅全部会话（列表页需要）。
   */
  routes.push({
    kind: 'exact', path: `${PREFIX}/api/session.live`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      let sessionId = null
      try {
        const u = new URL(req.url ?? '/', 'http://x')
        const sid = u.searchParams.get('sessionId')
        if (sid) sessionId = sid
      } catch {}
      // subscribe 自己会写响应头并保持连接，不会再 sendJson
      live.subscribe(req, res, sessionId)
    },
  })

  /**
   * 主动查一次运行状态（SSE 不可用时的兜底）。
   *
   * App 可以轮询这个，比 SSE 差但比「什么都不更新」好。
   */
  apiRoute('session.running', (b) => {
    const ids = Array.isArray(b?.sessionIds) ? b.sessionIds.filter((x) => typeof x === 'string') : []
    const out = []
    for (const id of ids) {
      if (live.isRunning(id)) {
        out.push({ sessionId: id, running: true, elapsedMs: live.elapsedOf(id) })
      }
    }
    return { ok: true, value: { running: out } }
  })

  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.logger?.info?.(`remote-workbench: 挂载 ${routes.length} 条路由于 ${PREFIX}`)

  return () => {
    live.closeAll()
    for (const d of disposers) d()
  }
}
