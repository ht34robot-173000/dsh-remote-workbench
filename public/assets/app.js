/**
 * public/assets/app.js — 远程工作台前端
 *
 * 纯原生 ES 模块，无框架、无构建步骤：改完刷新就生效。
 *
 * 功能对应：
 *   - 会话列表 / 打开会话 / 发送消息 / 中断
 *   - 批量与单独上传（图片走 base64 直传，文件走上传端点）
 *   - 运行中插话（session.steer）
 *   - 文件管理器全读写（列/读/写/建/删/移/复制/下载/上传）
 *   - 亮暗主题切换（含跟随系统）
 *   - 已归档会话折叠隐藏
 */

const API = '/rw/api'
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/* ————————————————— 基础工具 ————————————————— */

const state = {
  paired: false,
  device: null,
  platform: '',
  drives: [],
  sessions: [],
  archived: [],
  archivedOpen: false,
  current: null,          // 当前会话 id
  currentTitle: '',
  messages: [],
  historyCursor: null,    // 还有更早的历史时 = 上一页的 beforeSeq
  loadingEarlier: false,
  attachments: [],        // { id, name, mediaType, data(base64), size, kind }
  fs: { path: '', crumbs: [], entries: [], sel: new Set() },
  view: 'chat',
  steerOpen: false,
  busy: false,
}

function toast(text, kind = '') {
  const wrap = $('#toasts')
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = text
  wrap.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .2s'
    setTimeout(() => el.remove(), 220)
  }, 2600)
}

async function api(path, body, opts = {}) {
  const res = await fetch(`${API}/${path}`, {
    method: body === undefined && !opts.method ? 'GET' : (opts.method || 'POST'),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  let json = null
  try { json = await res.json() } catch {}
  if (res.status === 401) {
    state.paired = false
    openPairSheet()
    throw new Error('设备未配对')
  }
  if (!json) throw new Error(`HTTP ${res.status}`)
  return json
}

const fmtSize = (n) => {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

const fmtTime = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/* ————————————————— 主题 ————————————————— */

const THEME_KEY = 'rw.theme'

function applyTheme(mode) {
  const root = document.documentElement
  if (mode === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'dark' : 'light'
  } else {
    root.dataset.theme = mode
  }
  localStorage.setItem(THEME_KEY, mode)
  const meta = $('meta[name="theme-color"]')
  if (meta) meta.content = root.dataset.theme === 'dark' ? '#202020' : '#f3f3f3'
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'system'
  applyTheme(saved)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system')
  })
}

function cycleTheme() {
  const order = ['system', 'light', 'dark']
  const cur = localStorage.getItem(THEME_KEY) || 'system'
  const next = order[(order.indexOf(cur) + 1) % order.length]
  applyTheme(next)
  const label = { system: '跟随系统', light: '浅色', dark: '深色' }[next]
  toast(`主题：${label}`)
}

/* ————————————————— 配对 ————————————————— */

function openPairSheet() {
  $('#pairSheet').classList.add('open')
  refreshPairStatus()
}

function closePairSheet() {
  $('#pairSheet').classList.remove('open')
}

async function refreshPairStatus() {
  const box = $('#pairStatus')
  if (state.paired) {
    box.innerHTML = `本设备已配对 <span class="chip">${state.device || ''}</span>`
    $('#pairHostArea').style.display = 'none'
  } else {
    box.textContent = '本设备尚未配对。'
    $('#pairHostArea').style.display = ''
  }
}

async function generatePairCode() {
  try {
    const res = await fetch('/rw/pair/new', { method: 'POST', credentials: 'same-origin' })
    const json = await res.json()
    if (!json.ok) {
      toast('只能在宿主机本机生成配对码', 'err')
      return
    }
    $('#pairCodeBox').style.display = ''
    $('#pairCodeText').textContent = json.code
    $('#pairExpire').textContent = `10 分钟内有效 · ${new Date(json.expiresAt).toLocaleTimeString('zh-CN')} 过期`
  } catch (e) {
    toast('生成失败：' + e.message, 'err')
  }
}

async function submitPair() {
  const code = $('#pairInput').value.trim()
  if (!/^\d{6}$/.test(code)) { toast('请输入 6 位数字', 'err'); return }
  try {
    const res = await fetch('/rw/pair/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
      credentials: 'same-origin',
    })
    const json = await res.json()
    if (!json.ok) { toast('配对码不对或已过期', 'err'); return }
    toast('配对成功', 'ok')
    closePairSheet()
    await boot()
  } catch (e) {
    toast('配对失败：' + e.message, 'err')
  }
}

