/**
 * lib/session.js — 会话读写
 *
 * 这里刻意不自己发明调用方式，而是抄 dsh-mobile-plus/lib/rpc.js 里已经
 * 在真实环境跑通的路径：
 *
 *   会话列表： sessionController.list(payload, signal) -> { items }
 *   会话历史： sessions.get(id).snapshotEvents()
 *              冷会话回退 sessionQuery.observeSession(id, { signal })
 *   投递消息： sessionController.prompt({ requestId, clientTimeZone, ... }, signal)
 *   中断：     sessionController.cancel(payload)
 *   插话：     agents.get(sessionId).steer(blocks)
 *
 * 取服务用 ctx.get() 探测，拿不到就返回明确错误。绝不在 inject 里声明
 * 不确定的服务——那会让宿主卡在等待，直接把启动搞挂。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { scanTitles } from './titles.js'

/** 空映射常量，避免每轮新建对象。 */
const EMPTY_MAP = new Map()

function safeGet(ctx, name) {
  try {
    const v = ctx.get(name)
    if (v !== undefined && v !== null) return v
  } catch {}
  return undefined
}

const err = (code, message) => ({ ok: false, error: { code, message } })

/** 历史默认回多少条消息。够看一屏上下文，又不至于让公网传输变慢。 */
const DEFAULT_HISTORY_MESSAGES = 40

/** 前端只渲染这三类内容块，其余（reasoning / tool-call …）一律不发。 */
const RENDERABLE_BLOCKS = new Set(['text', 'image', 'file'])

/**
 * 明确要丢弃的内容块类型。
 *
 * 用「黑名单」而不是白名单：轨迹同步要求把 reasoning / tool-call 一起发过去，
 * 白名单会把它们误删。这里只列确实不渲染的。
 */
const DROPPABLE_BLOCKS = new Set([])

/** 单条工具结果最多回多少字符（命令输出可能几十 KB）。 */
const TOOL_RESULT_MAX = 4000

/** 宿主只接受这四种图片类型（见 prompt parameter schema）。 */
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 消息类事件：只有它们参与分页计数。 */
const MESSAGE_EVENT_TYPES = new Set(['user/message', 'assistant/message'])

/** 解析成 [min,max] 内的整数，非法值回落到 def。 */
function clampInt(v, min, max, def) {
  // null / undefined / 空串都算「没传」，用默认值；
  // 显式传 0 或负数才夹到下限（那是调用方写错了，夹住比报错好用）
  if (v === null || v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 从尾部往前数 maxMessages 条消息事件，返回截断下标。
 *
 * 返回的是「这一页的起点」：slice(cut) 就是最后一页。
 * 返回 0 表示全部事件都在这一页里（没有更早的了）。
 *
 * 注意不能简单按事件数切 —— 一个 turn 里有几十条 step/tool 事件，
 * 按事件数切会把某个 turn 劈成两半，前端看到半截对话。
 */
function findCutBeforeMessages(events, maxMessages) {
  if (!Array.isArray(events) || events.length === 0) return 0
  let count = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!MESSAGE_EVENT_TYPES.has(e?.type)) continue
    count++
    if (count >= maxMessages) {
      // 从中断处再往前退到最近的 turn/start，保证不劈开一个 turn
      for (let j = i; j >= 0; j--) {
        if (events[j]?.type === 'turn/start') return j
      }
      return i
    }
  }
  return 0
}

/**
 * 把一个事件裁成「前端真正会渲染」的样子。
 *
 * —— 裁什么、留什么 ——
 *
 * 删掉 data.stream（流式增量帧，实测占 6.9MB/13.4MB），最终内容已经在
 * message.content 里。但 content 里的块**不能全删**了：
 *
 *   reasoning  思考过程  —— 用户明确要「完全同步桌面端的思考过程」，必须留
 *   text       正文      —— 必须留
 *   tool-call  工具调用  —— 轨迹要显示工具名和参数，必须留
 *   image/file 附件      —— 必须留
 *
 * 之前只留 text/image/file，等于把思考过程和工具轨迹全砍了。
 * 现在改成「只删已知无用的」，其余一律保留 —— 反过来做更安全，
 * 将来宿主加新块类型也能直接透传。
 */
function trimEvent(e) {
  if (!e || !e.data || typeof e.data !== 'object') return e

  // 消息类事件：删 stream、裁 content
  if (MESSAGE_EVENT_TYPES.has(e.type)) {
    const data = e.data
    const nextData = { ...data }
    delete nextData.stream

    const msg = data.message
    if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      const blocks = msg.content.filter((b) => {
        if (!b || typeof b !== 'object') return false
        // 白名单之外一律保留：宁可多传，也不能把轨迹信息裁掉
        return DROPPABLE_BLOCKS.has(b.type) ? false : true
      })
      nextData.message = { ...msg, content: blocks }
    }
    return { ...e, data: nextData }
  }

  // 工具结果：内容可能很大（整个命令输出），截断超长文本
  if (e.type === 'tool/result') {
    const data = e.data
    const msg = data.message
    if (msg && Array.isArray(msg.content)) {
      const nextMsg = {
        ...msg,
        content: msg.content.map((b) => {
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > TOOL_RESULT_MAX) {
            return { ...b, text: b.text.slice(0, TOOL_RESULT_MAX) + '\n…（已截断）' }
          }
          return b
        }),
      }
      return { ...e, data: { ...data, message: nextMsg } }
    }
  }

  return e
}

/** 从一条消息里抠出一行预览文本，给侧边导航用。 */
function previewOf(msg) {
  if (!msg || typeof msg !== 'object') return ''
  if (typeof msg.text === 'string' && msg.text.trim()) {
    return msg.text.trim().replace(/\s+/g, ' ').slice(0, 60)
  }
  if (Array.isArray(msg.content)) {
    const txt = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')
    if (txt) return txt.slice(0, 60)
    if (msg.content.some((b) => b && b.type === 'image')) return '[图片]'
  }
  return ''
}

/**
 * 路径归一化，用于把「会话目录解码出来的路径」和「工作区注册表里的路径」对上。
 * 两者大小写、末尾斜杠、分隔符都可能不一致。
 */
function normalizePath(p) {
  let s = String(p).trim().replace(/\//g, '\\')
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s.toLowerCase()
}

/**
 * 模型选择的规范化。宿主给的是 { provider, model, reasoningEffort? }，
 * 三个字段都得是非空字符串才算合法，否则返回 undefined 让调用方回退。
 */
function asSelection(v) {
  if (!v || typeof v !== 'object') return undefined
  if (typeof v.provider !== 'string' || v.provider === '') return undefined
  if (typeof v.model !== 'string' || v.model === '') return undefined
  return {
    provider: v.provider,
    model: v.model,
    ...(typeof v.reasoningEffort === 'string' && v.reasoningEffort !== ''
      ? { reasoningEffort: v.reasoningEffort }
      : {}),
  }
}

/**
 * 从会话投影里读「这个会话当前用的模型」。
 *
 * 宿主把选择存在 sessionProjections 的 modelSelection 投影里：
 * pending 是「下一次请求要用但还没生效」的，lastUsed 是「上次真的用了」的。
 * 拿不到投影服务就返回 undefined —— 这是纯增强，绝不能让它把整条请求搞挂。
 */
function projectedSelection(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessionsSvc = safeGet(ctx, 'sessions')
    const projections = safeGet(ctx, 'sessionProjections')
    const session = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined
    if (!session || typeof projections?.cachedSnapshot !== 'function') return undefined
    const ms = projections.cachedSnapshot(session)?.values?.modelSelection
    return asSelection(ms?.next) || asSelection(ms?.lastUsed)
  } catch {
    return undefined
  }
}

/**
 * 把宿主的 modelCatalog 形状归一成 App/网页都要的结构。
 *
 * 宿主返回：{ default, routableProviders, groups: [{id,name,models:[...]}], failures }
 * 前端需要：{ current, default, groups, failures, routableProviders? }
 * 两者差的只是 current —— 它取决于当前会话，要单独查投影。
 */
function normalizeCatalog(ctx, sessionId, catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
  const current = projectedSelection(ctx, sessionId)
    || asSelection(catalog?.current)
    || asSelection(catalog?.default)
  return {
    current,
    default: asSelection(catalog?.default),
    groups,
    failures,
    ...(Array.isArray(catalog?.routableProviders)
      ? { routableProviders: catalog.routableProviders }
      : {}),
  }
}

/** 置顶列表的落盘存储（~/.dsh/remote-workbench-pins.json）。 */
function pinsStore() {
  const file = join(
    process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'),
    'remote-workbench-pins.json',
  )
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        return Array.isArray(raw?.ids) ? raw.ids.filter((x) => typeof x === 'string') : []
      } catch {
        return []
      }
    },
    write(ids) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ ids }, null, 2), 'utf8')
      } catch {}
    },
  }
}

