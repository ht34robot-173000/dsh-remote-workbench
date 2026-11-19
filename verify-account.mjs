/*
 * verify-account.cjs — 离线验证 lib/account.js 的形状处理
 *
 * 为什么需要这个：真实宿主跑的是**启动时**加载的旧代码，改完插件不重启
 * 就测不到新路由（会返回 405）。而重启 DSH 会打断当前会话。
 *
 * 所以分两步验：
 *   1. 这里用假的 ctx 跑一遍 account.js，验「形状归一 + 失败不互相影响」
 *   2. 重启后用真实接口验一次（见文件末尾的手工命令）
 *
 * 用法：node verify-account.cjs
 *
 * 只验证纯逻辑 —— 不发网络、不读凭据、不碰真实账号。
 */
const { makeAccountOps } = await import(
  'file:///F:/插件/dsh-mobile/02-源码/host-plugin-dsh-remote-workbench/lib/account.js'
)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  OK  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`) }
}

/** 造一个假 ctx：get(name) 返回给定服务。 */
function ctxOf(svc) {
  return { get: (n) => (n === 'deepseekAccount' ? svc : undefined) }
}

console.log('=== 1. 服务缺失 ===')
{
  const ops = makeAccountOps(ctxOf(undefined))
  const r = await ops.overview()
  check('overview 报 account-unavailable', r.ok === false && r.error.code === 'account-unavailable')
  const b = await ops.balance()
  check('balance 报 account-unavailable', b.ok === false && b.error.code === 'account-unavailable')
}

console.log('\n=== 2. 正常：已登录 + 有余额 ===')
{
  const svc = {
    getState: async () => ({
      status: 'credential-stored',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: null,
    }),
    getProfile: async (client) => {
      // 顺手验一下 meta 三个字段齐不齐（缺了真实宿主会抛 schema 错）
      if (!client || typeof client.version !== 'string' || client.version === '') throw new Error('meta.version')
      if (typeof client.locale !== 'string') throw new Error('meta.locale')
      if (typeof client.timezoneOffsetSeconds !== 'number') throw new Error('meta.timezoneOffsetSeconds')
      return { status: 'ready', value: { id: 'uid-1', name: '纸盒咸鱼', contact: 'a@b.c' } }
    },
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '12.34' }],
      bonusWallets: [{ currency: 'CNY', balance: '0.00' }],
    }),
  }
  const ops = makeAccountOps(ctxOf(svc))
  const r = await ops.overview()
  check('overview ok', r.ok === true)
  check('state 有值', r.value.state.value.status === 'credential-stored')
  check('profile 有值', r.value.profile.value.value.name === '纸盒咸鱼')
  check('balance 有值', r.value.balance.value.value[0].balance === '12.34')
  check('meta 三字段齐全（由 getProfile 内的断言兜住）', true)
}

console.log('\n=== 3. 未登录：三个都返回 null，但不算失败 ===')
{
  const svc = {
    getState: async () => ({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }),
    getProfile: async () => null,
    getBalance: async () => null,
  }
  const ops = makeAccountOps(ctxOf(svc))
  const r = await ops.overview()
  check('overview 仍 ok（未登录不是错误）', r.ok === true)
  check('profile 为 null', r.value.profile.value === null)
  check('balance 为 null', r.value.balance.value === null)
}

console.log('\n=== 4. 局部失败：余额超时不能拖死资料 ===')
{
  const svc = {
    getState: async () => ({ status: 'credential-stored', links: {}, attempt: null }),
    getProfile: async () => ({ status: 'ready', value: { id: 'u', name: 'n', contact: null } }),
    getBalance: async () => { const e = new Error('timeout'); e.code = 'network'; throw e },
  }
  const ops = makeAccountOps(ctxOf(svc))
  const r = await ops.overview()
  check('overview 仍 ok', r.ok === true)
  check('profile 成功', r.value.profile.value.value.name === 'n')
  check('balance 单独报错', r.value.balance.error === 'network', JSON.stringify(r.value.balance))
}

console.log('\n=== 5. 方法不存在时不崩 ===')
{
  const svc = { getState: async () => ({ status: 'signed-out', links: {}, attempt: null }) }
  const ops = makeAccountOps(ctxOf(svc))
  const r = await ops.overview()
  check('overview 不抛', r.ok === true)
  check('profile 报 unsupported', r.value.profile.error === 'profile-unsupported')
  check('balance 报 unsupported', r.value.balance.error === 'balance-unsupported')
}

console.log('\n=== 6. 后端金额规范化（源头收口）===')
{
  /*
   * Platform 原样返回 `32.2317866000000000` 这种浮点尾巴。
   * App 侧虽然会格式化，但那串东西会沿着接口流到任何消费者
   * （网页版、curl 输出、以后的通知文案）。所以在源头就收口。
   */
  const cases = [
    ['32.2317866000000000', '32.23'],  // 真实余额：截断到分
    ['12.345', '12.34'],               // 正数截断，不四舍五入
    ['0.001', '0.00'],                 // 不足一分（App 侧再显示 <0.01）
    ['0', '0.00'],
    ['1234.5', '1234.50'],
    ['007.5', '7.50'],                 // 前导零去掉
    ['-0.001', '-0.01'],               // 负数绝对值至少 0.01
    ['-1.239', '-1.24'],               // 负数四舍五入
    ['abc', 'abc'],                    // 解析不了原样返回
  ]
  const svc = {
    getState: async () => ({ status: 'credential-stored', links: {}, attempt: null }),
    getProfile: async () => null,
    getBalance: async () => ({
      status: 'ready',
      value: cases.map(([raw]) => ({ currency: 'CNY', balance: raw })),
      bonusWallets: [],
    }),
  }
  const r = await makeAccountOps(ctxOf(svc)).balance()
  const got = r.value.value.map((w) => w.balance)
  let ok = true
  for (let i = 0; i < cases.length; i++) {
    const [raw, want] = cases[i]
    if (got[i] !== want) { ok = false; console.log(`  FAIL ${raw} -> ${got[i]}（期望 ${want}）`) }
  }
  check(`${cases.length} 个金额全部规范化正确`, ok, JSON.stringify(got))
}

console.log('\n=== 7. 失败态不被规范化（不能伪造 0）===')
{
  const svc = {
    getState: async () => ({ status: 'credential-stored', links: {}, attempt: null }),
    getProfile: async () => null,
    getBalance: async () => ({ status: 'failed' }),
  }
  const r = await makeAccountOps(ctxOf(svc)).balance()
  check(
    'failed 原样透传',
    r.value.status === 'failed' && r.value.value === undefined,
    JSON.stringify(r.value),
  )
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
console.log(`
重启 DSH 后，用真实接口再验一次（cookie 从 pair 流程拿）：
  $ck = (Get-Content "$env:TEMP\\rw-cookie.txt" -Raw)
  Invoke-RestMethod 'http://127.0.0.1:19387/rw/api/account.overview' -Method Post \`
    -ContentType 'application/json' -Body '{}' -Headers @{Cookie=$ck} | ConvertTo-Json -Depth 8
期望：ok=true，value 里含 state / profile / balance 三块。
`)
process.exit(fail === 0 ? 0 : 1)
