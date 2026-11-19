/*
 * verify-icons.mjs — 用**真实数据**校验 SVG 路径解析器
 *
 * 为什么需要这个：2026-11-16 我把图标库的第一版发上去，App 直接卡在启动闪屏。
 * 根因是解析器只实现了 M/L/H/V/C/Z，而 Material Symbols 的路径大量使用
 * Q/q/T/t（实测 Q 6、q 593、T 414、t 181）。不认识的命令走进空的 else 分支
 * ——游标不动——主线程死循环。没有 FATAL 日志，`mCurrentFocus=null`，
 * 靠 kill -3 抓栈才定位到。
 *
 * 所以这个脚本做两件事：
 *   1. 从 Icons.kt 里抽出全部 pathData，**按真实数据**跑一遍解析
 *   2. 断言解析过程中游标一定推进（这正是当初死循环的地方）
 *
 * 用法：node verify-icons.mjs
 */
import { readFileSync } from 'node:fs'

const KT = 'F:/插件/dsh-mobile/02-源码/android-app-workbench/app/src/main/java/com/dsh/workbench/ui/Icons.kt'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  OK  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`) }
}

// ——————— 从 Kotlin 源码抽出字形 ———————
const src = readFileSync(KT, 'utf8')
const glyphs = []
for (const m of src.matchAll(/^\s{8}(\w+)\("(M[^"]+)"\)/gm)) {
  glyphs.push({ name: m[1], d: m[2] })
}
check(`从 Icons.kt 抽到 ${glyphs.length} 个字形`, glyphs.length >= 40)

// ——————— 真实数据里出现了哪些命令字母 ———————
const letters = new Map()
for (const g of glyphs) {
  for (const ch of g.d) if (/[A-Za-z]/.test(ch)) letters.set(ch, (letters.get(ch) ?? 0) + 1)
}
const supported = new Set('MmLlHhVvCcSsQqTtZz'.split(''))
console.log(`  数据里的命令: ${[...letters.entries()].sort().map(([k, v]) => `${k}×${v}`).join(' ')}`)

const unsupported = [...letters.keys()].filter((c) => !supported.has(c))
check(
  '数据里没有解析器不支持的命令',
  unsupported.length === 0,
  unsupported.length ? `不支持的: ${unsupported.join(', ')}` : '',
)

// ——————— 按 Kotlin 的同一套逻辑复刻解析，验证游标一定推进 ———————
function parseTrace(d) {
  const nums = []
  const cmds = []
  let i = 0
  while (i < d.length) {
    const c = d[i]
    if (/\s/.test(c) || c === ',') { i++; continue }
    if (/[A-Za-z]/.test(c)) { cmds.push(c); nums.push(NaN); i++; continue }
    const start = i
    if (d[i] === '-' || d[i] === '+') i++
    while (i < d.length && /[0-9.]/.test(d[i])) i++
    if (i < d.length && (d[i] === 'e' || d[i] === 'E')) {
      i++
      if (i < d.length && (d[i] === '-' || d[i] === '+')) i++
      while (i < d.length && /[0-9]/.test(d[i])) i++
    }
    const text = d.slice(start, i)
    const v = Number(text)
    if (!Number.isNaN(v) && text !== '') nums.push(v)
    else if (text === '') i++
  }

  let cmdIndex = -1
  let n = 0
  let steps = 0
  let stuck = 0
  const maxSteps = nums.length * 4 + 1000   // 远大于正常所需，超了就是没推进
  while (n < nums.length) {
    if (++steps > maxSteps) return { ok: false, reason: '步数爆炸（疑似死循环）', steps }
    if (Number.isNaN(nums[n])) { cmdIndex++; n++; continue }
    if (cmdIndex < 0) { n++; continue }
    const before = n
    // 参数个数表：消费这么多数字（不够就退化为全部吃完）
    const arity = { M: 2, m: 2, L: 2, l: 2, H: 1, h: 1, V: 1, v: 1,
                    C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2, Z: 0, z: 0 }
    const cmd = cmds[cmdIndex]
    const need = arity[cmd]
    if (need === undefined) {
      while (n < nums.length && !Number.isNaN(nums[n])) n++
    } else {
      for (let k = 0; k < need; k++) {
        if (n < nums.length && !Number.isNaN(nums[n])) n++; else break
      }
    }
    if (n === before) { stuck++; n++ }
  }
  return { ok: stuck === 0, stuck, steps, total: nums.length }
}

let allOk = true
let worst = null
for (const g of glyphs) {
  const r = parseTrace(g.d)
  if (!r.ok) {
    allOk = false
    console.log(`  FAIL ${g.name}: ${r.reason ?? `有 ${r.stuck} 处游标没推进`}`)
  }
  if (!worst || (r.steps ?? 0) > (worst.steps ?? 0)) worst = { name: g.name, ...r }
}
check(`${glyphs.length} 个字形全部解析完成且游标始终推进`, allOk)
console.log(`  最复杂的一个: ${worst.name}（${worst.total} 个数字 / ${worst.steps} 步）`)

// ——————— 边界情况：坏数据也不能死循环 ———————
const bad = [
  'M10 10 A 5 5 0 0 1 20 20',   // A 圆弧（当前不支持但必须能跳过）
  'M0 0 X 1 2 3',               // 完全不认识的命令
  'M',                          // 命令后面没参数
  '',                           // 空串
  'M10 10 L',                   // 参数不齐
]
let badOk = true
for (const d of bad) {
  const r = parseTrace(d)
  if (!r.ok) { badOk = false; console.log(`  FAIL 坏数据 "${d}": ${r.reason ?? r.stuck}`) }
}
check('坏数据/不支持的命令不会死循环', badOk)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
