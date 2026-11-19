/**
 * lib/live.js — 会话实时流（SSE）
 *
 * 解决的问题：App 发完消息后不知道 agent 什么时候开始跑、跑了多久、什么时候结束，
 * 也不知道它到底说了什么 —— 之前只有「发完 → 手动重进会话」这一条路。
 *
 * 实现方式：Server-Sent Events（不是 WebSocket）。
 *   - dsh-host-webserver 明确支持 `text/event-stream`（见 webserver/lib/index.js 第 113 行，
 *     它专门放过这个 content-type，不做压缩/缓冲）
 *   - SSE 是单向的，正好只需要「服务端推给 App」
 *   - 退化成普通 HTTP，穿过 Cloudflare 隧道没有任何问题（WebSocket 要额外折腾）
 *
 * —— 三类事件，缺一类就会出现「界面不动」——
 *
 *  1. status  ← ctx.on('agent/status')
 *       只管「在跑 / 跑完了」，用来画转圈和计时。
 *
 *  2. event   ← ctx.on('session/event', (session, event) => ...)
 *       **消息正文就在这里**。这是「发完消息不自动更新」的真正原因：
 *       只推 status 的话，App 知道 agent 说完了，但拿不到它说了什么，
 *       只好等用户手动重进会话重新拉 history。
 *
 *  3. chunk   ← ctx.on('agent/assistant-stream', ({ agent, frame }) => ...)
 *       逐字流式增量。没有它，一条长回复要等整段生成完才出现。
 *       注意 chunk **不写进 session log**，只在内存里流过，所以只能从事件拿。
 *
 * 这套三段式是照着 `dsh-mobile-plus/lib/live-stream.js` 的成熟实现对齐的
 * （本机另一个局域网远控插件，同一套宿主事件）。不要再自己发明第四种。
 *
 * 推送内容：
 *   { type: "status", sessionId, running, startedAt?, elapsedMs? }
 *   { type: "event",  sessionId, event }         —— 完整 session 事件（含消息）
 *   { type: "chunk",  sessionId, turn, step, chunk, seq }
 *   { type: "ping" }                              —— 保活，防 Cloudflare 掐空闲连接
 *   { type: "hello", sessions: [...] }            —— 连接建立时的全量快照
 */
import { Buffer } from 'node:buffer'
import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** SSE 保活间隔。Cloudflare 对空闲超过 100 秒的连接会断开，这里留足余量。 */
const PING_MS = 25_000

/**
 * 调试日志。
 *
 * 实时推送这条链路上有两个"静默失败"点（事件订阅抛错被 catch、事件到了但
 * 取不到 sessionId），它们都不会报错也不会写日志，界面只是"不动"。
 * 排查时先看 ~/.dsh/rw-live-debug.log，别靠猜。
 *
 * 默认开启：这条链路曾经整整改不出效果，代价是几 KB 日志，
 * 换来的是「到底订上没订上、收到没有」一目了然。
 * 嫌吵就设 DSH_LIVE_DEBUG=0。
 */
