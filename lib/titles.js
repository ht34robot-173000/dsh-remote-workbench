/**
 * lib/titles.js — 会话标题解析
 *
 * 为什么要自己解析：
 *   host 的 sessionController.list() 返回的 title 常常是空串，
 *   sessionQuery.listSessions() 走索引库、对旧会话返回 0 条。
 *   但标题其实就写在会话日志里 —— `session/title` 事件。
 *
 * 实测：236 个会话里 233 个能直接从 `session/title` 读到，
 * 剩下的用首条用户消息兜底，覆盖 234/236。
 *
 * 实现要点：
 *  - 会话文件是 zstd 压缩的 jsonl，逐行解析，读到标题就停。
 *  - 结果按 (mtime, size) 缓存到内存 + 落盘，避免每次列表都解压 236 个文件。
 *  - 只读文件头部若干行：标题总在最前面，不必解压整个日志。
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const FILE_CANDIDATES = [
  'session.v4.jsonl.zstd',
  'session.v4.jsonl',
  'session.jsonl.zstd',
  'session.jsonl',
]

/**
 * 缓存版本。
 *
 * 改过标题提取逻辑就得 +1 —— 旧缓存里存的是**按旧逻辑算出来的标题**
 * （比如「取第一个 session/title」时期的截断值），只要文件 mtime/size 没变，
 * 就会被当成有效缓存一直复用，新逻辑永远不生效。这是实测踩过的：
 * 修好 extractTitle 后标题还是旧的，因为 235 条缓存全是脏数据。
 */
const CACHE_VERSION = 5

/** 内存缓存：sessionId -> { title, source, mtimeMs, size, v } */
const memo = new Map()

let loaded = false

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

function cacheFile() {
  return join(dshHome(), 'rw-titles-cache.json')
}

/**
 * 给会话 id 生成「另一种形态」的别名 key。
 *
 * 磁盘目录名有两种：
 *   新会话 → session-<uuid>
 *   老会话 → <uuid>（纯 uuid，没有前缀）
 *
 * 而调用方（session.list）拿到的 id 来自宿主，两种形态都可能出现。
 * 为了让查表时两种都能命中，scanTitles 会把每个条目用 sid 和别名各存一份。
 *
 * 判据必须看「有没有前缀」而不是无脑拼：
 *   无脑拼接对老会话正确（uuid → session-uuid），
 *   对新会话则产生 session-session-uuid 这种永远查不到的废 key。
 * 踩过的坑：带前缀的新会话全部显示「未命名会话」，老会话却正常。
 */
function aliasKey(sid) {
  const s = String(sid)
  return s.startsWith('session-') ? s.slice('session-'.length) : `session-${s}`
}

/** 冷启动时把上次的解析结果读回内存。 */
function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8'))
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        // 只恢复「有标题 + 版本对」的条目。
        // 磁盘上的 null 条目一律丢弃：它代表「曾经读取失败」，
        // 恢复进来就又会挡住重新解析（见下面 payload 判断处的注释）。
        if (v && typeof v.title === 'string' && v.title !== '' && v.v === CACHE_VERSION) {
          memo.set(k, v)
        }
      }
    }
  } catch {}
}

let saveTimer = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const out = {}
      for (const [k, v] of memo) out[k] = v
      mkdirSync(dshHome(), { recursive: true })
      writeFileSync(cacheFile(), JSON.stringify(out), 'utf8')
    } catch {}
  }, 2000)
}

/** 读一个会话目录里的日志文本（解压）。 */
function readSessionText(dir) {
  for (const name of FILE_CANDIDATES) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      const buf = readFileSync(p)
      if (name.endsWith('.zstd')) {
        return zstdDecodeAllFrames(buf).toString('utf8')
      }
      return buf.toString('utf8')
    } catch {
      return null
    }
  }
  return null
}

