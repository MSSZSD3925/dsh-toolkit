// 本机配置覆盖：把「不该进 git 的真值」从 cordis.patch.yml 里拆出来。
//
// 仓库里 cordis.patch.yml 只放占位符（QQ 号 123456789、<NapCat 安装目录>…），
// 真实值写在 ${DSH_HOME:-~/.dsh}/dsh-toolkit.local.json，启动时深合并覆盖模板。
// 这样 checkout / reset / pull 冲掉模板也不会影响本机行为。
//
// 文件结构随意，顶层必须是对象，通常只写要覆盖的那几项：
//   {
//     "qq": { "allow_users": [392593439], "napcat_path": "D:/…", "dsh_exe": "D:/…" },
//     "restart": { "log_path": "C:/Users/…/dsh-restart.log" }
//   }

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOCAL_FILE = 'dsh-toolkit.local.json'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function localConfigPath() {
  return join(dshHome(), LOCAL_FILE)
}

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并：对象递归，数组与标量直接覆盖；不改动传入对象。 */
export function mergeDeep(base, extra) {
  if (!isObject(base) || !isObject(extra)) return extra
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObject(v) && isObject(base[k]) ? mergeDeep(base[k], v) : v
  }
  return out
}

/** 读本地覆盖文件；不存在返回 null，坏文件只告警、不阻断启动。 */
export function readLocalConfig(log = () => {}) {
  const path = localConfigPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!isObject(raw)) throw new Error('顶层必须是对象')
    log(`本地配置已合并：${path}`)
    return raw
  } catch (err) {
    log(`本地配置 ${path} 读不了（${err.message}），只用 patch 里的值`)
    return null
  }
}