/* ————————————————— 会话 ————————————————— */

async function loadSessions() {
  const out = await api('session.list', {})
  const items = extractSessions(out)
  // 归档判定：宿主返回的 archived 字段，或没有 archived 字段时全算活跃
  state.sessions = items.filter((s) => !s.archived)
  state.archived = items.filter((s) => s.archived)
  renderSessionList()
}

function extractSessions(out) {
  const v = out?.value ?? out
  const list = Array.isArray(v) ? v
    : Array.isArray(v?.items) ? v.items
    : Array.isArray(v?.sessions) ? v.sessions
    : Array.isArray(v?.value?.items) ? v.value.items
    : []
  return list.map((s) => ({
    id: s.id ?? s.sessionId ?? s.session_id ?? '',
    title: s.title ?? s.name ?? s.summary ?? '未命名会话',
    updatedAt: s.updatedAt ?? s.updated_at ?? s.modifiedAt ?? s.createdAt ?? 0,
    archived: Boolean(s.archived ?? s.isArchived ?? false),
    kind: s.kind ?? s.category ?? '',
  })).filter((s) => s.id)
}

function renderSessionList() {
  const box = $('#sessionList')
  box.innerHTML = ''
  if (state.sessions.length === 0) {
    box.innerHTML = '<div class="empty tiny" style="padding:20px 8px">还没有会话</div>'
  }
  for (const s of state.sessions) box.appendChild(sessionNode(s))

  const wrap = $('#archiveWrap')
  const arch = $('#archivedList')
  arch.innerHTML = ''
  if (state.archived.length === 0) {
    wrap.style.display = 'none'
  } else {
    wrap.style.display = ''
    $('#archiveCount').textContent = String(state.archived.length)
    for (const s of state.archived) arch.appendChild(sessionNode(s))
    arch.style.display = state.archivedOpen ? '' : 'none'
    $('#archiveLabel').dataset.collapsed = state.archivedOpen ? 'false' : 'true'
  }
}

function sessionNode(s) {
  const b = document.createElement('button')
  b.className = 'sess'
  b.dataset.id = s.id
  if (state.current === s.id) b.setAttribute('aria-current', 'true')
  const t = document.createElement('div')
  t.className = 't'
  t.textContent = s.title
  const m = document.createElement('div')
  m.className = 'm'
  const kindSpan = document.createElement('span')
  kindSpan.textContent = s.kind || '会话'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const timeSpan = document.createElement('span')
  timeSpan.textContent = fmtTime(s.updatedAt)
  m.append(kindSpan, dot, timeSpan)
  b.append(t, m)
  b.addEventListener('click', () => openSession(s))
  return b
}

async function openSession(s) {
  state.current = s.id
  state.currentTitle = s.title
  state.messages = []
  state.historyCursor = null
  state.loadingEarlier = false
  $('#chatTitle').textContent = s.title
  $('#steerToggle').style.display = ''
  $('#cancelBtn').style.display = ''
  renderSessionList()
  closeSidebar()
  renderTimeline()
  try {
    const out = await api('session.history', { sessionId: s.id })
    state.messages = extractMessages(out)
    // 服务端默认只回最近一页，记下游标供「加载更早」用
    const v = out?.value ?? out
    state.historyCursor = v?.hasMore ? v?.beforeSeq ?? null : null
    renderTimeline()
    scrollTimelineToEnd()
  } catch (e) {
    toast('读取历史失败：' + e.message, 'err')
  }
}

/**
 * 往前翻一页历史。
 *
 * 一个几千条事件的会话原样是十几 MB，公网上要等二三十秒。服务端现在
 * 默认只回最近 40 条消息，更早的按需拉，避免每次打开会话都全量下载。
 */
async function loadEarlier() {
  if (!state.current || state.loadingEarlier) return
  const cursor = state.historyCursor
  if (cursor == null) return
  state.loadingEarlier = true
  renderTimeline()
  try {
    const out = await api('session.history', {
      sessionId: state.current,
      beforeSeq: cursor,
    })
    const older = extractMessages(out)
    const v = out?.value ?? out
    state.historyCursor = v?.hasMore ? v?.beforeSeq ?? null : null
    state.messages = [...older, ...state.messages]
    renderTimeline()
  } catch (e) {
    toast('加载更早失败：' + e.message, 'err')
  } finally {
    state.loadingEarlier = false
    renderTimeline()
  }
}