/**
 * zstd 魔数（小端 0xFD2FB528）。
 *
 * 会话日志是**多帧拼接**的：每来一批新事件就追加一个独立帧，
 * 一个 4MB 的会话能有 3494 个帧。这点非常关键，见下面。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压「多帧拼接」的 zstd。
 *
 * —— 这个函数是整个标题功能的关键，踩过的大坑 ——
 *
 * `zlib.zstdDecompressSync(buf)` **只解第一个帧就返回**。
 * 而会话日志是多帧的，于是：
 *
 *   4 MB 的日志  →  只解出 188 字节（就是文件头那行 {"type":"session",...}）
 *   6033 行的会话 →  只看到 1 行
 *   247 个会话    →  只有 1 个能解析出标题
 *
 * 表现就是「几乎全部会话显示未命名会话」，而且**看起来像缓存问题**
 * （缓存文件里确实只剩 1 条），排查时极易被带偏。
 *
 * 更迷惑的是：它在本机 Node 24.22 下能解出完整内容（那时我据此认为代码没问题），
 * 但 DSH Host 跑的是 Electron 44 内置的 Node 24.18 —— 那个版本严格只解首帧。
 * 所以「同一份代码、同一个文件，我用 node 跑正常，宿主跑就坏」。
 *
 * 宿主自己（dsh-session-persistence-jsonl）用的是私有流句柄逐帧解，
 * 这里不去碰私有 API，改用公开方案的等价实现：
 * 按魔数切分 → 每帧单独 zstdDecompressSync → 拼接。
 *
 * 注意要跳过「压缩数据内部偶然出现的魔数序列」造成的误切：
 * 切错时该帧解压会失败，那一帧跳过即可，不会污染整体
 * （实测 3494 帧切分全部成功，fail=0）。
 */
function zstdDecodeAllFrames(buf) {
  // 先试单次解压：如果整个文件只有一帧，这条路最快也最稳
  let firstLen = -1
  try {
    const one = zlib.zstdDecompressSync(buf)
    firstLen = one.length
  } catch {
    return zlib.zstdDecompressSync(buf) // 让它照常抛错，由调用方兜底
  }

  // 收集所有帧起点
  const starts = []
  let idx = 0
  while ((idx = buf.indexOf(ZSTD_MAGIC, idx)) !== -1) {
    starts.push(idx)
    idx += 4
  }

  // 只有一帧，或者根本找不到魔数：单次解压的结果就是全量
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf)

  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      // 误切的帧（压缩数据内部恰好出现魔数）—— 跳过，不影响其余
    }
  }

  if (parts.length === 0) return zlib.zstdDecompressSync(buf)
  const all = Buffer.concat(parts)
  // 逐帧加起来还不如单帧长，说明切分策略不适用于这个文件，退回单帧结果
  return all.length > firstLen ? all : zlib.zstdDecompressSync(buf)
}

/**
 * 从日志文本里取标题。
 *
 * —— 为什么取**最后**一个 session/title（实测）——
 *
 * 一个会话里 title 事件会出现多次，含义完全不同：
 *   seq 14  {"title":"帮我去github上找插件，我要一","source":{"kind":"fallback"}}
 *   seq 16  {"title":"GitHub 对话撤回插件查找","source":{"kind":"provider",...}}
 *
 * 第一条是「首条用户消息截断」的占位标题（fallback），第二条才是 LLM
 * 根据整轮对话生成的正式标题。以前读到第一条就 return，于是所有会话都
 * 显示成半句话被截断的样子（「我电脑的内存怎么老是很高，」这种）。
 *
 * 所以这里扫完整份日志，取最后一个非空 title —— 那才是最终生效的标题。
 * 日志本来就要整份解压（zstd 不支持只解头部），多扫一遍不增加 IO。
 */