const DEBUG = process.env.DSH_LIVE_DEBUG !== '0'
let dbgStream = null
function dbg(msg) {
  if (!DEBUG) return
  try {
    if (dbgStream === null) {
      mkdirSync(join(homedir(), '.dsh'), { recursive: true })
      dbgStream = createWriteStream(join(homedir(), '.dsh', 'rw-live-debug.log'), { flags: 'a' })
    }
    dbgStream.write(`${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

/**
 * 建一个 LiveHub：维护所有 SSE 连接，并把宿主状态变化广播出去。
 *
 * 生命周期跟着插件走（apply 里创建，dispose 时清干净）。
 */
export function makeLiveHub(ctx) {
  /** 当前所有订阅者：{ res, sessionId } */
  const clients = new Set()

  /** 会话 -> 开始运行的时刻（用来算「深度求索中，用时 13 分 45 秒」） */
  const startedAt = new Map()

  /** 会话 -> 是否在跑 */
  const running = new Map()

  /**
   * 会话 -> 已见过的最新 seq。
   *
   * 流式 chunk 需要挂一个 seq 才能让 App 把它插到正确位置：
   * 真实事件用整数 seq，chunk 用「当前 seq + 极小偏移」排在它后面。
   * 这个做法照抄 dsh-mobile-plus（见其 live-stream.js 第 47-54 行）——
   * 不这么干的话 chunk 会和正式消息打架，出现重复或错序。
   */
  const lastSeqs = new Map()

  /** 会话 -> 当前流式回合 { turn, step }，chunk 事件里没带时用它补。 */
  const activeAttempts = new Map()

  function writeEvent(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // 对端已断，靠 close 事件清理
    }
  }

  function broadcast(payload) {
    if (clients.size === 0) {
      // 没人连着：事件照样到达了，只是没地方推。
      // 这条日志能区分「事件没来」和「事件来了但没客户端」两种完全不同的故障
      dbg(`broadcast 丢弃(type=${payload.type}) 因为 clients=0`)
      return
    }
    let sent = 0
    for (const c of clients) {
      // 只推给订阅了该会话的连接（订阅全部时 sessionId 为 null）
      if (c.sessionId !== null && payload.sessionId !== undefined && c.sessionId !== payload.sessionId) {
        continue
      }
      writeEvent(c.res, payload)
      sent += 1
    }
    if (sent === 0) dbg(`broadcast 丢弃(type=${payload.type}) 因为都被 sessionId 过滤`)
  }

  /**
   * 挂宿主事件。
   *
   * 用 ctx.on 而不是轮询：宿主的这些事件都是事件驱动的，
   * 状态一变就来，延迟只有毫秒级。
   *
   * 三个事件全部加 `{ global: true }`：
   * 宿主按 agent 作用域派发事件，根作用域监听器不加 global 会被过滤掉
   * （这一点在 dsh-mobile-plus 和 dsh-improved-inline-edit 里都验证过）。
   */
  function attach() {
    try {
      ctx.on('agent/status', (payload) => {
        const agent = payload?.agent
        const id = agent?.id
        if (typeof id !== 'string' || id === '') return
        const isRunning = payload?.status === 'running'
        running.set(id, isRunning)
        if (isRunning) {
          if (!startedAt.has(id)) startedAt.set(id, Date.now())
        } else {
          startedAt.delete(id)
          activeAttempts.delete(id)
        }
        broadcast({
          type: 'status',
          sessionId: id,
          running: isRunning,
          startedAt: isRunning ? startedAt.get(id) : null,
          elapsedMs: isRunning && startedAt.has(id) ? Date.now() - startedAt.get(id) : 0,
        })
      }, { global: true })
    } catch {
      // ctx.on 不可用时不致命：SSE 仍能连上，只是收不到推送，
      // App 那边有轮询兜底（见 SessionListView 的 pollRunning）
    }

    /*
     * 消息正文 —— 这一段是「会话内实时更新」的关键。
     *
     * 事件签名是 (session, event)，不是单个 payload 对象。
     * session 用来取会话 id；event 就是那条 session 事件的完整内容
     * （user/message、assistant/message、tool/result…都一样透传）。
     *
     * 为什么原样转发而不裁剪：
     * App 已经有完整的 history 解析逻辑，能处理所有事件类型；
     * 在这里白名单过滤只会让新事件类型莫名其妙消失，很难排查。
     */
    try {
      const off = ctx.on('session/event', (session, event) => {
        const sid = session?.id || session?.sessionId
        if (typeof sid !== 'string' || sid === '') return
        if (event && typeof event.seq === 'number') {
          lastSeqs.set(sid, Math.max(lastSeqs.get(sid) ?? -1, event.seq))
        }
        dbg(`session/event ${event?.type} sid=${String(sid).slice(0, 20)}`)
        broadcast({ type: 'event', sessionId: sid, event })
      }, { global: true })
      dbg(`session/event 订阅成功: ${typeof off}`)
    } catch (e) {
      dbg(`session/event 订阅失败: ${e?.message}`)
    }

    /*
     * 逐字流式增量 —— 让长回复边生成边显示。
     *
     * frame.type 有三种：start / chunk / end，只有 chunk 带正文。
     * start 记下当前 turn/step，end 清掉；因为 chunk 帧本身可能不带这两个字段，
     * 不记的话就不知道这段文字属于第几轮第几步。
     */
    try {
      const off = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (!agent || !frame) return
        const sid = agent.session?.id || agent.id
        if (typeof sid !== 'string' || sid === '') return
        dbg(`assistant-stream frame.type=${frame.type} sid=${String(sid).slice(0, 20)}`)

        if (frame.type === 'start') {
          activeAttempts.set(sid, { turn: frame.turn, step: frame.step })
          return
        }
        if (frame.type === 'end') {
          activeAttempts.delete(sid)
          return
        }
        if (frame.type !== 'chunk' || !frame.chunk) return

        const active = activeAttempts.get(sid) || {}
        const turn = frame.turn ?? active.turn ?? 1
        const step = frame.step ?? active.step ?? 1
        // 挂在「当前最新 seq」之后，用小数偏移保证排序在它后面但不覆盖它
        const baseSeq = (lastSeqs.get(sid) ?? 0) + 1
        const index = typeof frame.index === 'number' ? frame.index : 0

        broadcast({
          type: 'chunk',
          sessionId: sid,
          seq: baseSeq + (index + 1) * 0.0001,
          turn,
          step,
          chunk: frame.chunk,
          time: frame.time || Date.now(),
        })
      }, { global: true })
      dbg(`assistant-stream 订阅成功: ${typeof off}`)
    } catch (e) {
      dbg(`assistant-stream 订阅失败: ${e?.message}`)
    }
  }

  /** 订阅一个响应。sessionId 为 null 表示订阅全部会话。 */
  function subscribe(req, res, sessionId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉 nginx / Cloudflare 的缓冲，否则事件会攒一批才吐出来
      'x-accel-buffering': 'no',
    })
    // 立刻 flush 一个空注释，让客户端马上进入 open 状态
    try { res.write(': connected\n\n') } catch {}

    const client = { res, sessionId }
    clients.add(client)

    // 全量快照：连上就知道当前哪些会话在跑
    const snapshot = []
    for (const [id, isRunning] of running) {
      if (!isRunning) continue
      snapshot.push({
        sessionId: id,
        startedAt: startedAt.get(id) ?? null,
        elapsedMs: startedAt.has(id) ? Date.now() - startedAt.get(id) : 0,
      })
    }
    writeEvent(res, { type: 'hello', sessions: snapshot })

    // 保活
    const timer = setInterval(() => {
      try { res.write(': ping\n\n') } catch {}
    }, PING_MS)

    const cleanup = () => {
      clearInterval(timer)
      clients.delete(client)
      try { res.end() } catch {}
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    return cleanup
  }

  /** 关闭所有连接（插件卸载时）。 */
  function closeAll() {
    for (const c of [...clients]) {
      clients.delete(c)
      try { c.res.end() } catch {}
    }
  }

  attach()

  return {
    subscribe,
    closeAll,
    /** 供非 SSE 场景查询（比如 session.list 里补 running 字段）。 */
    isRunning(sessionId) {
      return running.get(sessionId) === true
    },
    elapsedOf(sessionId) {
      const t = startedAt.get(sessionId)
      return t === undefined ? 0 : Date.now() - t
    },
  }
}
