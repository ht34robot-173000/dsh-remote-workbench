// 离线验证 fs-ops 的行为，不启动 DSH、不注册任何路由。
import {
  listDir, readText, writeText, makeDir, makeFile, remove, move, copy,
  saveUpload, readRaw, mimeOf, isAbsolutePath, listDrives,
} from './lib/fs-ops.js'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const root = join(tmpdir(), `rw-verify-${Date.now()}`)
mkdirSync(root, { recursive: true })

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

console.log('\n[1] 绝对路径判定')
check('Windows 盘符', isAbsolutePath('F:\\插件'))
check('Windows 正斜杠', isAbsolutePath('F:/插件'))
check('UNC', isAbsolutePath('\\\\server\\share'))
check('相对路径被拒', !isAbsolutePath('relative/path'))
check('空串被拒', !isAbsolutePath(''))

console.log('\n[2] 列目录')
await writeText({ path: join(root, 'a.txt'), text: 'hello' })
await makeDir({ path: join(root, 'sub') })
await makeFile({ path: join(root, 'b.md') })
const listing = await listDir({ path: root })
check('list ok', listing.ok)
const names = listing.ok ? listing.value.entries.map((e) => e.name) : []
check('包含目录与文件', names.includes('sub') && names.includes('a.txt') && names.includes('b.md'), JSON.stringify(names))
check('目录排在前', names[0] === 'sub', JSON.stringify(names))

console.log('\n[3] 读文本')
const rt = await readText({ path: join(root, 'a.txt') })
check('读到内容', rt.ok && rt.value.text === 'hello')

console.log('\n[4] 写文本 + 覆盖')
await writeText({ path: join(root, 'a.txt'), text: 'world' })
const rt2 = await readText({ path: join(root, 'a.txt') })
check('覆盖成功', rt2.ok && rt2.value.text === 'world')

console.log('\n[5] 创建目录（含父级）')
const deep = join(root, 'x', 'y', 'z')
const mk = await makeDir({ path: deep })
check('递归建目录', mk.ok && existsSync(deep))

console.log('\n[6] 复制 / 移动')
await writeText({ path: join(root, 'src.txt'), text: 'copy me' })
const cp = await copy({ from: join(root, 'src.txt'), to: join(root, 'dst.txt') })
check('复制文件', cp.ok && existsSync(join(root, 'dst.txt')))
const mv = await move({ from: join(root, 'dst.txt'), to: join(root, 'moved.txt') })
check('移动文件', mv.ok && existsSync(join(root, 'moved.txt')) && !existsSync(join(root, 'dst.txt')))

console.log('\n[7] 删除保护')
const nonEmpty = join(root, 'sub')
await writeText({ path: join(nonEmpty, 'inner.txt'), text: 'x' })
const rmNoRec = await remove({ path: nonEmpty })
check('非空目录默认拒删', !rmNoRec.ok && rmNoRec.error.code === 'directory-not-empty')
const rmRec = await remove({ path: nonEmpty, recursive: true })
check('递归删除成功', rmRec.ok && !existsSync(nonEmpty))

console.log('\n[8] 上传落盘')
const up = await saveUpload({
  dir: join(root, 'up'),
  name: 'hello.txt',
  base64: Buffer.from('uploaded content').toString('base64'),
})
check('上传成功', up.ok && up.value.name === 'hello.txt')
const upText = await readText({ path: join(root, 'up', 'hello.txt') })
check('内容正确', upText.ok && upText.value.text === 'uploaded content')

console.log('\n[9] 路径逃逸防护')
const evil = await saveUpload({
  dir: join(root, 'up'),
  name: '../../escaped.txt',
  base64: Buffer.from('bad').toString('base64'),
})
check('name 被 basename 化', evil.ok ? !evil.value.path.includes('..') : true, evil.ok ? evil.value.path : '')

console.log('\n[10] 相对路径拒绝')
check('相对路径 list 被拒', !(await listDir({ path: 'relative/dir' })).ok)
check('相对路径 read 被拒', !(await readText({ path: 'some/file.txt' })).ok)

console.log('\n[11] 二进制识别')
const binPath = join(root, 'blob.bin')
await saveUpload({ dir: root, name: 'blob.bin', base64: Buffer.from([0, 1, 2, 3, 0, 255]).toString('base64') })
const bin = await readText({ path: binPath })
check('二进制被读写路径挡住', !bin.ok && bin.error.code === 'binary-file')
const raw = await readRaw({ path: binPath })
check('raw 能取到字节', raw.ok && raw.value.size === 6)

console.log('\n[12] MIME 与盘符')
check('png MIME', mimeOf('a.png') === 'image/png')
check('未知 MIME', mimeOf('a.xyz') === 'application/octet-stream')
check('盘符列表非空', listDrives().length > 0)

console.log('\n[13] 家目录可列')
const homeList = await listDir({ path: homedir() })
check('家目录列得出来', homeList.ok, homeList.ok ? '' : homeList.error?.message)

// 清理
try { rmSync(root, { recursive: true, force: true }) } catch {}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
