/**
 * 演练台授权落在当前 $DSH_HOME/dsh-purge，不进插件包，也不进用户主目录下的共享文件夹。
 * 插件更新只换 node_modules，这个文件还在，所以不再弹窗。
 * 成功卸载会删掉这一份；Web 和桌面各记各的。文件不存在才重新确认。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 门卫总开关（本机构建：默认关闭）。
 * 关闭时演练台授权视为已给：不再读授权文件、不弹确认窗；设 DSH_PURGE_GATE=1 恢复。
 */
const GATE_ON = /^(?:1|true|yes|on)$/i.test(String(process.env.DSH_PURGE_GATE || "").trim());

export function drillGrantPath(dshHome) {
  return join(dshHome, "dsh-purge", "drill-grant.json");
}

export function readDrillGrant(dshHome) {
  // 总开关关闭：授权直接给，不看文件。
  if (!GATE_ON) return { granted: true, path: drillGrantPath(dshHome), at: null, bypassed: true };
  const file = drillGrantPath(dshHome);
  if (!existsSync(file)) return { granted: false, path: file };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      granted: !!(raw && raw.granted === true),
      path: file,
      at: raw && raw.at ? raw.at : null,
    };
  } catch {
    return { granted: false, path: file };
  }
}

export function writeDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const at = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify({ granted: true, at }, null, 2)}\n`, "utf8");
  try {
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 临时文件留不住就让原错误抛出 */ }
    throw error;
  }
  return readDrillGrant(dshHome);
}

/** 只删当前安装的授权文件。失败向上抛，不删整个目录。 */
export function clearDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
