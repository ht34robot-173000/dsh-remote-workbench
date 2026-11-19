/*
 * measure-gzip-real.mjs — 用真实会话历史测压缩比
 *
 * verify-gzip.mjs 用的是人造重复文本，压缩比会好得不真实。
 * 这个脚本直接打宿主接口取**真实的历史响应**，量出：
 *   原始体积 / gzip 体积 / 压缩比 / 在 0.86 MB/s 上行下各要多久
 *
 * 需要：宿主在跑，且有设备 cookie（先跑 pair 流程）。
 * 用法：node measure-gzip-real.mjs <cookie>
 */
import { gzipSync, brotliCompressSync } from 'node:zlib'

const BASE = 'http://127.0.0.1:19387'
const cookie = process.argv[2] ?? ''

if (!cookie) {
  console.error('用法: node measure-gzip-real.mjs "rw_device=..."')
  process.exit(2)
}

async function api(path, body = {}) {
  const r = await fetch(`${BASE}/rw/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, text }
}

console.log('=== 取会话列表，挑消息最多的一个 ===')
const list = await api('session.list')
if (list.status !== 200) {
  console.error(`session.list HTTP ${list.status}: ${list.text.slice(0, 200)}`)
  process.exit(1)
}
const items = JSON.parse(list.text)?.value?.items ?? []
console.log(`  会话数: ${items.length}`)

// 按 messageCount 找不到就按 updatedAt，两个都没有就逐个试
const candidates = [...items]
  .sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  .slice(0, 6)

const UPSTREAM = 0.86 * 1024 * 1024   // 实测上行 0.86 MB/s（字节/秒）

console.log('\n=== 逐个量真实 session.history 的体积与压缩比 ===')
console.log('  会话'.padEnd(36) + '原始'.padStart(10) + 'gzip'.padStart(10) + '比例'.padStart(8)
  + '  gzip后耗时'.padStart(12))

let best = null
for (const s of candidates) {
  const h = await api('session.history', { sessionId: s.id, maxMessages: 40 })
  if (h.status !== 200) continue
  const raw = Buffer.from(h.text, 'utf8')
  const gz = gzipSync(raw, { level: 6 })
  const ratio = gz.length / raw.length
  const secs = gz.length / UPSTREAM

  const label = (s.title || s.id).slice(0, 34)
  console.log(
    '  ' + label.padEnd(36)
    + `${(raw.length / 1024).toFixed(1)}KB`.padStart(10)
    + `${(gz.length / 1024).toFixed(1)}KB`.padStart(10)
    + `${(ratio * 100).toFixed(1)}%`.padStart(8)
    + `${secs.toFixed(2)}s`.padStart(12),
  )

  if (!best || raw.length > best.raw) best = { raw: raw.length, gz: gz.length, ratio, secs, title: label }
}

if (best) {
  console.log('\n=== 最大那个会话的结论 ===')
  console.log(`  会话     : ${best.title}`)
  console.log(`  原始     : ${(best.raw / 1024).toFixed(1)} KB`)
  console.log(`  gzip     : ${(best.gz / 1024).toFixed(1)} KB`)
  console.log(`  压缩比   : ${(best.ratio * 100).toFixed(1)}%`)
  console.log(`  gzip前   : ${(best.raw / UPSTREAM).toFixed(2)} 秒（0.86 MB/s 上行）`)
  console.log(`  gzip后   : ${best.secs.toFixed(2)} 秒`)
  console.log(`  提升     : ${((best.raw / UPSTREAM) / best.secs).toFixed(1)} 倍`)

  // 顺便看看 brotli 值不值得（需要 App 端支持，OkHttp 不默认发 br）
  const br = brotliCompressSync(Buffer.alloc(0)) // 占位
  void br
}