function extractMessages(out) {
  const v = out?.value ?? out
  const list = Array.isArray(v) ? v
    : Array.isArray(v?.messages) ? v.messages
    : Array.isArray(v?.events) ? v.events
    : Array.isArray(v?.items) ? v.items
    : []
  const msgs = []
  for (const item of list) {
    const data = item?.data ?? item
    const type = item?.type ?? data?.type
    if (type === 'user/message' || data?.role === 'user') {
      msgs.push({ role: 'user', content: pickContent(data?.message ?? data) })
    } else if (type === 'assistant/message' || data?.role === 'assistant') {
      msgs.push({ role: 'assistant', content: pickContent(data?.message ?? data) })
    } else if (type === 'tool/result') {
      const name = data?.message?.source?.toolName ?? data?.name ?? 'tool'
      msgs.push({ role: 'tool', content: `${name}：${pickContent(data?.message ?? data).slice(0, 1200)}` })
    }
  }
  return msgs
}

function pickContent(msg) {
  if (typeof msg === 'string') return msg
  if (!msg) return ''
  if (typeof msg.text === 'string') return msg.text
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((b) => {
        if (b?.type === 'text') return b.text ?? ''
        if (b?.type === 'image') return '[图片]'
        if (b?.type === 'file') return `[文件 ${b.name ?? ''}]`
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function renderTimeline() {
  const box = $('#timeline')
  box.innerHTML = ''
  if (state.messages.length === 0) {
    box.innerHTML = `<div class="empty">
      <div class="big">${state.current ? '这个会话还没有消息' : '还没有打开会话'}</div>
      <div>${state.current ? '在下方输入开始对话' : '从左侧选择一个会话'}</div>
    </div>`
    return
  }
  // 还有更早的页：顶部给一个入口
  if (state.current && (state.historyCursor != null || state.loadingEarlier)) {
    const more = document.createElement('button')
    more.className = 'earlier'
    more.textContent = state.loadingEarlier ? '载入更早…' : '加载更早的消息'
    more.disabled = state.loadingEarlier
    more.addEventListener('click', loadEarlier)
    box.appendChild(more)
  }
  for (const m of state.messages) {
    const el = document.createElement('div')
    el.className = `msg ${m.role}`
    if (m.role !== 'tool') {
      const role = document.createElement('span')
      role.className = 'role'
      role.textContent = m.role === 'user' ? '你' : 'DSH'
      el.appendChild(role)
    }
    const body = document.createElement('div')
    body.textContent = m.content
    el.appendChild(body)
    box.appendChild(el)
  }
}

function scrollTimelineToEnd() {
  const box = $('#timeline')
  box.scrollTop = box.scrollHeight
}

async function sendMessage() {
  if (state.busy) return
  const input = $('#composerInput')
  const text = input.value.trim()
  if (!text && state.attachments.length === 0) return
  if (!state.current) { toast('先选一个会话', 'err'); return }

  state.busy = true
  try {
    const images = state.attachments.filter((a) => a.kind === 'image')
    const files = state.attachments.filter((a) => a.kind === 'file')
    const payload = {
      sessionId: state.current,
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((a) => ({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name })),
        ...files.map((a) => ({ type: 'file', name: a.name, data: a.data, mediaType: a.mediaType })),
      ],
      text,
    }
    const out = await api('session.prompt', payload)
    if (out?.ok === false) {
      toast(out.error?.message || '发送失败', 'err')
      return
    }
    state.messages.push({ role: 'user', content: text || '[附件]' })
    state.attachments = []
    input.value = ''
    autoGrow(input)
    renderAttachments()
    renderTimeline()
    scrollTimelineToEnd()
  } catch (e) {
    toast('发送失败：' + e.message, 'err')
  } finally {
    state.busy = false
  }
}

async function sendSteer() {
  const el = $('#steerText')
  const text = el.value.trim()
  if (!text) return
  if (!state.current) { toast('先选一个会话', 'err'); return }
  try {
    const out = await api('session.steer', { sessionId: state.current, text })
    if (out?.ok === false) { toast(out.error?.message || '注入失败', 'err'); return }
    toast('已注入到运行中的任务', 'ok')
    el.value = ''
    autoGrow(el)
    closeSteer()
  } catch (e) {
    toast('注入失败：' + e.message, 'err')
  }
}

async function cancelRun() {
  if (!state.current) return
  try {
    await api('session.cancel', { sessionId: state.current })
    toast('已请求中断')
  } catch (e) {
    toast('中断失败：' + e.message, 'err')
  }
}

/* ————————————————— 附件 ————————————————— */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

async function addFiles(fileList) {
  const files = [...fileList]
  for (const f of files) {
    const isImage = IMAGE_TYPES.includes(f.type)
    try {
      const data = await readAsBase64(f)
      state.attachments.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: f.name,
        mediaType: f.type || 'application/octet-stream',
        data,
        size: f.size,
        kind: isImage ? 'image' : 'file',
      })
    } catch {
      toast(`读取 ${f.name} 失败`, 'err')
    }
  }
  renderAttachments()
}