function extractTitle(text) {
  if (!text) return null
  const lines = text.split('\n')
  let lastTitle = null
  let fallback = null
  let origin = null
  let parentSession = null

  for (const line of lines) {
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }

    /**
     * 会话头部（第一行，type: "session"）里有 origin 和 parentSession。
     *
     * 这是区分「用户的会话」和「子智能体的会话」的唯一依据：
     *   {"type":"session","id":"09628e47-...","origin":"subagent",
     *    "parentSession":"session-2655e55c-...","delegationDepth":1}
     *
     * 实测 242 个会话里 104 个是 subagent。它们不该出现在用户的会话列表里
     * ——那是 agent 自己派生的执行单元，不是用户开的对话。
     */
    if (ev.type === 'session') {
      if (typeof ev.origin === 'string') origin = ev.origin
      if (typeof ev.parentSession === 'string') parentSession = ev.parentSession
    }

    // 官方标题事件：一直覆盖，循环结束后留的就是最后一个（最终生效的那个）
    if (ev.type === 'session/title' && ev.data?.title) {
      const t = String(ev.data.title).trim()
      if (t) {
        lastTitle = {
          title: t,
          source: ev.data.source?.kind === 'provider' ? 'session/title-llm' : 'session/title',
        }
      }
    }

    // 兜底：首条用户消息（只在完全没有 title 事件时用）
    if (!fallback) {
      const type = ev.type ?? ev.data?.type
      if (type === 'user/message') {
        const msg = ev.data?.message ?? ev.data
        let txt = ''
        if (typeof msg?.text === 'string') {
          txt = msg.text
        } else if (Array.isArray(msg?.content)) {
          txt = msg.content
            .filter((b) => b && b.type === 'text')
            .map((b) => b.text)
            .join(' ')
        }
        txt = txt.trim().replace(/\s+/g, ' ')
        if (txt) fallback = { title: txt.slice(0, 40), source: 'first-user-message' }
      }
    }
  }
  // 标题和会话身份一起返回：调用方要靠 origin 区分用户会话和子智能体会话，
  // 而这两样信息在同一次解压里就能拿到，没必要扫两遍
  return {
    title: lastTitle?.title ?? fallback?.title ?? null,
    source: lastTitle?.source ?? fallback?.source ?? 'none',
    origin,
    parentSession,
  }
}

/**
 * 扫描全部会话，建立 sessionId -> { title, cwd } 映射。
 *
 * 除了标题，还带回「会话属于哪个工作区目录」。
 *
 * 为什么要读目录名而不只用 workspace.json：
 *   workspace.json 只登记了 4 个工作区、11 个会话，而实际有 240 个会话，
 *   绝大多数不在登记表里。会话在磁盘上是按工作区目录分好的：
 *     sessions/--F-~8F6F~4EF6--/session-xxx/
 *   目录名就是 cwd 的 URL 编码（~XXXX 是十六进制码点），解析它才是完整的分组依据。
 */
export function scanTitles() {
  ensureLoaded()
  const root = join(dshHome(), 'sessions')
  const out = new Map()
  let scanned = 0

  let workspaces = []
  try {
    workspaces = readdirSync(root)
  } catch {
    return out
  }

  for (const ws of workspaces) {
    const wsDir = join(root, ws)
    let isDir = false
    try { isDir = statSync(wsDir).isDirectory() } catch { continue }
    if (!isDir) continue

    const workspace = decodeWorkspaceDir(ws)

    let sids = []
    try { sids = readdirSync(wsDir) } catch { continue }

    for (const sid of sids) {
      const dir = join(wsDir, sid)
      let st
      try { st = statSync(dir) } catch { continue }
      if (!st.isDirectory()) continue

      let logStat = null
      for (const name of FILE_CANDIDATES) {
        const p = join(dir, name)
        if (!existsSync(p)) continue
        try { logStat = statSync(p) } catch { continue }
        break
      }

      const hit = memo.get(sid)
      // 只信任「确实解出过标题」的缓存条目。
      // title 为 null 的缓存不能复用 —— 那可能只是某次读取失败（文件被占用、
      // 并发解压出错、进程刚启动时目录还没就绪），一旦认了它，这个会话就永久
      // 显示「未命名会话」，直到日志文件自己变化。这条是踩过的坑：
      // 宿主重启后 240 个会话全变「未命名会话」，就是因为首批扫描把 null 写进了内存。
      const payload = hit && logStat && hit.v === CACHE_VERSION && hit.title
        && hit.mtimeMs === logStat.mtimeMs && hit.size === logStat.size
        ? { title: hit.title, workspace, origin: hit.origin ?? null, parentSession: hit.parentSession ?? null }
        : null

      if (payload) {
        out.set(sid, payload)
        // 同时用另一种 id 形态建一份，避免调用方因 id 形态不同而查不到。
        //
        // ⚠ 一定要先判断有没有前缀再补，不能无脑 `session-${sid}`：
        //   新会话的磁盘目录名**本身就带** session- 前缀
        //     sessions/--F-...--/session-74e8b349-.../
        //   老会话是纯 uuid
        //     sessions/--F-...--/5433d5b5-.../
        //   无脑拼接会生成 session-session-74e8b349-... 这种废 key，
        //   而调用方查的是 session-74e8b349-...，于是永远查不到 →
        //   整批带前缀的新会话全部退化成「未命名会话」。
        //   这个 bug 的迷惑之处在于：纯 uuid 的老会话反而一切正常。
        out.set(aliasKey(sid), payload)
        continue
      }

      const text = readSessionText(dir)
      const info = extractTitle(text)
      scanned++

      if (info && info.title) {
        memo.set(sid, {
          title: info.title,
          source: info.source,
          origin: info.origin ?? null,
          parentSession: info.parentSession ?? null,
          mtimeMs: logStat?.mtimeMs ?? 0,
          size: logStat?.size ?? 0,
          v: CACHE_VERSION,
        })
        const value = {
          title: info.title,
          workspace,
          origin: info.origin ?? null,
          parentSession: info.parentSession ?? null,
        }
        out.set(sid, value)
        out.set(aliasKey(sid), value)
      } else {
        // 解不出标题：**不写进 memo**，下次有机会重新尝试。
        // 代价是这个文件可能被重复解压，但比起「永久错标题」，这个代价可以接受。
        // 但 origin 还是要透传：即使没标题，子智能体会话也必须能被识别出来，
        // 否则它会以「未命名会话」的身份混进用户的列表。
        const value = {
          title: null,
          workspace,
          origin: info?.origin ?? null,
          parentSession: info?.parentSession ?? null,
        }
        out.set(sid, value)
        out.set(aliasKey(sid), value)
      }
    }
  }

  if (scanned > 0) scheduleSave()
  return out
}

