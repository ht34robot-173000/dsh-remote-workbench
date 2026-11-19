// 端到端测试：配对 -> 带 cookie 调文件 API -> 验证全读写
const BASE = 'http://127.0.0.1:19387/rw'

let pass = 0, fail = 0
const check = (n, c, x) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x || ''}`)) }

console.log('[1] 生成配对码')
const pair = await (await fetch(`${BASE}/pair/new`, { method: 'POST' })).json()
check('拿到配对码', /^\d{6}$/.test(pair.code || ''), JSON.stringify(pair))

console.log('[2] 用配对码换 cookie')
const acceptRes = await fetch(`${BASE}/pair/accept`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: pair.code }),
})
const acceptJson = await acceptRes.json()
const setCookie = acceptRes.headers.get('set-cookie') || ''
const cookie = setCookie.split(';')[0]
check('配对成功', acceptJson.ok === true, JSON.stringify(acceptJson))
check('拿到设备 cookie', cookie.startsWith('rw_device='), cookie)

console.log('[3] 带 cookie 读状态')
const st = await (await fetch(`${BASE}/api/state`, { headers: { cookie } })).json()
check('已配对状态', st.paired === true)

console.log('[4] 列家目录')
const list = await (await fetch(`${BASE}/api/fs.list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ path: st.home }),
})).json()
check('列目录成功', list.ok === true, JSON.stringify(list).slice(0, 200))
const entries = list.ok ? list.value.entries : []
check('有目录与文件', entries.length > 0, `共 ${entries.length} 项`)
check('有面包屑', Array.isArray(list.value?.crumbs) && list.value.crumbs.length > 0)

console.log('[5] 创建测试目录并写入文件')
const tmp = st.home + '\\rw-e2e-test'
await fetch(`${BASE}/api/fs.mkdir`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ path: tmp }),
})
const w = await (await fetch(`${BASE}/api/fs.write`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ path: tmp + '\\hello.txt', text: '端到端测试内容' }),
})).json()
check('写文件成功', w.ok === true, JSON.stringify(w))

console.log('[6] 读回内容')
const r = await (await fetch(`${BASE}/api/fs.read`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ path: tmp + '\\hello.txt' }),
})).json()
check('内容一致', r.ok && r.value.text === '端到端测试内容', JSON.stringify(r).slice(0, 200))

console.log('[7] 上传二进制')
const b64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
const up = await (await fetch(`${BASE}/api/fs.upload`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ dir: tmp, name: 'tiny.png', base64: b64 }),
})).json()
check('上传成功', up.ok === true, JSON.stringify(up))

console.log('[8] 下载验证')
const dl = await fetch(`${BASE}/api/fs.download?path=${encodeURIComponent(tmp + '\\tiny.png')}`, { headers: { cookie } })
const bytes = new Uint8Array(await dl.arrayBuffer())
check('下载字节正确', bytes.length === 8 && bytes[0] === 137 && bytes[1] === 80, `len=${bytes.length}`)

console.log('[9] 重命名')
const mv = await (await fetch(`${BASE}/api/fs.move`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ from: tmp + '\\hello.txt', to: tmp + '\\renamed.txt' }),
})).json()
check('重命名成功', mv.ok === true, JSON.stringify(mv))

console.log('[10] 清理')
const rm = await (await fetch(`${BASE}/api/fs.remove`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ path: tmp, recursive: true }),
})).json()
check('递归删除成功', rm.ok === true, JSON.stringify(rm))

console.log('[11] 会话列表')
const sess = await (await fetch(`${BASE}/api/session.list`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({}),
})).json()
check('会话接口有响应', typeof sess === 'object', JSON.stringify(sess).slice(0, 160))

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
console.log(`设备 cookie（会话可复用）: ${cookie}`)
process.exit(fail === 0 ? 0 : 1)