function renderAttachments() {
  const row = $('#attachRow')
  row.innerHTML = ''
  for (const a of state.attachments) {
    const box = document.createElement('div')
    box.className = 'attach'
    if (a.kind === 'image') {
      const img = document.createElement('img')
      img.src = `data:${a.mediaType};base64,${a.data}`
      img.alt = a.name
      box.appendChild(img)
    } else {
      const nm = document.createElement('div')
      nm.className = 'fname'
      nm.textContent = a.name
      box.appendChild(nm)
    }
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '✕'
    x.title = '移除'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      state.attachments = state.attachments.filter((b) => b.id !== a.id)
      renderAttachments()
    })
    box.appendChild(x)
    row.appendChild(box)
  }
}

/* ————————————————— 文件管理器 ————————————————— */

async function fsList(path) {
  try {
    const out = await api('fs.list', { path, showHidden: false })
    if (!out.ok) { toast(out.error?.message || '打开目录失败', 'err'); return }
    const v = out.value
    state.fs.path = v.path
    state.fs.crumbs = v.crumbs || []
    state.fs.entries = v.entries || []
    state.fs.sel.clear()
    renderCrumbs()
    renderFsList()
  } catch (e) {
    toast('列目录失败：' + e.message, 'err')
  }
}

function renderCrumbs() {
  const box = $('#crumbs')
  box.innerHTML = ''
  state.fs.crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'crumb-sep'
      sep.textContent = '›'
      box.appendChild(sep)
    }
    const b = document.createElement('button')
    b.className = 'crumb'
    b.textContent = c.name || c.path
    b.title = c.path
    b.addEventListener('click', () => fsList(c.path))
    box.appendChild(b)
  })
  box.scrollLeft = box.scrollWidth
}

function iconFor(entry) {
  if (entry.kind === 'dir') return '📁'
  if (entry.kind === 'link') return '🔗'
  const ext = entry.ext
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return '🖼'
  if (['.mp4', '.webm', '.mkv', '.mov'].includes(ext)) return '🎬'
  if (['.mp3', '.wav', '.flac', '.m4a'].includes(ext)) return '🎵'
  if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return '🗜'
  if (['.js', '.ts', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h'].includes(ext)) return '⌨'
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.conf'].includes(ext)) return '⚙'
  if (['.md', '.txt', '.log'].includes(ext)) return '📄'
  if (ext === '.apk') return '📦'
  if (['.pdf'].includes(ext)) return '📕'
  return '📄'
}

function renderFsList() {
  const box = $('#fsList')
  box.innerHTML = ''
  if (state.fs.entries.length === 0) {
    box.innerHTML = '<div class="empty"><div class="big">这个目录是空的</div></div>'
    return
  }
  for (const e of state.fs.entries) {
    const row = document.createElement('div')
    row.className = 'fs-row'
    if (state.fs.sel.has(e.path)) row.classList.add('sel')

    const ico = document.createElement('div')
    ico.className = 'ico'
    ico.textContent = iconFor(e)

    const nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = e.name
    nm.title = e.path

    const sz = document.createElement('div')
    sz.className = 'sz'
    sz.textContent = e.kind === 'dir' ? '' : fmtSize(e.size)

    const acts = document.createElement('div')
    acts.className = 'acts'

    if (e.kind === 'file') {
      const dl = document.createElement('button')
      dl.className = 'btn btn-icon'
      dl.style.cssText = 'width:26px;height:26px;min-height:26px'
      dl.textContent = '⤓'
      dl.title = '下载'
      dl.addEventListener('click', (ev) => {
        ev.stopPropagation()
        window.open(`/rw/api/fs.download?path=${encodeURIComponent(e.path)}`, '_blank')
      })
      acts.appendChild(dl)
    }

    const del = document.createElement('button')
    del.className = 'btn btn-icon btn-danger'
    del.style.cssText = 'width:26px;height:26px;min-height:26px'
    del.textContent = '🗑'
    del.title = '删除'
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const recursive = e.kind === 'dir'
      if (!confirm(`删除 ${e.name}${recursive ? '（含目录内所有内容）' : ''}？`)) return
      const out = await api('fs.remove', { path: e.path, recursive })
      if (out.ok) { toast('已删除', 'ok'); fsList(state.fs.path) }
      else toast(out.error?.message || '删除失败', 'err')
    })
    acts.appendChild(del)

    row.append(ico, nm, sz, acts)

    row.addEventListener('click', () => {
      if (e.kind === 'dir') { fsList(e.path); return }
      if (state.fs.sel.has(e.path)) state.fs.sel.delete(e.path)
      else state.fs.sel.clear(), state.fs.sel.add(e.path)
      renderFsList()
    })
    row.addEventListener('dblclick', () => { if (e.kind === 'file') openFile(e) })

    box.appendChild(row)
  }
}