/**
 * 解码会话目录名成可读路径。
 *
 * 目录名形如：
 *   `--F-~8F6F~4EF6--`                → F:\插件
 *   `--C-Users-<用户名>-.dsh-...--`      → C:\Users\<用户名>\.dsh\...
 *
 * 编码规则（按实测反推）：
 *   外层 `--` 包裹
 *   `~XXXX` 是 UTF-16 码点的十六进制
 *   路径分隔符 `/` 或 `\` 变成 `-`
 *   **盘符后的冒号也变成 `-`**，所以 `C:` 会变成 `C-`
 *
 * 最后一点是关键：直接用 `-` 当分隔符会得到 `C\Users\...`（丢冒号），
 * 那样和工作区注册表里的 `C:\Users\...` 对不上，导致所有会话都匹配不到。
 * 所以首段若是单个字母，要补回冒号。
 */
export function decodeWorkspaceDir(name) {
  let s = String(name)
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)

  // 先还原 ~XXXX 转义
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)))

  const parts = s.split('-').filter((x) => x !== '')
  if (parts.length === 0) return { path: s, label: s }

  // 首段是单字母 → Windows 盘符，补回被编码掉的冒号
  let path
  if (parts[0].length === 1 && /^[A-Za-z]$/.test(parts[0])) {
    path = parts[0] + ':\\' + parts.slice(1).join('\\')
  } else {
    path = parts.join('\\')
  }

  const label = parts[parts.length - 1] || path
  return { path, label }
}

/** 单个会话的标题（避免全量扫描时用）。 */
export function titleOf(sessionId) {
  ensureLoaded()
  const hit = memo.get(sessionId)
  return hit?.title ?? null
}

/**
 * 作废单个会话的标题缓存。
 *
 * 改名之后必须调一次：缓存键是 (mtime, size)，改名会追加一条 session/title
 * 事件，文件 size 通常会变，但如果在同一毫秒内批量操作、或文件被原地重写，
 * 就可能出现 size 相同的情况，那时缓存会一直返回旧名字。
 * 主动清掉最稳。
 */
export function invalidateTitle(sessionId) {
  if (!sessionId) return
  const bare = String(sessionId).startsWith('session-')
    ? String(sessionId).slice('session-'.length)
    : String(sessionId)
  memo.delete(bare)
  memo.delete(`session-${bare}`)
  scheduleSave()
}
