// 本地覆盖的单元测试：node test/local-config.mjs
// 只依赖 lib/local-config.js（不碰 schemastery，仓库里没有那个包也能跑）。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'dsh-toolkit-test-'))
process.env.DSH_HOME = dir

const { mergeDeep, readLocalConfig, localConfigPath } = await import('../lib/local-config.js')

// 1. 深合并：只覆盖局部键，其它保留，且不改动传入对象
const base = { qq: { allow_users: [123456789], napcat_path: 'X' }, restart: { resume_max: 2 } }
const local = { qq: { allow_users: [392593439] } }
const merged = mergeDeep(base, local)
assert.deepEqual(merged.qq.allow_users, [392593439])
assert.equal(merged.qq.napcat_path, 'X')
assert.equal(merged.restart.resume_max, 2)
assert.deepEqual(base.qq.allow_users, [123456789], '不应改动传入对象')

// 2. 标量覆盖
assert.equal(mergeDeep({ a: 1 }, { a: 2 }).a, 2)

// 3. 没有文件时返回 null
assert.equal(readLocalConfig(), null)

// 4. 坏 JSON 只告警不抛
writeFileSync(join(dir, 'dsh-toolkit.local.json'), '{ 不是 json')
const warnings = []
assert.equal(readLocalConfig((m) => warnings.push(m)), null)
assert.equal(warnings.length, 1)

// 5. 好文件能读、路径正确
writeFileSync(
  join(dir, 'dsh-toolkit.local.json'),
  JSON.stringify({ qq: { allow_users: [392593439], dsh_exe: 'D:/DSH/DeepSeek Harness.exe' } }),
)
assert.equal(localConfigPath(), join(dir, 'dsh-toolkit.local.json'))
const read = readLocalConfig()
assert.deepEqual(read.qq.allow_users, [392593439])

// 6. 用真值覆盖模板，未覆盖的键不受影响
const effective = mergeDeep({ qq: { allow_users: [123456789], prefix: '#' }, restart: { resume_max: 2 } }, read)
assert.deepEqual(effective.qq.allow_users, [392593439])
assert.equal(effective.qq.prefix, '#')
assert.equal(effective.restart.resume_max, 2)

rmSync(dir, { recursive: true, force: true })
console.log('local-config 测试通过：深合并 / 覆盖 / 坏文件 / 模板优先级')