/**
 * 读一个会话的 `userQuestions` 投影视图。
 *
 * 宿主用 sessionProjections 统一管线。**必须用 `snapshot()` 而不是 `cachedSnapshot()`**：
 *
 *   - `cachedSnapshot()` 只回「已经 materialize 过」的 cell，没有就直接跳过。
 *   - `snapshot(session, keys)` 会先 `materializeCells(session)` 把历史 fold 出来，
 *     再取指定 key 的视图。
 *
 * 这个区别是致命的：`userQuestions` 投影只在 **服务被实例化时**才 register
 * （`ctx.inject(['sessionProjections'], ...)` 在 UserQuestionService 构造函数里）。
 * 如果这台机器上还没有任何提问走完过一次，cell 就不存在，
 * `cachedSnapshot` 永远返回 `values: {}` —— 看起来像「投影是空的」，
 * 其实只是没算过。用 `cachedSnapshot` 排查时我被这个坑了整整一轮。
 *
 * 传 keys=['userQuestions'] 只取这一个，省得把全部投影都 fold 一遍。
 *
 * @returns `{ active: [...], settled: [...] }`，或 undefined（服务/会话不可用）
 */
function readUserQuestionsView(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessionsSvc = safeGet(ctx, 'sessions')
    const projections = safeGet(ctx, 'sessionProjections')
    const session = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined
    if (!session) return undefined

    // 先试 snapshot（会按需 fold）；拿不到再退回 cachedSnapshot（纯缓存，不 fold）
    if (typeof projections?.snapshot === 'function') {
      const snap = projections.snapshot(session, ['userQuestions'])
      const view = snap?.values?.userQuestions
      if (view && typeof view === 'object') return view
    }
    if (typeof projections?.cachedSnapshot === 'function') {
      const snap = projections.cachedSnapshot(session, ['userQuestions'])
      const view = snap?.values?.userQuestions
      if (view && typeof view === 'object') return view
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 远程重启要用的 relaunch.ps1 候选路径，**按优先级排好**。
 *
 * `restartStatus()` 和 `restart()` 必须用同一份列表 —— 否则会出现
 * 「状态说能重启、真去重启说找不到脚本」的矛盾。
 *
 * ⚠️ 第 3 级曾经只写 `join(homedir(), 'dsh-workspace', ...)`。
 * 这台机器 homedir() 是 `C:\Users\21415`，而开发目录在 **`F:\dsh-workspace`**，
 * 拼出来 `C:\Users\21415\dsh-workspace\...` 永远不存在
 * → 接口一直返回 `reason: "script-missing"` → 重启按钮永久变灰。
 * （2026-11-16 实测坐实：2026-11-15 23:39 起的 Host 一直在报这个。）
 *
 * 所以第 3 级改成「各个盘符下的 dsh-workspace 都试一遍」，
 * 顺带覆盖用户把开发目录放在任意盘的情况。
 */
function restartScriptCandidates() {
  const devRoots = []
  for (let code = 67 /* 'C' */; code <= 90 /* 'Z' */; code += 1) {
    const drive = String.fromCharCode(code)
    devRoots.push(join(`${drive}:\\`, 'dsh-workspace', 'dsh-seamless-restart', 'lib', 'relaunch.ps1'))
  }
  return [
    // 1) 环境变量口子：给特殊安装留的
    process.env.DSH_SEAMLESS_RESTART_HOME
      ? join(process.env.DSH_SEAMLESS_RESTART_HOME, 'lib', 'relaunch.ps1')
      : null,
    // 2) 插件安装后的标准位置
    join(homedir(), '.dsh', 'seamless-restart', 'relaunch.ps1'),
    // 3) 开发目录（先试 homedir 下的，再逐盘符试）
    join(homedir(), 'dsh-workspace', 'dsh-seamless-restart', 'lib', 'relaunch.ps1'),
    ...devRoots,
  ].filter((p) => typeof p === 'string' && p !== '')
}

export function makeSessionOps(ctx) {
  const sessionCtrl = () => safeGet(ctx, 'sessionController')
  const agents = () => safeGet(ctx, 'agents')
  const attachments = () => safeGet(ctx, 'attachments')

  /** 从 sessionController.list 的各种返回形状里抠出数组。 */
  function pickItems(val) {
    if (Array.isArray(val)) return val
    if (Array.isArray(val?.items)) return val.items
    if (Array.isArray(val?.value?.items)) return val.value.items
    if (Array.isArray(val?.sessions)) return val.sessions
    return []
  }

  function normalizeSession(s) {
    /**
     * sessionQuery.listSessions() 返回的是包装结构：
     *   { header: { id, title, ... }, live: boolean, persisted: boolean }
     * 而 sessionController.list() 直接返回扁平的会话对象。
     * 这里统一两种形状，否则标题会全部落到兜底值。
     */
    const h = s.header ?? s
    const rawTitle =
      h.title ?? s.title ?? h.name ?? s.name ?? h.summary ?? s.summary ?? h.label ?? ''
    return {
      id: h.id ?? s.id ?? s.sessionId ?? '',
      title: typeof rawTitle === 'string' ? rawTitle : '',
      updatedAt: h.updatedAt ?? h.modifiedAt ?? h.lastActiveAt
        ?? s.updatedAt ?? s.modifiedAt ?? s.lastActiveAt ?? h.createdAt ?? 0,
      createdAt: h.createdAt ?? s.createdAt ?? 0,
      archived: Boolean(h.archived ?? s.archived ?? h.isArchived ?? s.isArchived),
      workspaceId: h.workspaceId ?? s.workspaceId ?? '',
      kind: h.kind ?? s.kind ?? '',
      messageCount: h.eventCount ?? s.messageCount ?? s.eventCount ?? 0,
      live: s.live === true,
      // 宿主 list() 的 running 字段（agents.get(id).status === "running"）
      running: s.running === true,
      // 子智能体会话标记，后面按日志头部的 origin 字段填
      isSubagent: false,
      parentSession: '',
    }
  }

  return {
    async listSessions(payload) {
      /**
       * 实测结论（重要）：
       *  - sessionQuery.listSessions() 在当前 profile 上返回 0 条：它读的是索引库，
       *    而这些旧会话只在磁盘上、没进索引。
       *  - sessionController.list() 能稳定返回 236 条，但 title 常是空串。
       *
       * 所以策略是：以 sessionController.list() 为准，sessionQuery 只用来兜底补标题。
       */
      const ctrl = sessionCtrl()
      const query = safeGet(ctx, 'sessionQuery')

      let records = []
      let source = 'none'

      if (ctrl && typeof ctrl.list === 'function') {
        try {
          const signal = new AbortController().signal
          const val = await ctrl.list(payload ?? {}, signal)
          records = pickItems(val)
          source = 'sessionController'
        } catch (e) {
          return err(e?.code || 'list-failed', String(e?.message || e))
        }
      }

      // 只有前者为空时才用 sessionQuery 兜底
      if (records.length === 0 && query && typeof query.listSessions === 'function') {
        try {
          const signal = new AbortController().signal
          records = (await query.listSessions(signal)) || []
          source = 'sessionQuery'
        } catch {}
      }

      if (records.length === 0) {
        try {
          writeFileSync(
            join(homedir(), '.dsh', 'rw-list-diag.json'),
            JSON.stringify({
              at: new Date().toISOString(),
              source,
              hasCtrl: Boolean(ctrl),
              ctrlList: typeof ctrl?.list,
              hasQuery: Boolean(query),
              queryListSessions: typeof query?.listSessions,
            }, null, 2),
            'utf8',
          )
        } catch {}
        return { ok: true, value: { items: [] } }
      }

      /**
       * 标题补齐。
       *
       * 宿主的 list() 基本不给 title，sessionTitle.get() 又只对 live 会话有效。
       * 所以直接扫会话日志里的 `session/title` 事件（见 lib/titles.js）：
       * 实测 236 个会话能覆盖 234 个。
       * 有 mtime/size 缓存，未变动的会话不重新解压。
       */
      let titleMap = EMPTY_MAP
      try {
        titleMap = scanTitles()
      } catch (e) {
        // 别静默吞：scanTitles 失败会让所有会话退化成「未命名会话」，
        // 但界面完全看不出原因，排查时只能靠这条日志
        ctx.logger?.warn?.(`remote-workbench: scanTitles 失败: ${e?.stack || e}`)
        try {
          writeFileSync(
            join(homedir(), '.dsh', 'rw-titles-error.log'),
            `${new Date().toISOString()}\n${e?.stack || e}\n`,
            'utf8',
          )
        } catch {}
      }

      /**
       * 标题解析优先级：
       *  1. 会话日志里的 session/title 事件（最准，见 lib/titles.js）
       *  2. 宿主 list() 给的 title（常常是占位值或截断值）
       *  3. live 会话的 sessionTitle.get()
       *  4. 兜底「未命名会话」
       *
       * —— 为什么把「日志扫描」提到最前（实测）——
       *
       * 宿主 list() 的 title 并不等于最终标题，实测有三类问题：
       *   a. 占位值 "未命名会话"（8 个会话就是被这个挡住，永远补不上）
       *   b. 首条消息截断值，如 "你在给一个 QQ 机器人的「记忆"（55 个会话）
       *   c. 空串
       * 以前的条件是 `if (!norm.title)` —— 只有空串才覆盖，于是 a/b 全留着。
       * 现在改成「只要日志里扫到了就用日志的」，宿主值仅作兜底。
       */
      const titleSvc = safeGet(ctx, 'sessionTitle')
      const sessionsSvc = safeGet(ctx, 'sessions')
      const items = []
      for (const r of records) {
        const norm = normalizeSession(r)
        if (!norm.id) continue

        /**
         * 标题 + 工作区都从日志扫描结果里取。
         *
         * 注意 key 的两种形态：
         *   会话记录里的 id  → "session-1c57884f-..."
         *   磁盘目录名       → "1c57884f-..."（老会话就是纯 uuid，没有前缀）
         * scanTitles() 两种 key 都建了，这里仍然两种都试一遍，稳妥。
         */
        const bareId = norm.id.startsWith('session-') ? norm.id.slice('session-'.length) : norm.id
        const hit = titleMap.get(norm.id) || titleMap.get(bareId)

        // 宿主给的占位值当没有：否则会把日志里的正式标题挡住
        if (norm.title === '未命名会话') norm.title = ''

        // 日志扫到的标题优先级最高：它取的是最后一个 session/title，
        // 也就是 LLM 生成的正式标题，而不是首条消息的截断占位
        if (hit?.title) norm.title = hit.title
        if (hit?.workspace) {
          norm.workspacePath = hit.workspace.path
          norm.workspaceLabel = hit.workspace.label
        }

        /**
         * 子智能体会话标记。
         *
         * 宿主的会话日志头部写着 origin: "subagent" 和 parentSession，
         * 这类会话是 agent 自己派生的执行单元（实测 104 个），
         * 不该出现在用户的会话列表里 —— 否则用户会看到一堆自己没开过的对话。
         *
         * 前端据此把它们收进「子智能体」分组，默认折叠。
         */
        if (hit?.origin === 'subagent') {
          norm.isSubagent = true
          if (hit.parentSession) norm.parentSession = hit.parentSession
        }

        if (!norm.title && titleSvc && typeof titleSvc.get === 'function') {
          try {
            const live = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(norm.id) : undefined
            if (live) {
              const snap = titleSvc.get(live)
              if (snap?.title) norm.title = snap.title
            }
          } catch {}
        }

        if (!norm.title) norm.title = '未命名会话'
        items.push(norm)
      }

      /**
       * 标记「所属工作区是否仍然存在」。
       *
       * 桌面端当前只有 4 个工作区（软件 / 插件 / 小说 / QQbot_fish）。
       * 会话目录里能扫出 9 个不同的路径，多出来的是**已解散**工作区残留的会话。
       * 前端只给 liveWorkspaces 里的建组，其余统一并进「已解散」，
       * 否则会冒出一堆早就没了的目录名，比摊平还乱。
       */
      let livePaths = new Set()
      try {
        const wsReg = safeGet(ctx, 'workspaceRegistry')
        const wsCtrl = safeGet(ctx, 'workspaceController')
        let raw = []
        if (wsCtrl && typeof wsCtrl.feed?.baseline === 'function') {
          raw = (wsCtrl.feed.baseline() || {}).items || []
        } else if (wsReg && typeof wsReg.list === 'function') {
          raw = wsReg.list() || []
        }
        for (const w of raw) {
          const p = w.path
          if (typeof p === 'string' && p !== '') livePaths.add(normalizePath(p))
        }
      } catch {}

      /**
       * 归档状态。
       *
       * 宿主的 `sessionController.list()` 不返回 archived 字段（实测 241 条里
       * archived=true 的是 0 条），归档状态只存在 `workspaceRegistry.archivedSessionIds`
       * 这个字符串数组里。以前只把它原样透传给前端，没人拿去标记每个会话，
       * 所以 App 里那个「已归档」分组永远不会出现。
       *
       * 这里把它读出来，逐个会话打上 archived 标记。
       */
      let archivedIds = new Set()
      try {
        const wsReg = safeGet(ctx, 'workspaceRegistry')
        const raw = wsReg?.archivedSessionIds
        if (Array.isArray(raw)) {
          for (const id of raw) {
            if (typeof id !== 'string' || id === '') continue
            archivedIds.add(id)
            // 两种 id 形态都塞进去：带前缀和不带前缀
            archivedIds.add(id.startsWith('session-') ? id.slice('session-'.length) : `session-${id}`)
          }
        }
      } catch {}

      for (const it of items) {
        const p = it.workspacePath ? normalizePath(it.workspacePath) : ''
        // 路径在注册表里才算「活着的」工作区
        it.workspaceLive = p !== '' && livePaths.has(p)
        if (it.workspaceLive) {
          it.workspace = it.workspaceLabel || ''
        } else {
          // 已解散：不暴露原目录名，统一归到「已解散」
          it.workspace = ''
          it.workspaceDissolved = true
        }

        // 归档优先于一切：归档会话不看所属工作区，单独归到「已归档」组
        if (archivedIds.has(it.id)) it.archived = true
      }

      /*
       * 运行状态。
       *
       * 宿主的 sessionController.list() 其实有 running 字段
       * （见 summaryFor: `running: agents.get(id).status === "running"`），
       * 但 normalizeSession 之前没取它。App 需要这个来画「正在生成」的动效，
       * 也用来决定要不要开 SSE 订阅。
       */
      for (const it of items) {
        if (it.running === undefined) it.running = false
      }

      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return { ok: true, value: { items, archivedCount: items.filter((i) => i.archived).length } }
    },

    /**
     * 会话历史。
     *
     * 两条路径（抄 dsh-mobile-plus/lib/events.js 已验证的做法）：
     *  1. 会话正在内存里（本机打开的）→ sessions.get(id).snapshotEvents()
     *  2. 冷会话（没在跑）→ sessionQuery.observeSession(id, { signal })
     *
     * —— 为什么要裁剪（实测数据）——
     *
     * 一个 4090 条事件的会话，原样返回是 13.4 MB：
     *   assistant/message 的 data.stream   6.9 MB   ← 流式增量帧，前端从不用
     *   message.content 里的 reasoning 块   2.1 MB   ← 思考过程，前端只显示 text
     * 本地 loopback 传完只要 315 ms，说明宿主不是瓶颈；但走 Cloudflare 隧道要
     * 21.8 秒，App 还要再解析渲染 20-40 秒。也就是说这些字节全是白传的。
     *
     * App 的 textOf() 和网页的 pickContent() 都只读 text / image / file 三类块，
     * 所以这里按「前端真正会渲染的」裁剪，语义上不丢任何可见信息：
     *
     *   1. 删 assistant/message 的 data.stream（增量帧，最终内容已在 content 里）
     *   2. content 只留 text / image / file，reasoning / tool-call 等丢掉
     *   3. 默认只回最近 maxMessages 条消息所在的那一段，更早的用 beforeSeq 翻页
     *
     * 实测同样会话：13.4 MB → 4.5 MB（瘦身 65%），限 40 条后 → 198 KB。
     */
    async history(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')

      const signal = new AbortController().signal
      let rawEvents = []
      const projections = {}

      // 路径 1：活会话
      const sessionsSvc = safeGet(ctx, 'sessions')
      try {
        const live = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined
        if (live) {
          if (typeof live.snapshotEvents === 'function') rawEvents = live.snapshotEvents() || []
          else if (Array.isArray(live.events)) rawEvents = live.events.slice()
        }
      } catch {}

      // 路径 2：冷会话
      if (rawEvents.length === 0) {
        const query = safeGet(ctx, 'sessionQuery')
        if (query && typeof query.observeSession === 'function') {
          try {
            const obs = await query.observeSession(sessionId, { signal, projectionMode: 'all' })
            if (obs?.events) rawEvents = Array.isArray(obs.events) ? obs.events.slice() : []
            if (obs?.projections?.values) Object.assign(projections, obs.projections.values)
          } catch (e) {
            return err('history-failed', String(e?.message || e))
          }
        }
      }

      const total = rawEvents.length

      // —— 分页：先按 beforeSeq 截断尾部，再向前数 maxMessages 条消息 ——
      const maxMessages = clampInt(payload?.maxMessages, 1, 2000, DEFAULT_HISTORY_MESSAGES)
      const beforeSeq = Number.isSafeInteger(payload?.beforeSeq) && payload.beforeSeq >= 0
        ? payload.beforeSeq
        : total

      // beforeSeq 之后的事件不要（那是「更新的」，属于另一页）
      let windowEvents = beforeSeq < total ? rawEvents.slice(0, beforeSeq) : rawEvents

      // 从尾部往前数 maxMessages 条消息事件，截出这一段
      const cut = findCutBeforeMessages(windowEvents, maxMessages)
      const hasMore = cut > 0
      if (cut > 0) windowEvents = windowEvents.slice(cut)

      // —— 裁剪：只保留前端会渲染的字段 ——
      const events = windowEvents.map(trimEvent)

      // 给客户端一个「接着往前翻」的游标
      const nextBeforeSeq = hasMore
        ? (windowEvents[0]?.seq ?? cut)
        : null

      return {
        ok: true,
        value: {
          events,
          projections: { values: projections },
          count: events.length,
          totalCount: total,
          hasMore,
          beforeSeq: nextBeforeSeq,
          maxMessages,
        },
      }
    },

    /**
     * 发送消息。
     *
     * 宿主签名（typert.host.js 的 prompt parameter schema）：
     *
     *   {
     *     requestId: string,
     *     sessionId: string,
     *     mode: "queue" | "steer",
     *     content: Array<
     *         { type:"text",  text:string }
     *       | { type:"image", mediaType, data, name? }
     *       | { type:"file",  receiptId }
     *     >,
     *     clientTimeZone?: string
     *   }
     *
     * 之前这里把前端的 `{ sessionId, text }` 原样展开丢给宿主，缺 `content` 数组
     * 和 `mode`，宿主在 `request.content.some(...)` 处崩掉：
     *   Cannot read properties of undefined (reading 'some')
     * 也就是说「发消息」功能其实一直是坏的。
     *
     * 现在按宿主契约组装：文本 -> text 块，images -> image 块，files -> file 块。
     */
    async prompt(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      const fn = ctrl.prompt ?? ctrl.send
      if (typeof fn !== 'function') return err('prompt-unsupported', '没有 prompt 方法')

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')

      // ——————— 组装 content 块 ———————
      const content = []

      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (text.trim() !== '') content.push({ type: 'text', text })

      if (Array.isArray(payload?.images)) {
        for (const img of payload.images) {
          if (!img || typeof img.data !== 'string' || img.data === '') continue
          const mt = typeof img.mediaType === 'string' ? img.mediaType : 'image/png'
          if (!ALLOWED_IMAGE_TYPES.has(mt)) continue
          content.push({
            type: 'image',
            mediaType: mt,
            data: img.data,
            ...(typeof img.name === 'string' && img.name !== '' ? { name: img.name } : {}),
          })
        }
      }

      // 文件必须先经 upload 拿到 receiptId（宿主只收 receiptId，不收裸 base64）
      if (Array.isArray(payload?.fileReceipts)) {
        for (const rid of payload.fileReceipts) {
          if (typeof rid === 'string' && rid !== '') content.push({ type: 'file', receiptId: rid })
        }
      }

      if (content.length === 0) {
        return err('invalid-input', '消息内容为空（需要 text / images / fileReceipts 之一）')
      }

      const requestPayload = {
        requestId: (typeof payload?.requestId === 'string' && payload.requestId)
          || `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        // queue = 排到下一轮（默认）；steer = 插话到正在跑的这一步
        mode: payload?.mode === 'steer' ? 'steer' : 'queue',
        content,
        clientTimeZone: (typeof payload?.clientTimeZone === 'string' && payload.clientTimeZone)
          || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }

      try {
        const signal = new AbortController().signal
        const val = await fn.call(ctrl, requestPayload, signal)
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'prompt-failed', String(e?.message || e))
      }
    },

    async cancel(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      const fn = ctrl.cancel ?? ctrl.interrupt ?? ctrl.abort
      if (typeof fn !== 'function') return err('cancel-unsupported', '没有 cancel 方法')
      try {
        // cancel 在宿主侧只传 payload，不带 signal
        const val = await fn.call(ctrl, payload ?? {})
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'cancel-failed', String(e?.message || e))
      }
    },

    /**
     * 模型目录。
     *
     * 宿主这一版的 api-session-controller 上真正存在的是
     * `Remote("modelCatalog")`（见 dsh-api-session-controller/lib/index.js），
     * 不是 `models` / `listModels` —— 之前只按那两名找，于是永远返回
     * models-unsupported。这里按「新版 → 旧版」顺序探测：
     *
     *   modelCatalog()  -> { default, routableProviders, groups, failures }
     *   listModels()    -> 旧版/其它部署可能有的形状
     *   models()        -> 最老的形状
     *
     * 返回值统一成 { current, default, groups, failures }，App 和网页共用。
     */
    async models(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const signal = new AbortController().signal

      try {
        if (typeof ctrl.modelCatalog === 'function') {
          const raw = await ctrl.modelCatalog()
          return { ok: true, value: normalizeCatalog(ctx, sessionId, raw) }
        }
        if (typeof ctrl.listModels === 'function') {
          const raw = await ctrl.listModels({}, signal)
          return { ok: true, value: normalizeCatalog(ctx, sessionId, raw) }
        }
        if (typeof ctrl.models === 'function') {
          const raw = await ctrl.models({}, signal)
          return { ok: true, value: normalizeCatalog(ctx, sessionId, raw) }
        }
        return err('models-unsupported', '宿主没有 modelCatalog / listModels / models 方法')
      } catch (e) {
        return err(e?.code || 'models-failed', String(e?.message || e))
      }
    },

    /**
     * 插话：把「修改要求」注入正在运行的 agent 的下一步。
     * 与 dsh-improved-inline-edit 用同一个原语：agent.steer(message)。
     *
     * ⚠️ 参数必须是**一条完整 message**，不是内容块数组。
     *
     * `ReactLoopAgent.steer(input)` 只是 `send(input, 'next-step', true)`，
     * inbox.splice 会原样把 input 塞进 `agent/inbox/spliced.data.inserted[]`，
     * 然后整条事件落盘。传 `[{type:'text'}]` 就会写成：
     *
     *   "inserted":[[{"type":"text","text":"…"}]]
     *
     * 重读这条会话时宿主在 session-format-v3-to-v4 的 mapEventMessages 里
     * 逐条要求 `inserted[]` 是 message 对象，于是直接抛：
     *
     *   SessionFormatError: agent/inbox/spliced requires message objects
     *   → stored session "…" is corrupt → 手机上「历史加载失败」
     *
     * 这个 bug 曾在 2026-11-15 把 session-73a0c550 写坏过一次
     * （seq 2937），用 06-脚本与诊断/repair-spliced-corrupt.cjs 修回来的。
     * 修好的是数据；根因在这里 —— 别再传裸 blocks。
     *
     * 形状照抄 dsh-improved-inline-edit：
     *   { id, role:'user', content:[...], source:{kind:'user'} }
     * `source.kind` 必须是生产方自有的非空字符串，写 'plugin' 会被 v4 拒收。
     */
    async steer(payload) {
      const svc = agents()
      if (!svc) return err('agents-unavailable', 'agents 服务不可用')
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (!sessionId || !text) return err('invalid-input', '缺少 sessionId 或 text')

      const agent = typeof svc.get === 'function' ? svc.get(sessionId) : undefined
      if (!agent) return err('agent-not-found', '该会话当前没有运行中的 agent（插话只对运行中的任务有效）')
      if (typeof agent.steer !== 'function') return err('steer-unsupported', 'agent 没有 steer 方法')

      try {
        const content = [{ type: 'text', text }]
        const att = attachments()
        const imageErrors = []
        if (Array.isArray(payload?.images) && payload.images.length > 0) {
          if (!att || typeof att.saveImages !== 'function') {
            return err(
              'attachments-unavailable',
              '宿主没有 attachments.saveImages，插话无法带图片',
            )
          }
          for (const img of payload.images) {
            if (!img || typeof img.data !== 'string' || img.data === '') {
              imageErrors.push('图片数据为空')
              continue
            }
            /*
             * 这里原来是 `catch {}` —— 图片存失败被**完全吞掉**，
             * 消息照样发出去、接口照样返回 ok，用户只看到「已注入」但图没了。
             * 现在把失败原因收集起来一并返回，让 App 能如实提示。
             *
             * 常见失败：mediaType 不在宿主白名单（只收 png/jpeg/webp/gif）、
             * 图片超过 imageLimits、base64 不合法。
             */
            try {
              const saved = await att.saveImages([{
                data: img.data,
                mediaType: typeof img.mediaType === 'string' ? img.mediaType : 'image/png',
                ...(typeof img.name === 'string' && img.name !== '' ? { name: img.name } : {}),
              }])
              const ref = Array.isArray(saved) ? saved[0] : saved
              if (ref) content.push({ type: 'image', attachment: ref })
              else imageErrors.push('宿主没有返回图片引用')
            } catch (e) {
              imageErrors.push(String(e?.message || e?.code || e))
            }
          }
        }

        const message = {
          id: `rw-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content,
          source: { kind: 'user' },
        }

        /*
         * —— 两种投递模式（2026-11-16 用户反馈「插话不是实时」）——
         *
         * 先说清楚一个事实：**桌面端插件也不是实时的**。
         * `dsh-improved-inline-edit` 用的同样是 `agent.steer(message)`，
         * 全文没有一处 cancel/abort。它给人的「随时可插」的体感，来自
         * **界面上那条「待处理的插话」气泡**（`[data-pending-steering]`）——
         * 用户看得到「已经进去了，排队等下一步」，所以不焦虑。
         *
         * 手机端以前只弹一个 toast，之后就没了痕迹，于是感觉「没生效」。
         * 所以这里两个改动：
         *   1. 默认仍走 next-step（与桌面端完全一致，不丢任何已产出的内容）
         *   2. 需要「立刻打断」时传 mode='interrupt'，走 cancel + next-turn
         *
         * —— mode='interrupt' 到底做了什么 ——
         *
         *   agent.cancel({ keepInbox: true })  →  中止**当前这个 LLM 请求**
         *   然后把消息放进 next-turn 并唤醒
         *
         * 代价必须如实说：**正在生成的那段输出会被丢弃**（已执行的工具调用
         * 结果会保留，因为它们已经落盘）。所以它适合「我要改方向，别继续了」，
         * 不适合「补充一点要求」。
         */
        const mode = payload?.mode === 'interrupt' ? 'interrupt' : 'queue'

        if (mode === 'interrupt') {
          // 先排队（next-turn 是「下一轮」语义，cancel 后 driver 会取它）
          if (typeof agent.followup === 'function') {
            agent.followup(message)
          } else {
            agent.steer(message)
          }
          // 再打断当前请求；keepInbox 保证刚排队的那条不被清掉
          if (typeof agent.cancel === 'function') {
            try {
              agent.cancel({ kind: 'hook', reason: 'rw-steer-interrupt' }, { keepInbox: true })
            } catch {}
          }
          return {
            ok: true,
            value: {
              sessionId,
              steered: true,
              mode: 'interrupt',
              messageId: message.id,
              imageCount: content.filter((c) => c.type === 'image').length,
              ...(imageErrors.length > 0 ? { imageErrors } : {}),
            },
          }
        }

        const out = await agent.steer(message)
        return {
          ok: true,
          value: {
            sessionId,
            steered: true,
            mode: 'queue',
            messageId: message.id,
            imageCount: content.filter((c) => c.type === 'image').length,
            // 有图存失败就把原因带回去，别让 App 只显示「已注入」
            ...(imageErrors.length > 0 ? { imageErrors } : {}),
            result: out ?? null,
          },
        }
      } catch (e) {
        return err('steer-failed', String(e?.message || e))
      }
    },

    /**
     * 列出仍在排队、尚未被 agent 取走的插话。
     *
     * —— 为什么要这个接口 ——
     *
     * 桌面端把「待处理的插话」渲染成气泡（带撤回按钮），用户能看到自己
     * 那条话确实进去了、正在排队。手机端缺的正是这个反馈，
     * 所以插完像石沉大海，主观上就成了「要等你思考完才能插」。
     *
     * 数据源：`agent.inbox.nextStep` / `agent.inbox.nextTurn`。
     * `nextStep` 是「下一步就带上」，`nextTurn` 是「下一轮才带上」，
     * 两个都可能非空，合并去重返回。
     */
    async steerPending(payload) {
      const svc = agents()
      if (!svc) return err('agents-unavailable', 'agents 服务不可用')
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')

      const agent = typeof svc.get === 'function' ? svc.get(sessionId) : undefined
      if (!agent) return { ok: true, value: { sessionId, items: [] } }

      const inbox = agent.inbox
      if (!inbox) return { ok: true, value: { sessionId, items: [] } }

      const items = []
      const seen = new Set()
      const push = (m, lane) => {
        if (!m || typeof m.id !== 'string' || seen.has(m.id)) return
        seen.add(m.id)
        let text = ''
        try {
          for (const b of m.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string') text += b.text
          }
        } catch {}
        items.push({ id: m.id, text: text.slice(0, 200), lane })
      }
      try { for (const m of inbox.nextStep ?? []) push(m, 'next-step') } catch {}
      try { for (const m of inbox.nextTurn ?? []) push(m, 'next-turn') } catch {}

      return { ok: true, value: { sessionId, items } }
    },

    /**
     * 撤回一条还没被取走的插话。
     *
     * 只对仍在 `next-step` / `next-turn` 队列里的消息有效 —— 一旦 agent
     * 已经把它取走并落盘，就无法「撤回」了（那已经是历史的一部分）。
     * 所以 App 侧要如实提示「已经生效的撤不回」。
     */
    async steerRecall(payload) {
      const svc = agents()
      if (!svc) return err('agents-unavailable', 'agents 服务不可用')
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : ''
      if (!sessionId || !messageId) return err('invalid-input', '需要 sessionId 和 messageId')

      const agent = typeof svc.get === 'function' ? svc.get(sessionId) : undefined
      if (!agent) return err('agent-not-found', '该会话没有运行中的 agent')
      const inbox = agent.inbox
      if (!inbox || typeof inbox.remove !== 'function') {
        return err('inbox-unavailable', '宿主 inbox 不支持 remove')
      }

      try {
        const ok = await inbox.remove(messageId)
        return { ok: true, value: { sessionId, messageId, removed: ok !== false } }
      } catch (e) {
        return err(e?.code || 'recall-failed', String(e?.message || e))
      }
    },

    /**
     * 按 attachmentId 读回一张图片，返回 base64 给 App 直接渲染。
     *
     * **为什么需要这个接口**：会话历史里的 image 块只有引用，没有字节：
     *
     *   {"type":"image","attachment":{
     *      "attachmentId":"sha256:6ebdf2b3…","mediaType":"image/png",
     *      "width":593,"height":295,"bytes":44532,"name":"image.png"}}
     *
     * 所以 App 拿到历史后，图片一律只能显示成 `[图片]` 字样 ——
     * 这正是「发送图片后只有字符、没有缩略图」的根因。要出缩略图必须回来取字节。
     *
     * 走宿主的 `attachments.readImage(ref)`，**不要自己拼磁盘路径**：
     * 它会校验字节仍与 attachmentId 匹配，而手拼
     * `~/.dsh/attachments/v1/objects/<前2位>/<sha>` 既绕过了校验，
     * 也会在存储布局变化时静默失效。
     *
     * 入参：{ attachmentId, mediaType?, width?, height?, name? }
     *   —— 直接把手里的 attachment 对象整个传回来最省事。
     */
    async image(payload) {
      const svc = attachments()
      if (!svc || typeof svc.readImage !== 'function') {
        return err('attachments-unavailable', '宿主没有 attachments.readImage')
      }
      const attachmentId = typeof payload?.attachmentId === 'string' ? payload.attachmentId : ''
      if (attachmentId === '') return err('invalid-input', '缺少 attachmentId')

      // 拼回宿主认的 ImageAttachmentRef 形状（缺字段会校验失败）
      const ref = {
        attachmentId,
        mediaType: typeof payload?.mediaType === 'string' && payload.mediaType !== ''
          ? payload.mediaType
          : 'image/png',
        bytes: Number.isFinite(payload?.bytes) ? Number(payload.bytes) : 0,
        width: Number.isFinite(payload?.width) ? Number(payload.width) : 0,
        height: Number.isFinite(payload?.height) ? Number(payload.height) : 0,
      }
      if (typeof payload?.name === 'string' && payload.name !== '') ref.name = payload.name

      try {
        const stored = await svc.readImage(ref)
        const data = stored?.data
        if (!data || typeof data.length !== 'number') {
          return err('image-empty', '宿主没有返回图片字节')
        }
        const buf = Buffer.from(data.buffer ? Buffer.from(data) : data)
        return {
          ok: true,
          value: {
            attachmentId,
            mediaType: ref.mediaType,
            bytes: buf.length,
            base64: buf.toString('base64'),
            width: ref.width || null,
            height: ref.height || null,
          },
        }
      } catch (e) {
        return err(e?.code || 'image-failed', String(e?.message || e))
      }
    },

    /**
     * 列出这个会话里**还没回答**的提问（`ask_user_question`）。
     *
     * 数据源是宿主的 `userQuestions` 投影，形状（见 dsh-user-questions/lib/types/projection.js）：
     *
     *   {
     *     active:  [{ callId, questions: [...], state: 'open' | 'continued' }],
     *     settled: [{ callId, answers: [...] }],
     *   }
     *
     * `state` 的语义差别很关键：
     *   - `open`      —— 工具调用还挂着，只有**原始请求**那条路能回答；
     *                    浏览器断线重连会再收到一次，所以能答。
     *   - `continued` —— 已经超时/进程没了，走 `userQuestions.answer()` 把答复
     *                    steer 进 agent。**这是手机端唯一可靠的路**。
     *
     * 手机是「慢速远端」，等它反应过来时窗口多半已经 `continued` 了，
     * 所以下面 `answer()` 两条路都实现，按 state 分流。
     *
     * 每道题的结构（question）：
     *   { id, question, detail?, header?, options?: [{label, description?}], multiSelect? }
     */
    async questions(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')
      try {
        const view = readUserQuestionsView(ctx, sessionId)
        if (view === undefined) {
          // 投影读不到不算错：这个会话就是没问过问题。
          // 只有明确「服务缺失」才值得报错，这里统一返回空列表 + 原因。
          return { ok: true, value: { sessionId, active: [], settled: [], reason: 'projection-unavailable' } }
        }
        const active = Array.isArray(view?.active) ? view.active : []
        const settled = Array.isArray(view?.settled) ? view.settled : []
        return { ok: true, value: { sessionId, active, settled } }
      } catch (e) {
        return err('questions-failed', String(e?.message || e))
      }
    },

    /**
     * 回答一道提问。
     *
     * 入参：
     *   {
     *     sessionId,
     *     callId,                    // 提问批次 id，来自 questions()
     *     answers: [{ id, selected: string[], custom?: string }],
     *   }
     *
     * 宿主契约（`userQuestions.answer`，见 cordis Service inspect）：
     *   answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean
     *   AskUserQuestionAnswer = { answers: [{ id, selected: string[], custom?: string }] }
     *
     * 两个必须遵守的约束（写错会抛）：
     *   1. **这个批次里的每道题都要各答一次**，多答漏答都抛 `BAD_ANSWER`
     *   2. 同一批次只能排一条回复，重复答会抛 `REPLY_QUEUED`
     *
     * 单选的语义：`custom` 会**覆盖**选项，此时 `selected` 要留空数组；
     * 多选则 `custom` 是补充说明。跳过某题要显式给 `{ id, selected: [] }`，
     * 否则整批校验不过。
     */
    async answer(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const callId = typeof payload?.callId === 'string' ? payload.callId : ''
      const answers = Array.isArray(payload?.answers) ? payload.answers : null
      if (!sessionId || !callId) return err('invalid-input', '缺少 sessionId 或 callId')
      if (!answers || answers.length === 0) return err('invalid-input', 'answers 不能为空')

      const svc = safeGet(ctx, 'userQuestions')
      if (!svc || typeof svc.answer !== 'function') {
        return err('user-questions-unavailable', '宿主没有 userQuestions 服务，无法回答提问')
      }
      const agentsSvc = agents()
      if (!agentsSvc || typeof agentsSvc.get !== 'function') {
        return err('agents-unavailable', 'agents 服务不可用')
      }
      const agent = agentsSvc.get(sessionId)
      if (!agent) {
        return err(
          'agent-not-found',
          '该会话当前没有运行中的 agent。提问超时后要回答，需要先让会话恢复（发一条消息或重开）',
        )
      }

      /*
       * 先看这道题的 state —— 决定「能不能立刻答」。
       *
       *   open      → 工具调用还挂着，只有**原始请求**(asker 的 Promise)能回答。
       *               远端没有那条通路，现在提交会被宿主静默吃掉
       *               （实测：返回 answered:false，题目停在 active 不动）。
       *               必须等它超时变成 continued。
       *   continued → 走 userQuestions.answer()，把答复 steer 进 agent。远端唯一可靠的路。
       *
       * 这个分支是实测踩出来的：第一次在 open 状态下提交，
       * 接口回 ok:true + answered:false，然后题目一直卡在 active，
       * 看起来像「答了没反应」。远端绝不能假装成功，得说清楚要等。
       */
      const view = readUserQuestionsView(ctx, sessionId)
      const active = Array.isArray(view?.active) ? view.active : []
      const target = active.find((q) => q && q.callId === callId)
      if (target && target.state === 'open') {
        return err(
          'question-still-open',
          '这道提问还在等待窗口内（agent 正阻塞等桌面端回答）。' +
          '远端要等它超时转成「可补答」才能提交，稍后再试或直接发消息推进任务',
        )
      }

      // 整理成宿主严格要求的形状：只保留认识的字段，别把前端多余字段透传过去。
      const normalized = []
      for (const item of answers) {
        if (!item || typeof item.id !== 'string' || item.id === '') {
          return err('invalid-input', 'answers[].id 必须是非空字符串')
        }
        const selected = Array.isArray(item.selected)
          ? item.selected.filter((s) => typeof s === 'string')
          : []
        const row = { id: item.id, selected }
        if (typeof item.custom === 'string' && item.custom !== '') row.custom = item.custom
        normalized.push(row)
      }

      try {
        const ok = await svc.answer(agent, callId, { answers: normalized })
        return { ok: true, value: { sessionId, callId, answered: ok !== false } }
      } catch (e) {
        const code = e?.code || e?.name || 'answer-failed'
        const msg = String(e?.message || e)
        // 把宿主的错误码翻译成人话，App 里能直接弹给用户看
        if (code === 'BAD_ANSWER') {
          return err('bad-answer', `这批提问里每道题都要答一次、且不能重复（${msg}）`)
        }
        if (code === 'REPLY_QUEUED') {
          return err('reply-queued', '这一批已经有一条回复排在队列里了，等它被 agent 收下再试')
        }
        return err(code, msg)
      }
    },

    /**
     * 切换当前会话的模型。
     *
     * 宿主签名（typert.host.js 的 selectModel parameter schema）：
     *   { sessionId, provider, model, reasoningEffort? } -> { selected: {...} }
     * 缺 sessionId/provider/model 时先本地拒掉，别把 400 甩给用户看。
     */
    async selectModel(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      const fn = ctrl.selectModel ?? ctrl.setModel
      if (typeof fn !== 'function') return err('selectmodel-unsupported', '没有 selectModel 方法')

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const provider = typeof payload?.provider === 'string' ? payload.provider : ''
      const model = typeof payload?.model === 'string' ? payload.model : ''
      if (!sessionId || !provider || !model) {
        return err('invalid-input', '需要 sessionId / provider / model')
      }

      const request = {
        sessionId,
        provider,
        model,
        ...(typeof payload?.reasoningEffort === 'string' && payload.reasoningEffort !== ''
          ? { reasoningEffort: payload.reasoningEffort }
          : {}),
      }

      try {
        const val = await fn.call(ctrl, request)
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'selectmodel-failed', String(e?.message || e))
      }
    },

    /**
     * 新建会话。
     *
     * 宿主签名（typert.host.js 的 create parameter schema）：
     *   { workspaceId?, cwd?, sessionId?, agentPreset? } -> { sessionId, agentPreset? }
     *
     * workspaceId 和 cwd 二选一：桌面端传 workspaceId 表示「在这个工作区里开」，
     * 或直接传 cwd 指定目录。两个都给时宿主以 workspaceId 为准。
     */
    async create(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      if (typeof ctrl.create !== 'function') return err('create-unsupported', '没有 create 方法')

      const request = {}
      if (typeof payload?.workspaceId === 'string' && payload.workspaceId !== '') {
        request.workspaceId = payload.workspaceId
      }
      if (typeof payload?.cwd === 'string' && payload.cwd !== '') {
        request.cwd = payload.cwd
      }
      if (typeof payload?.agentPreset === 'string' && payload.agentPreset !== '') {
        request.agentPreset = payload.agentPreset
      }
      // 两个定位都没给就没法建（宿主会用自己的默认 cwd，但那样用户不知道建到哪了）
      if (request.workspaceId === undefined && request.cwd === undefined) {
        return err('invalid-input', '需要 workspaceId 或 cwd')
      }

      try {
        const val = await ctrl.create(request)
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'create-failed', String(e?.message || e))
      }
    },

    /**
     * 会话的 turn 摘要（侧边轨迹导航用）。
     *
     * 桌面端右侧有一列小横线，每条代表一次提问，点击能跳到那一条。
     * 这里给它提供数据：每个 turn 的序号、第一条用户消息的预览、起止 seq。
     *
     * **只扫 turn/start 和 user/message**，不解出正文，所以即使几千条事件也很快。
     * 返回的 seq 让前端能定位到具体气泡。
     */
    async turns(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')

      const signal = new AbortController().signal
      let rawEvents = []

      const sessionsSvc = safeGet(ctx, 'sessions')
      try {
        const live = typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined
        if (live) {
          if (typeof live.snapshotEvents === 'function') rawEvents = live.snapshotEvents() || []
          else if (Array.isArray(live.events)) rawEvents = live.events.slice()
        }
      } catch {}

      if (rawEvents.length === 0) {
        const query = safeGet(ctx, 'sessionQuery')
        if (query && typeof query.observeSession === 'function') {
          try {
            const obs = await query.observeSession(sessionId, { signal, projectionMode: 'all' })
            if (obs?.events) rawEvents = Array.isArray(obs.events) ? obs.events.slice() : []
          } catch (e) {
            return err('history-failed', String(e?.message || e))
          }
        }
      }

      /*
       * 一个 turn 的结构：
       *   turn/start { turn: N }
       *   user/message          ← 这次提问
       *   ... assistant/message / tool/call / tool/result ...
       *   turn/end
       *
       * 按 turn/start 切段，取段内第一条 user/message 的文本做预览。
       */
      const turns = []
      let cur = null
      for (const e of rawEvents) {
        const t = e?.type
        if (t === 'turn/start') {
          cur = {
            turn: e.data?.turn ?? turns.length + 1,
            startSeq: e.seq,
            endSeq: null,
            preview: '',
            userSeq: null,
            messageCount: 0,
          }
          turns.push(cur)
          continue
        }
        if (!cur) continue
        if (t === 'turn/end') {
          cur.endSeq = e.seq
          continue
        }
        if (t === 'user/message' && cur.userSeq === null) {
          cur.userSeq = e.seq
          // 注意：user/message 的 data 本身就是消息（有 role/content），
          // 没有 data.message 这一层；assistant/message 才有。两种都兜住。
          cur.preview = previewOf(e.data?.message ?? e.data)
        }
        if (t === 'assistant/message') cur.messageCount++
      }

      // 没有 turn/start 的老会话：退化成「每条 user/message 算一次提问」
      if (turns.length === 0) {
        let n = 0
        for (const e of rawEvents) {
          if (e?.type !== 'user/message') continue
          n++
          turns.push({
            turn: n,
            startSeq: e.seq,
            endSeq: null,
            preview: previewOf(e.data?.message ?? e.data),
            userSeq: e.seq,
            messageCount: 0,
          })
        }
      }

      return { ok: true, value: { turns, total: rawEvents.length } }
    },

    /**
     * 改名。
     *
     * 宿主的 sessionController.rename({ sessionId, title }) 会走
     * session/title 事件写进日志，所以桌面端和 App 立刻都能看到新名字。
     */
    async rename(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      if (typeof ctrl.rename !== 'function') return err('rename-unsupported', '没有 rename 方法')

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')
      if (!title) return err('invalid-input', '标题不能为空')

      try {
        const val = await ctrl.rename({ sessionId, title })
        // 改名写的是新的 session/title 事件，日志文件会变长（size 变化），
        // 缓存自然会失效；但保险起见还是主动作废一次，避免同尺寸改名漏掉
        try {
          const { invalidateTitle } = await import('./titles.js')
          invalidateTitle?.(sessionId)
        } catch {}
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'rename-failed', String(e?.message || e))
      }
    },

    /**
     * 归档 / 取消归档。
     *
     * 归档状态在宿主里归 workspaceController 管（它写 workspaceRegistry 的
     * archivedSessionIds），不是 sessionController —— 这也是为什么
     * sessionController.list() 里根本没有 archived 字段。
     */
    async archive(payload) {
      const wsCtrl = safeGet(ctx, 'workspaceController')
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')
      const wantArchive = payload?.archived !== false

      // 优先走宿主的正规接口
      if (wsCtrl && typeof wsCtrl.archiveSession === 'function') {
        try {
          const fn = wantArchive
            ? wsCtrl.archiveSession.bind(wsCtrl)
            : (wsCtrl.unarchiveSession || wsCtrl.archiveSession).bind(wsCtrl)
          await fn({ sessionId, stopActivity: payload?.stopActivity === true })
          return { ok: true, value: { sessionId, archived: wantArchive } }
        } catch (e) {
          // 会话正在跑时宿主会拒绝归档（workspace/session-active），把话说明白
          if (e?.code === 'workspace/session-active') {
            return err('session-active', '这个会话正在运行，先停止再归档')
          }
          if (e?.code) return err(e.code, String(e?.message || e))
        }
      }

      // 退化路径：直接改 registry 的 archivedSessionIds
      const reg = safeGet(ctx, 'workspaceRegistry')
      if (reg && Array.isArray(reg.archivedSessionIds)) {
        try {
          const set = new Set(reg.archivedSessionIds)
          if (wantArchive) set.add(sessionId)
          else set.delete(sessionId)
          reg.archivedSessionIds = [...set]
          return { ok: true, value: { sessionId, archived: wantArchive } }
        } catch (e) {
          return err('archive-failed', String(e?.message || e))
        }
      }
      return err('archive-unsupported', '宿主没有归档接口')
    },

    /** 置顶 / 取消置顶。优先用宿主接口，退化到本地文件（见 pinsStore）。 */
    async setPin(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')
      const pinned = payload?.pinned !== false

      const wsCtrl = safeGet(ctx, 'workspaceController')
      if (wsCtrl) {
        try {
          const fn = pinned
            ? (wsCtrl.pinSession || wsCtrl.pin)
            : (wsCtrl.unpinSession || wsCtrl.unpin)
          if (typeof fn === 'function') {
            await fn.call(wsCtrl, { sessionId })
            return { ok: true, value: { sessionId, pinned } }
          }
        } catch (e) {
          if (e?.code) return err(e.code, String(e?.message || e))
        }
      }

      // 退化：本地 pins 文件（桌面端看不到，但 App 内排序有效）
      const store = pinsStore()
      const ids = new Set(store.read())
      if (pinned) ids.add(sessionId)
      else ids.delete(sessionId)
      const next = [...ids]
      store.write(next)
      return { ok: true, value: { sessionId, pinned, ids: next, local: true } }
    },

    /**
     * 分叉会话。
     *
     * 宿主的 sessionController.fork({ sessionId, atSeq? }) 会复制出一条新会话，
     * 返回 { sessionId }。atSeq 不传就是从当前位置分叉。
     */
    async fork(payload) {
      const ctrl = sessionCtrl()
      if (!ctrl) return err('session-controller-unavailable', 'sessionController 不可用')
      if (typeof ctrl.fork !== 'function') return err('fork-unsupported', '没有 fork 方法')

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return err('invalid-input', '缺少 sessionId')

      const request = { sessionId }
      if (Number.isSafeInteger(payload?.atSeq) && payload.atSeq >= 0) request.atSeq = payload.atSeq

      try {
        const val = await ctrl.fork(request)
        return { ok: true, value: val }
      } catch (e) {
        return err(e?.code || 'fork-failed', String(e?.message || e))
      }
    },

    /**
     * 置顶会话。
     *
     * 宿主把这个能力做成独立的 pins 存储，这里退化成文件读写：
     * 存到 ~/.dsh/remote-workbench-pins.json，前端只做展示排序。
     * 不去猜宿主的 pins 服务名——猜错就是又一次启动卡死。
     */
    async pins(payload) {
      const store = pinsStore()
      if (payload?.action === 'set') {
        const ids = Array.isArray(payload.ids) ? payload.ids.filter((x) => typeof x === 'string') : []
        store.write(ids)
        return { ok: true, value: { ids } }
      }
      return { ok: true, value: { ids: store.read() } }
    },

    async pin(payload) {
      const store = pinsStore()
      const id = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!id) return err('invalid-input', '缺少 sessionId')
      const ids = new Set(store.read())
      if (payload?.pinned === false) ids.delete(id)
      else ids.add(id)
      const next = [...ids]
      store.write(next)
      return { ok: true, value: { ids: next } }
    },

    /** 工作区列表（用于分栏/筛选）。 */
    async workspaces() {
      const ws = safeGet(ctx, 'workspaceRegistry')
      const ctrl = safeGet(ctx, 'workspaceController')
      try {
        let items = []
        if (ctrl && typeof ctrl.feed?.baseline === 'function') {
          const base = ctrl.feed.baseline() || {}
          items = base.items || []
        } else if (ws && typeof ws.list === 'function') {
          items = ws.list() || []
        }

        const normalized = (Array.isArray(items) ? items : []).map((w) => ({
          id: w.workspaceId ?? w.id ?? '',
          path: w.path ?? '',
          title: w.title ?? (w.path ? String(w.path).split(/[\\/]/).filter(Boolean).pop() : '') ?? '未命名工作区',
          sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
          createdAt: w.createdAt ?? 0,
          updatedAt: w.updatedAt ?? 0,
        })).filter((w) => w.id)

        return {
          ok: true,
          value: {
            items: normalized,
            archivedSessionIds: [...(ws?.archivedSessionIds || [])],
          },
        }
      } catch (e) {
        return err('workspace-failed', String(e?.message || e))
      }
    },

    /** 命令列表（/ 触发的那些）。 */
    async commands() {
      const cmds = safeGet(ctx, 'commands')
      try {
        if (cmds && typeof cmds.list === 'function') {
          const val = await cmds.list()
          return { ok: true, value: { items: Array.isArray(val) ? val : [] } }
        }
        return { ok: true, value: { items: [] } }
      } catch (e) {
        return err('commands-failed', String(e?.message || e))
      }
    },

    /**
     * 执行一条宿主命令（比如 `/rewind @<seq>`）。
     *
     * —— 为什么手机端需要它（2026-11-16 用户需求）——
     *
     * 用户要「所有提问都能撤回」。DSH 自己**没有删消息的 API**，
     * 但桌面端装了 `dsh-rewind-plugin`，它通过注册 `/rewind` 命令
     * 实现了「就地回退到任意更早的用户消息」：
     *
     *   往会话日志**追加**一个带 `surfaceOp: replace` 的 user/message 标记，
     *   把目标消息之后的**模型可见内容**全部遮蔽掉。
     *   日志本身只追加、不删改（所以审计痕迹还在），
     *   而下一轮请求的上下文从目标消息开始 —— 语义上就是「撤回」。
     *
     * 那个插件只注册命令，不暴露 HTTP 接口，所以手机端只能走
     * `commands.execute` 这条路。
     *
     * 宿主契约（来自 ctx.commands 的 Remote 签名）：
     *   execute(agent, line, submittedAttachments, signal) -> CommandExecution | undefined
     *
     * 注意第一个参数是 **Agent 对象**，不是 sessionId —— 要用
     * `agents.get(sessionId)` 换。
     */
    async executeCommand(payload) {
      const cmds = safeGet(ctx, 'commands')
      const svc = agents()
      if (!cmds || typeof cmds.execute !== 'function') {
        return err('commands-unavailable', '宿主没有 commands.execute')
      }
      if (!svc || typeof svc.get !== 'function') {
        return err('agents-unavailable', 'agents 服务不可用')
      }

      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const line = typeof payload?.line === 'string' ? payload.line.trim() : ''
      if (!sessionId || !line) return err('invalid-input', '需要 sessionId 和 line')

      const agent = svc.get(sessionId)
      if (!agent) return err('agent-not-found', '该会话没有活着的 agent（冷会话先随便发条消息唤醒）')

      try {
        const out = await cmds.execute(agent, line, [], new AbortController().signal)
        return { ok: true, value: out ?? null }
      } catch (e) {
        return err(e?.code || 'command-failed', String(e?.message || e))
      }
    },

    /**
     * 列出可以「撤回」的提问（`/rewind` 的候选）。
     *
     * 直接复用 `dsh-rewind-plugin` 的语义：遍历会话日志里**人类用户**的
     * user/message，从新到旧编号。`index` 是 1-based 的「第几条最近的提问」，
     * 正好对上 `/rewind <index>` 的参数形式。
     *
     * 只取 `source.kind === 'user'` 的：
     * 插件注入的上下文、压缩检查点、工具结果回填也都会落成 user/message，
     * 但它们不是用户说的话，回退到那里没有意义（rewind 插件本身也是这么判的）。
     */
    async rewindCandidates(payload) {
      const sid = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sid) return err('invalid-input', '缺少 sessionId')

      const limit = clampInt(payload?.limit, 1, 100, 50)

      /*
       * 取事件：优先用内存里的会话（活的），拿不到再走历史接口的逻辑。
       * 这里直接用 sessions 服务读快照，和 history() 用的是同一条路。
       */
      let events = []
      try {
        const svc = safeGet(ctx, 'sessions')
        const session = typeof svc?.get === 'function' ? svc.get(sid) : undefined
        if (session && typeof session.snapshotEvents === 'function') {
          events = session.snapshotEvents() ?? []
        }
      } catch {}

      if (events.length === 0) {
        // 冷会话：退回磁盘读（history 已经实现了这套，直接复用）
        try {
          const h = await this.history({ sessionId: sid, maxMessages: 100000 })
          if (h?.ok && Array.isArray(h.value?.events)) events = h.value.events
        } catch {}
      }

      const out = []
      let index = 0
      // 从后往前扫，index 从 1 开始（1 = 最近的一条提问）
      for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
        const e = events[i]
        if (e?.type !== 'user/message') continue
        const data = e.data ?? {}
        const msg = data.message ?? data
        // 只要真正由人发出的：插件注入 / 压缩检查点 / 工具回填的 source 不是 'user'
        const kind = msg?.source?.kind ?? data?.source?.kind
        if (kind !== 'user') continue

        let text = ''
        try {
          for (const b of msg?.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string') text += b.text
          }
        } catch {}
        text = text.trim()
        if (text === '') continue

        index++
        out.push({
          seq: typeof e.seq === 'number' ? e.seq : -1,
          index,
          preview: text.replace(/\s+/g, ' ').slice(0, 100),
          time: typeof e.time === 'number' ? e.time : 0,
        })
      }

      return { ok: true, value: { sessionId: sid, items: out } }
    },

    /**
     * 远程重启 DSH。
     *
     * —— 为什么不自己写重启链路 ——
     *
     * 「杀外壳 -> 用 explorer 派生助手 -> 助手拉起新实例」这套有三处必踩的坑：
     *   1. 宿主的父进程（Electron 主进程）带 KILL_ON_JOB_CLOSE 的 job object，
     *      宿主直接 spawn 的子进程会和它一起死 —— 必须交给 explorer.exe 派生
     *   2. taskkill 不带 /F 会被 DSH 收进托盘，进程不退，空等到超时
     *   3. 外壳退出后必须等端口释放再拉起，否则新实例绑不上
     *
     * dsh-seamless-restart 的 relaunch.ps1 已经把这些都处理了，这里直接复用：
     * 写一个 VBS 包一层（VBS 由 explorer 启动，全程 Unicode，能处理中文路径），
     * 由 explorer.exe 派发，然后再也不管它 —— 因为本进程马上就要被杀掉。
     *
     * —— 为什么不用它的 HTTP 端点 ——
     *
     * /dsh-seamless-restart/restart 有 connection.requestRejection 鉴权
     * （需要 dsh-auth-* cookie），插件内部拿不到那个 cookie。
     * 而 relaunch.ps1 就在磁盘上，直接调用更可靠。
     */
    /**
     * 远程重启的状态查询 —— 不产生任何副作用。
     *
     * 给 App 的设置页用：进页面先问一次「现在能不能重启、上次什么时候重启过」，
     * 用户看到明确了再决定点不点。没有这个的话按钮只能盲点，
     * 失败了才知道不行。
     *
     * 和 seamless-restart 的 `/dsh-seamless-restart/status.json` 是一套语义，
     * 但这里自己算一遍：我们的 App 走 /rw 前缀带着设备 cookie，
     * 没必要为了一次状态查询再去跨插件调 HTTP。
     */
    async restartStatus() {
      const { existsSync } = await import('node:fs')

      // 脚本在不在
      //
      // 探测顺序见 restartScriptCandidates()（与 restart 共用，顺序必须一致）
      const candidates = restartScriptCandidates()
      let script = null
      for (const p of candidates) {
        if (existsSync(p)) { script = p; break }
      }

      // 外壳（父进程）认不认得出
      let canRestart = process.platform === 'win32' && script !== null
      let reason = 'desktop-shell'
      let shellPid = null
      let shellExe = null

      if (process.platform !== 'win32') {
        canRestart = false
        reason = 'unsupported-platform'
      } else if (script === null) {
        canRestart = false
        reason = 'script-missing'
      } else {
        const parentPid = Number(process.ppid)
        if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
          canRestart = false
          reason = 'parent-unknown'
        } else {
          try {
            const { execFileSync } = await import('node:child_process')
            const out = execFileSync(
              'powershell.exe',
              ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${parentPid}").ExecutablePath`],
              { encoding: 'utf8', windowsHide: true, timeout: 8000 },
            ).trim()
            if (out && existsSync(out)) {
              shellPid = parentPid
              shellExe = out
            } else {
              canRestart = false
              reason = 'shell-exe-missing'
            }
          } catch {
            canRestart = false
            reason = 'parent-unknown'
          }
        }
      }

      // 上次重启时间：读 seamless-restart 的 restart.log 最后一条
      let lastRestart = null
      try {
        const logPath = join(homedir(), '.dsh', 'seamless-restart', 'restart.log')
        if (existsSync(logPath)) {
          const txt = readFileSync(logPath, 'utf8')
          const lines = txt.trimEnd().split('\n')
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            const m = /^(\S+)\s+\[relaunch\]\s+helper started/.exec(lines[i])
            if (m) {
              const at = Date.parse(m[1])
              if (Number.isFinite(at)) {
                lastRestart = { at, agoMs: Date.now() - at }
              }
              break
            }
          }
        }
      } catch {}

      return {
        ok: true,
        value: {
          platform: process.platform,
          canRestart,
          reason,
          shellPid,
          shellExe,
          hostPid: process.pid,
          hostUptimeMs: Math.round(process.uptime() * 1000),
          lastRestart,
        },
      }
    },

    async restart(payload) {
      if (process.platform !== 'win32') {
        return err('restart-unsupported', '远程重启目前只支持 Windows 桌面版')
      }

      const { spawn } = await import('node:child_process')
      const { existsSync, writeFileSync, mkdirSync } = await import('node:fs')

      // ——————— 1) 找脚本 ———————
      // 按优先级探测（与 restartStatus 共用 restartScriptCandidates()，
      // 保证两边顺序完全一致 —— 否则会出现
      // 「状态说能重启、真去重启说找不到脚本」的矛盾）
      const candidates = restartScriptCandidates()
      let script = null
      for (const p of candidates) {
        if (existsSync(p)) { script = p; break }
      }
      if (script === null) {
        return err(
          'restart-unsupported',
          '找不到 dsh-seamless-restart 的 relaunch.ps1，无法重启',
        )
      }

      // ——————— 2) 认出外壳（不是宿主） ———————
      /*
       * 进程结构：
       *   DeepSeek Harness.exe            <- 外壳，要杀的是它
       *     └─ ... dsh-desktop-host       <- 宿主，插件跑在这里（process.pid）
       *
       * 要杀的是**父进程**。直接 kill 自己等于中途掐断本会话。
       */
      const parentPid = Number(process.ppid)
      if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
        return err('restart-unsupported', '拿不到外壳进程 PID')
      }
      let exePath = ''
      try {
        const { execFileSync } = await import('node:child_process')
        const out = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${parentPid}").ExecutablePath`],
          { encoding: 'utf8', windowsHide: true, timeout: 8000 },
        ).trim()
        if (out) exePath = out
      } catch {}
      if (!exePath || !existsSync(exePath)) {
        return err('restart-unsupported', `外壳可执行文件不存在：${exePath || '(未知)'}`)
      }

      // ——————— 3) 写 VBS 包一层 ———————
      /*
       * 为什么用 VBS 而不是直接 spawn explorer + 参数：
       *   explorer.exe 的语义是「打开这个文件」，它对 .ps1 会按关联打开（可能弹编辑器）。
       *   .vbs 由 wscript 执行，能精确控制隐藏窗口、传参、编码。
       *   引号一定要用 Chr(34) 拼，直接写 " 会被 VBS 解析成字符串结束（踩过）。
       *
       * ⚠ 已踩的坑：VBS 里**不能** `wscript.exe //B <x>.ps1`。
       *   wscript 只认 .vbs/.js，喂 .ps1 它静默失败、退出码 0、什么都不发生，
       *   于是「远程重启」看起来成功了（接口返回 ok）但 DSH 根本不重启。
       *   必须用 powershell.exe -File 显式解释 .ps1。
       */
      const stateDir = join(homedir(), '.dsh', 'remote-workbench')
      try { mkdirSync(stateDir, { recursive: true }) } catch {}
      const wrapper = join(stateDir, 'relaunch-wrapper.vbs')
      const q = (s) => `" & Chr(34) & "${s}" & Chr(34) & "`
      const vbs = [
        'Option Explicit',
        `CreateObject("WScript.Shell").Run ` +
          `"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ` +
          `${q(script)} -ShellPid ${parentPid} -ExePath ${q(exePath)}", 0, False`,
        '',
      ].join('\r\n')
      try {
        writeFileSync(wrapper, vbs, 'utf8')
      } catch (e) {
        return err('restart-failed', `写启动脚本失败：${String(e?.message || e)}`)
      }

      // ——————— 4) 交给 explorer 派发 ———————
      /*
       * explorer.exe 是已经在跑的、在 job object 之外的进程，
       * 由它启动的助手不会随宿主一起死。
       */
      try {
        const child = spawn('explorer.exe', [wrapper], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        if (typeof child.unref === 'function') child.unref()
      } catch (e) {
        return err('restart-failed', String(e?.message || e))
      }

      return {
        ok: true,
        value: {
          acceptedAt: Date.now(),
          shellPid: parentPid,
          exePath,
          script,
          note: '重启助手已派发，DSH 外壳即将退出并在几秒后自动恢复',
        },
      }
    },
  }
}