async function openFile(entry) {
  const sheet = $('#fileSheet')
  const title = $('#fileSheetTitle')
  const body = $('#fileSheetBody')
  const foot = $('#fileSheetFoot')
  title.textContent = entry.name
  body.innerHTML = '<div class="empty tiny">载入中…</div>'
  foot.innerHTML = ''
  sheet.classList.add('open')

  const ext = entry.ext
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)
  const isText = ['.txt', '.md', '.json', '.js', '.ts', '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.log',
    '.sh', '.ps1', '.bat'].includes(ext)

  if (isImage) {
    body.innerHTML = ''
    const img = document.createElement('img')
    img.src = `/rw/api/fs.download?path=${encodeURIComponent(entry.path)}`
    img.style.cssText = 'max-width:100%;border-radius:8px;display:block;margin:0 auto'
    body.appendChild(img)
    return
  }

  if (isText) {
    const out = await api('fs.read', { path: entry.path })
    if (!out.ok) {
      body.innerHTML = `<div class="empty tiny">${out.error?.message || '读不了这个文件'}</div>`
      return
    }
    body.innerHTML = ''
    const ta = document.createElement('textarea')
    ta.className = 'textarea mono'
    ta.style.cssText = 'width:100%;height:46vh;font-size:12.5px'
    ta.value = out.value.text
    body.appendChild(ta)

    const save = document.createElement('button')
    save.className = 'btn btn-accent'
    save.textContent = '保存'
    save.addEventListener('click', async () => {
      const res = await api('fs.write', { path: entry.path, text: ta.value })
      if (res.ok) toast('已保存', 'ok')
      else toast(res.error?.message || '保存失败', 'err')
    })
    foot.innerHTML = ''
    foot.appendChild(save)
    return
  }

  body.innerHTML = `<div class="empty">
    <div class="big">无法内联预览</div>
    <div class="tiny">这个类型可以在手机上下载后打开</div>
  </div>`
  const dl = document.createElement('button')
  dl.className = 'btn btn-accent'
  dl.textContent = '下载'
  dl.addEventListener('click', () => {
    window.open(`/rw/api/fs.download?path=${encodeURIComponent(entry.path)}`, '_blank')
  })
  foot.appendChild(dl)
}

async function fsUploadToCurrentDir(fileList) {
  const dir = state.fs.path
  if (!dir) { toast('先打开一个目录', 'err'); return }
  let ok = 0
  for (const f of [...fileList]) {
    try {
      const base64 = await readAsBase64(f)
      const out = await api('fs.upload', { dir, name: f.name, base64 })
      if (out.ok) ok += 1
      else toast(`${f.name}: ${out.error?.message || '失败'}`, 'err')
    } catch (e) {
      toast(`${f.name}: ${e.message}`, 'err')
    }
  }
  if (ok > 0) { toast(`已上传 ${ok} 个文件`, 'ok'); fsList(dir) }
}

async function fsNewFolder() {
  const name = prompt('新文件夹名称')
  if (!name) return
  const path = joinPath(state.fs.path, name)
  const out = await api('fs.mkdir', { path })
  if (out.ok) { toast('已创建', 'ok'); fsList(state.fs.path) }
  else toast(out.error?.message || '创建失败', 'err')
}

