/**
 * lib/fs-ops.js — 宿主机文件系统全读写
 *
 * 设计要点：
 *  - 只接受绝对路径。相对路径一律拒绝，避免沿进程 cwd 逃逸到意料之外的位置。
 *  - 不把访问限制在某个根目录：这是「控制宿主机本地资源管理器」的需求，
 *    用户要的就是能管整台机器。真正的门禁是设备配对 cookie（见 lib/auth.js）。
 *  - 删除目录默认只允许空目录；要递归删必须显式带 recursive:true，
 *    这样误触一个按钮不会连整棵树一起没了。
 *  - 跨盘 move 会拿 EXDEV，退化成 copy+unlink。
 */
import {
  copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const TEXT_MAX = 2 * 1024 * 1024
const READ_MAX = 64 * 1024 * 1024

function fail(code, path, message) {
  return { ok: false, error: { code, message, details: { path } } }
}
function ok(value) {
  return { ok: true, value }
}

/** Windows 盘符 / UNC，POSIX 前导斜杠。 */
export function isAbsolutePath(path) {
  if (typeof path !== 'string' || path === '') return false
  return process.platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : isAbsolute(path)
}

function requireAbs(path) {
  return isAbsolutePath(path) ? null : `"${path}" 不是绝对路径`
}

function kindOf(dirent, st) {
  if (dirent?.isDirectory() ?? st.isDirectory()) return 'dir'
  if (dirent?.isSymbolicLink() ?? st.isSymbolicLink()) return 'link'
  return 'file'
}

/** 列目录：目录在前，文件在后，各自按名字排。 */
export async function listDir(payload, opts = {}) {
  /*
   * 空路径 = 「我的电脑」这一层。
   *
   * 以前空路径直接落到 homedir()，于是 App 一进文件页看到的就是
   * C:\Users\21415，用户会以为「只有 C 盘」。实际上 listDrives() 早就
   * 返回了 A:\ 到 Z:\，只是从来没人用它做过一层虚拟目录。
   *
   * 现在空路径返回盘符列表（kind 全为 dir，path 为 "F:\" 这种形式），
   * 点一个盘符就能进去，行为对齐 Windows 资源管理器。
   */
  if (typeof payload?.path !== 'string' || payload.path === '') {
    const drives = listDrives()
    const entries = []
    for (const d of drives) {
      let exists = false
      try { await stat(d) ; exists = true } catch { exists = false }
      // 只列出真实存在的盘符，避免 A:\ / B:\ 这种幽灵项
      if (!exists) continue
      entries.push({
        name: d.replace(/\\$/, ''),
        path: d,
        kind: 'dir',
        size: 0,
        mtime: 0,
        ext: '',
        hidden: false,
      })
    }
    return ok({
      path: '',
      home: homedir(),
      parent: null,
      sep,
      platform: process.platform,
      entries,
      truncated: false,
      freeBytes: null,
      drives,
    })
  }

  const requested = payload.path
  const bad = requireAbs(requested)
  if (bad) return fail('path-not-absolute', requested, bad)

  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 5000
  const target = resolve(requested)
  const showHidden = payload?.showHidden === true

  try {
    const dirents = await readdir(target, { withFileTypes: true })
    const entries = []
    let truncated = false

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) { truncated = true; break }
      if (!showHidden && dirent.name.startsWith('.')) continue
      const child = join(target, dirent.name)
      let st
      try { st = await stat(child) } catch { continue }
      entries.push({
        name: dirent.name,
        path: child,
        kind: kindOf(dirent, st),
        size: st.isFile() ? st.size : 0,
        mtime: Math.trunc(st.mtimeMs),
        ext: st.isFile() ? extname(dirent.name).toLowerCase() : '',
        hidden: dirent.name.startsWith('.'),
      })
    }

    entries.sort((a, b) => {
      if (a.kind === 'dir' && b.kind !== 'dir') return -1
      if (a.kind !== 'dir' && b.kind === 'dir') return 1
      return a.name.localeCompare(b.name)
    })

    let freeBytes = null
    try {
      const s = await statfs(target)
      freeBytes = Number(s.bavail) * Number(s.bsize)
    } catch {}

    const parent = dirname(target)
    return ok({
      path: target,
      home: homedir(),
      parent: parent === target ? null : parent,
      sep,
      platform: process.platform,
      entries,
      truncated,
      freeBytes,
      showHidden,
      // 前端面包屑直接用它，省得自己拼 Windows 反斜杠
      crumbs: buildCrumbs(target),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('directory-unreadable', target, `无法列出 ${target}：${message}`)
  }
}

function buildCrumbs(target) {
  const parts = []
  let cur = target
  for (;;) {
    const up = dirname(cur)
    parts.unshift({ name: up === cur ? cur : basename(cur), path: cur })
    if (up === cur) break
    cur = up
  }
  return parts
}

/** 读文本文件（编辑器用）。二进制会被挡住并提示走下载。 */
export async function readText(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  try {
    const st = await stat(path)
    if (!st.isFile()) return fail('not-a-file', path, '目标不是文件')
    if (st.size > TEXT_MAX) {
      return fail('file-too-large', path, `文件 ${st.size} 字节，超过编辑器上限 ${TEXT_MAX}`)
    }
    const buf = await readFile(path)
    for (let i = 0; i < Math.min(buf.length, 8192); i += 1) {
      if (buf[i] === 0) return fail('binary-file', path, '这是二进制文件，请用下载')
    }
    return ok({ path, text: buf.toString('utf8'), size: st.size, mtime: Math.trunc(st.mtimeMs) })
  } catch (error) {
    return fail('file-unreadable', path, error instanceof Error ? error.message : String(error))
  }
}

/** 读原始字节（图片/PDF 预览用）。 */
export async function readRaw(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  try {
    const st = await stat(path)
    if (!st.isFile()) return fail('not-a-file', path, '目标不是文件')
    if (st.size > READ_MAX) return fail('file-too-large', path, `文件 ${st.size} 字节，请用下载`)
    return ok({ path, buffer: await readFile(path), size: st.size, mtime: Math.trunc(st.mtimeMs) })
  } catch (error) {
    return fail('file-unreadable', path, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 确保目标目录存在 —— **但要跳过盘符根**（2026-11-19 修）。
 *
 * ⚠️ 原来这里无条件 `mkdir(dirname(to), {recursive:true})`。
 * 当目标是盘符根下的文件（如 `F:\x.txt`）时 `dirname` 就是 `F:\`，
 * 而 Windows 上对盘符根执行 mkdir 直接抛：
 *
 *     EPERM: operation not permitted, mkdir 'F:\'
 *
 * 表现是「重命名对话框关了，但文件没改名」—— 而且这个错误**在两个客户端
 * 都会出现**（Kotlin 版只是没人试过在盘符根下重命名）。
 *
 * 判断方式：`dirname(to) === to` 的父级（`F:\` 的 dirname 还是 `F:\`），
 * 或者「父目录等于 to 自己去掉最后一段之后什么都不剩」。这里直接用
 * `parse(dir).root === dir` 最可靠 —— Node 的 path.parse 会给出盘符根。
 */
function ensureParentDir(to) {
  const dir = dirname(to)
  // 已经是某个盘的根，不需要（也不能）创建
  if (parse(dir).root === dir) return Promise.resolve()
  return mkdir(dir, { recursive: true })
}

/** 写文本（新建或覆盖）。 */
export async function writeText(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  if (typeof payload?.text !== 'string') return fail('bad-payload', path, 'text 必须是字符串')
  try {
    await ensureParentDir(path)
    await writeFile(path, payload.text, 'utf8')
    const st = await stat(path)
    return ok({ path, size: st.size, mtime: Math.trunc(st.mtimeMs) })
  } catch (error) {
    return fail('file-unwritable', path, error instanceof Error ? error.message : String(error))
  }
}

/** 新建目录。 */
export async function makeDir(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  try {
    await mkdir(path, { recursive: true })
    return ok({ path })
  } catch (error) {
    return fail('mkdir-failed', path, error instanceof Error ? error.message : String(error))
  }
}

/** 新建空文件。 */
export async function makeFile(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  try {
    await ensureParentDir(path)
    await writeFile(path, '', { flag: 'a' })
    return ok({ path })
  } catch (error) {
    return fail('touch-failed', path, error instanceof Error ? error.message : String(error))
  }
}

/** 删除。目录默认必须为空，除非显式 recursive。 */
export async function remove(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  const recursive = payload?.recursive === true
  try {
    const st = await stat(path)
    if (st.isDirectory() && !recursive) {
      const left = await readdir(path)
      if (left.length > 0) {
        return fail('directory-not-empty', path, `目录里还有 ${left.length} 项；要连目录一起删请带 recursive`)
      }
    }
    await rm(path, { recursive, force: false })
    return ok({ path })
  } catch (error) {
    return fail('remove-failed', path, error instanceof Error ? error.message : String(error))
  }
}


/** 重命名 / 移动。 */
export async function move(payload) {
  const from = payload?.from
  const to = payload?.to
  const badFrom = requireAbs(from)
  if (badFrom) return fail('path-not-absolute', from, badFrom)
  const badTo = requireAbs(to)
  if (badTo) return fail('path-not-absolute', to, badTo)
  try {
    await ensureParentDir(to)
    await rename(from, to)
    return ok({ from, to })
  } catch (error) {
    // 跨盘 rename 报 EXDEV：复制再删
    if (error?.code === 'EXDEV') {
      try {
        await pipeline(createReadStream(from), createWriteStream(to))
        await unlink(from)
        return ok({ from, to, via: 'copy+delete' })
      } catch (inner) {
        return fail('move-failed', from, inner instanceof Error ? inner.message : String(inner))
      }
    }
    return fail('move-failed', from, error instanceof Error ? error.message : String(error))
  }
}

/** 复制（目录递归）。 */
export async function copy(payload) {
  const from = payload?.from
  const to = payload?.to
  const badFrom = requireAbs(from)
  if (badFrom) return fail('path-not-absolute', from, badFrom)
  const badTo = requireAbs(to)
  if (badTo) return fail('path-not-absolute', to, badTo)
  try {
    const st = await stat(from)
    if (st.isDirectory()) {
      await mkdir(to, { recursive: true })
      const kids = await readdir(from, { withFileTypes: true })
      for (const kid of kids) {
        const sub = await copy({ from: join(from, kid.name), to: join(to, kid.name) })
        if (!sub.ok) return sub
      }
      return ok({ from, to })
    }
    await ensureParentDir(to)
    await copyFile(from, to)
    return ok({ from, to })
  } catch (error) {
    return fail('copy-failed', from, error instanceof Error ? error.message : String(error))
  }
}

/** 把上传的文件落到指定目录。name 只取 basename，防 `../` 逃逸。 */
export async function saveUpload(payload) {
  const dir = payload?.dir
  const name = payload?.name
  const bad = requireAbs(dir)
  if (bad) return fail('path-not-absolute', dir, bad)
  if (typeof name !== 'string' || name === '' || name.includes('\0')) {
    return fail('bad-name', dir, '文件名无效')
  }
  if (typeof payload?.base64 !== 'string') return fail('bad-payload', dir, '缺少 base64')
  const target = join(dir, basename(name))
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(target, Buffer.from(payload.base64, 'base64'))
    const st = await stat(target)
    return ok({ path: target, size: st.size, name: basename(name) })
  } catch (error) {
    return fail('upload-failed', dir, error instanceof Error ? error.message : String(error))
  }
}

/** 流式下载。调用方负责写响应头。 */
export async function openDownload(payload) {
  const path = payload?.path
  const bad = requireAbs(path)
  if (bad) return fail('path-not-absolute', path, bad)
  try {
    const st = await stat(path)
    if (!st.isFile()) return fail('not-a-file', path, '目标不是文件')
    return ok({ stream: createReadStream(path), size: st.size, name: basename(path), mtime: st.mtimeMs })
  } catch (error) {
    return fail('file-unreadable', path, error instanceof Error ? error.message : String(error))
  }
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
}

export function mimeOf(name) {
  return MIME[extname(String(name)).toLowerCase()] ?? 'application/octet-stream'
}

/** Windows 常见盘符，给前端做快捷入口。 */
export function listDrives() {
  if (process.platform !== 'win32') return ['/']
  const drives = []
  for (let c = 65; c <= 90; c += 1) {
    const letter = String.fromCharCode(c)
    drives.push(`${letter}:\\`)
  }
  return drives
}