async function fsNewFile() {
  const name = prompt('新文件名称（含扩展名）')
  if (!name) return
  const path = joinPath(state.fs.path, name)
  const out = await api('fs.touch', { path })
  if (out.ok) { toast('已创建', 'ok'); fsList(state.fs.path) }
  else toast(out.error?.message || '创建失败', 'err')
}

function joinPath(dir, name) {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

/* ————————————————— UI 事件 ————————————————— */

function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

function openSidebar() {
  $('#sidebar').classList.add('open')
  $('#sidebarScrim').classList.add('open')
}
function closeSidebar() {
  $('#sidebar').classList.remove('open')
  $('#sidebarScrim').classList.remove('open')
}

function openSteer() {
  state.steerOpen = true
  $('#steerbar').classList.add('open')
  $('#steerText').focus()
}
function closeSteer() {
  state.steerOpen = false
  $('#steerbar').classList.remove('open')
}

function switchView(view) {
  state.view = view
  $$('.nav-item').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === view))
  })
  $('#viewChat').style.display = view === 'chat' ? 'flex' : 'none'
  $('#viewFiles').style.display = view === 'files' ? 'flex' : 'none'
  if (view === 'files' && !state.fs.path) fsList('')
}

function bindEvents() {
  $('#menuBtn').addEventListener('click', openSidebar)
  $('#sidebarScrim').addEventListener('click', closeSidebar)
  $('#themeBtn').addEventListener('click', cycleTheme)
  $('#pairBtn').addEventListener('click', openPairSheet)
  $('#pairClose').addEventListener('click', closePairSheet)
  $('#pairCancel').addEventListener('click', closePairSheet)
  $('#pairSubmit').addEventListener('click', submitPair)
  $('#pairGenerate').addEventListener('click', generatePairCode)
  $('#pairInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPair() })

  $$('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)))

  $('#archiveLabel').addEventListener('click', () => {
    state.archivedOpen = !state.archivedOpen
    renderSessionList()
  })

  const input = $('#composerInput')
  input.addEventListener('input', () => autoGrow(input))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      sendMessage()
    }
  })
  $('#sendBtn').addEventListener('click', sendMessage)

  $('#attachBtn').addEventListener('click', () => $('#filePicker').click())
  $('#filePicker').addEventListener('change', async (e) => {
    if (e.target.files?.length) await addFiles(e.target.files)
    e.target.value = ''
  })

  $('#steerToggle').addEventListener('click', openSteer)
  $('#steerClose').addEventListener('click', closeSteer)
  $('#steerSend').addEventListener('click', sendSteer)
  $('#cancelBtn').addEventListener('click', cancelRun)

  $('#refreshFs').addEventListener('click', () => fsList(state.fs.path))
  $('#upBtn').addEventListener('click', () => {
    if (!state.fs.crumbs.length) return
    const parent = state.fs.crumbs[state.fs.crumbs.length - 2]
    if (parent) fsList(parent.path)
  })
  $('#newFolderBtn').addEventListener('click', fsNewFolder)
  $('#newFileBtn').addEventListener('click', fsNewFile)
  $('#uploadBtn').addEventListener('click', () => $('#fsUploadPicker').click())
  $('#fsUploadPicker').addEventListener('change', async (e) => {
    if (e.target.files?.length) await fsUploadToCurrentDir(e.target.files)
    e.target.value = ''
  })

  $('#fileSheetClose').addEventListener('click', () => $('#fileSheet').classList.remove('open'))
  $('#fileSheet').addEventListener('click', (e) => {
    if (e.target.id === 'fileSheet') $('#fileSheet').classList.remove('open')
  })

  // 拖拽上传
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    if (!e.dataTransfer?.files?.length) return
    if (state.view === 'files') await fsUploadToCurrentDir(e.dataTransfer.files)
    else await addFiles(e.dataTransfer.files)
  })
}

/* ————————————————— 启动 ————————————————— */

async function boot() {
  try {
    const res = await fetch(`${API}/state`, { credentials: 'same-origin' })
    const json = await res.json()
    state.paired = Boolean(json.paired)
    state.device = json.device
    state.platform = json.platform || ''
    state.drives = json.drives || []
    if (!state.paired) {
      openPairSheet()
      return
    }
    closePairSheet()
    await loadSessions()
    if (state.sessions.length > 0) await openSession(state.sessions[0])
  } catch (e) {
    toast('初始化失败：' + e.message, 'err')
  }
}

initTheme()
bindEvents()
boot()
