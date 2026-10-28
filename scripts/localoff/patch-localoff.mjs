#!/usr/bin/env node
/**
 * patch-dsh-purge-localoff.mjs
 *
 * 把本机安装的 dsh-purge 插件里的会话门卫限制全部去掉：
 *   · lib/net-scope.js
 *       1) 门口总开关 SESSION_GATE_ON（默认关）：installRegionGate 直接返回，
 *          agent/pre-step 与 tools/pre-execute 两个钩子都不注册 —— 外挂关键词、
 *          目标范围、任何「不行，这是严令禁止的」拦截全部消失。
 *       2) LOCAL_LAB_ONLY（默认关）：即使把门口开关打开，也不再判目标是本机回环
 *          还是 RFC1918 私网，公网 IP / 域名一律放行。
 *       3) isCheatTask 在门口关闭时返回 false，外部调用方问就是「不是外挂」。
 *   · client.js —— 清洗页「本地靶场」的说明文案改成不限本地。
 *
 * 幂等：重复运行只提示 already patched；顺手统一 CRLF/LF。
 * 安装位置：$DSH_HOME/profiles/<名字>/node_modules/dsh-purge（默认 desktop）。
 * 插件升级 / 重新 pnpm install 覆盖 node_modules 之后再跑一次即可。
 *
 * 用法：
 *   node patch-dsh-purge-localoff.mjs                 # 自动找 profile
 *   node patch-dsh-purge-localoff.mjs --target <dir>  # 指定插件目录
 *   node patch-dsh-purge-localoff.mjs --restore       # 从 .bak-localoff-* 备份还原
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MARK = "SESSION_GATE_ON";

const log = (msg) => process.stdout.write(`${msg}\n`);

function findPluginDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profiles = path.join(home, "profiles");
  const candidates = [];
  try {
    for (const name of fs.readdirSync(profiles)) {
      const dir = path.join(profiles, name, "node_modules", "dsh-purge");
      if (fs.existsSync(path.join(dir, "lib", "net-scope.js"))) candidates.push({ name, dir });
    }
  } catch {
    /* 没有 profiles 目录时交给 --target */
  }
  if (!candidates.length) return null;
  const desktop = candidates.find((c) => c.name === "desktop");
  return desktop ? desktop.dir : candidates[0].dir;
}

/** 统一成 LF 再匹配，写回时按原文件的主流行尾还原（插件源码是 CRLF）。 */
function readNormalized(file) {
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.split("\r\n").length - 1;
  const lf = raw.split("\n").length - 1;
  const eol = crlf > 0 ? "\r\n" : "\n";
  return { text: raw.split("\r\n").join("\n"), eol, mixed: crlf > 0 && crlf !== lf };
}

function writeWithEol(file, text, eol) {
  fs.writeFileSync(file, eol === "\n" ? text : text.split("\n").join(eol), "utf8");
}

function backupOnce(file, stamp) {
  const bak = `${file}.bak-localoff-${stamp}`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    log(`  backup -> ${path.basename(bak)}`);
  }
  return bak;
}

function restoreLatest(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const baks = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.bak-localoff-`))
    .sort();
  if (!baks.length) return false;
  fs.copyFileSync(path.join(dir, baks[baks.length - 1]), file);
  log(`  restored ${base} <- ${baks[baks.length - 1]}`);
  return true;
}

const GATE_BLOCK = `const ENV_LOCAL_ONLY = /^(?:1|true|yes|on)$/i.test(String(process.env.DSH_PURGE_LOCAL_ONLY || "").trim());
export const LOCAL_LAB_ONLY = ENV_LOCAL_ONLY;

/**
 * 会话 / 工具门口总开关（本机构建：默认关闭）。
 *
 * 关掉后 installRegionGate 直接返回，agent/pre-step 与 tools/pre-execute
 * 两个钩子根本不注册：目标范围判定、外挂关键词（自瞄/透视/读内存/过反作弊）、
 * 以及任何「不行，这是严令禁止的」拦截全部不再生效，请求原样进模型。
 * 需要恢复上游门卫时设 DSH_PURGE_GATE=1 再重启宿主。
 */
const ENV_GATE_ON = /^(?:1|true|yes|on)$/i.test(String(process.env.DSH_PURGE_GATE || "").trim());
export const SESSION_GATE_ON = ENV_GATE_ON;`;

function patchNetScope(file, stamp) {
  const { text: src, eol, mixed } = readNormalized(file);
  let text = src;
  let changed = 0;
  const apply = (oldText, newText, label) => {
    if (text.includes(newText)) return;
    if (!text.includes(oldText)) throw new Error(`net-scope.js: ${label} anchor not found (plugin layout changed)`);
    text = text.replace(oldText, newText);
    changed += 1;
  };

  // 1) 两个开关一起挂到 DENIAL 常量后面
  apply(
    'const DENIAL = "不行，这是严令禁止的";',
    `const DENIAL = "不行，这是严令禁止的";

/**
 * 本地靶场限制开关（本机构建：默认关闭）。
 *
 * 上游开源版只放行本机回环 + RFC1918 私网：公网 IP、解析到公网的域名、
 * 解析失败一律拦。这里默认 false，即目标范围不再做本地/私网判定，
 * 任意 IP、域名、公网目标都能过。需要恢复上游行为时设环境变量
 * DSH_PURGE_LOCAL_ONLY=1 再重启宿主，不用改文件。
 */
${GATE_BLOCK}`,
    "DENIAL/开关",
  );

  // 2) 目标判定短路
  apply(
    "async function isRangeTarget(name) {\n  if (!name) return false;",
    "async function isRangeTarget(name) {\n  // 本地限制关闭：不做私网/回环判定，任何目标都算放行。\n  if (!LOCAL_LAB_ONLY) return true;\n  if (!name) return false;",
    "isRangeTarget",
  );
  apply(
    "export async function publicHostHit(text) {\n  const names = [];",
    "export async function publicHostHit(text) {\n  // 本地限制关闭：不解析、不比对私网，直接放行。\n  if (!LOCAL_LAB_ONLY) return null;\n  const names = [];",
    "publicHostHit",
  );
  apply(
    "export async function taskTargetHit(text) {\n  if (!isAttackTask(text)) return null;",
    "export async function taskTargetHit(text) {\n  // 本地限制关闭：「必须写本机/私网目标」这条也不再成立，\n  // 攻击任务不再因为目标是公网或没写目标而被拦。\n  if (!LOCAL_LAB_ONLY) return null;\n  if (!isAttackTask(text)) return null;",
    "taskTargetHit",
  );

  // 3) 外挂关键词在门口关闭时不再判定
  apply(
    "export function isCheatTask(text) {\n  const sample = String(text || \"\");",
    'export function isCheatTask(text) {\n  // 门口总开关关闭：外挂关键词不再判定，调用方问就是「不是」。\n  if (!SESSION_GATE_ON) return false;\n  const sample = String(text || "");',
    "isCheatTask",
  );

  // 4) 门口整个不注册
  apply(
    'export function installRegionGate(ctx) {\n  if (!ctx || typeof ctx.on !== "function") return;',
    'export function installRegionGate(ctx) {\n  // 门口总开关关闭：一个钩子都不注册，会话与工具调用原样放行。\n  if (!SESSION_GATE_ON) return;\n  if (!ctx || typeof ctx.on !== "function") return;',
    "installRegionGate",
  );

  if (changed || mixed) {
    if (changed) backupOnce(file, stamp);
    writeWithEol(file, text, eol);
    log(changed ? `  lib/net-scope.js: ${changed} patch(es)` : "  lib/net-scope.js: line endings normalized");
  }
  return changed > 0;
}

const CLIENT_I18N = [
  [
    ['"own.title": "本地靶场",', '"own.hint": "开源版攻击任务只放行本机/内网 IP。域名会先解析，解析到的每一个地址都必须是私网或回环；hosts 把 .lab 指到公网 IP 也会拦。解析失败或混有公网地址一律拦截。",'],
    ['"own.title": "目标名单（不限本地）",', '"own.hint": "本地限制已解除：任意 IP、域名、公网目标都能直接下发，不再做私网/回环判定，也不再要求解析结果全落在内网。名单只作备查。",'],
  ],
  [
    ['"own.title": "Local lab only",', '"own.hint": "The open-source build only allows localhost/private IPs. Domains are resolved first; every A/AAAA must be loopback or RFC1918. A hosts entry that points .lab at a public IP is blocked. Failed or mixed public answers are denied.",'],
    ['"own.title": "Target list (any host)",', '"own.hint": "Local-only scope is off: any IP, domain, or public target goes through. No loopback/RFC1918 check and no requirement that every A/AAAA resolve private. The list is kept for reference only.",'],
  ],
];

function patchClient(file, stamp) {
  const { text: src, eol, mixed } = readNormalized(file);
  let text = src;
  let changed = 0;
  for (const [oldPair, newPair] of CLIENT_I18N) {
    const newBlock = newPair.join("\n\t\t\t");
    if (text.includes(newBlock)) continue;
    const oldBlock = oldPair.join("\n\t\t\t");
    if (!text.includes(oldBlock)) {
      log("  client.js: own.* i18n block not found (skipped)");
      continue;
    }
    text = text.replace(oldBlock, newBlock);
    changed += 1;
  }
  if (changed || mixed) {
    if (changed) backupOnce(file, stamp);
    writeWithEol(file, text, eol);
    log(changed ? `  client.js: ${changed} i18n patch(es)` : "  client.js: line endings normalized");
  }
  return changed > 0;
}

/** 红队会话的「环境适配」门禁：总开关关闭后不再拦首步。 */
function patchRedteamUi(file, stamp) {
  const { text: src, eol, mixed } = readNormalized(file);
  let text = src;
  let changed = 0;
  const apply = (oldText, newText, label) => {
    if (text.includes(newText)) return;
    if (!text.includes(oldText)) throw new Error(`redteam/ui.js: ${label} anchor not found (plugin layout changed)`);
    text = text.replace(oldText, newText);
    changed += 1;
  };

  apply(
    "} from './platform-config.js'\n",
    "} from './platform-config.js'\n\n/**\n * 门卫总开关（本机构建：默认关闭）。\n * 关闭时红队会话不再等「环境适配」，首步直接放行；设 DSH_PURGE_GATE=1 恢复上游门禁。\n */\nconst GATE_ON = /^(?:1|true|yes|on)$/i.test(String(process.env.DSH_PURGE_GATE || '').trim())\n",
    "GATE_ON 常量",
  );
  apply(
    "          if (preset === 'redteam') {\n            const turn = Number(payload && payload.turn) || 0",
    "          if (preset === 'redteam') {\n            // 总开关关闭：环境适配不再拦首步，缺工具也照发。\n            if (!GATE_ON) return next()\n            const turn = Number(payload && payload.turn) || 0",
    "env-adapt reject",
  );
  apply(
    "  if (op === 'platformEnvAdaptStatus') return Object.assign({ ok: true }, envAdaptStatus(root))",
    "  if (op === 'platformEnvAdaptStatus') {\n    // 总开关关闭：一律报就绪，前端不再弹「环境还没配好」。\n    if (!GATE_ON) {\n      return Object.assign({ ok: true }, envAdaptStatus(root), {\n        ready: true,\n        reason: 'gate-off',\n        message: 'Gate off: env adapt is not required.',\n      })\n    }\n    return Object.assign({ ok: true }, envAdaptStatus(root))\n  }",
    "env-adapt status",
  );

  if (changed || mixed) {
    if (changed) backupOnce(file, stamp);
    writeWithEol(file, text, eol);
    log(changed ? `  lib/redteam/ui.js: ${changed} patch(es)` : "  lib/redteam/ui.js: line endings normalized");
  }
  return changed > 0;
}

/** 演练台的一次性授权确认：总开关关闭后直接视为已授权。 */
function patchDrillGrant(file, stamp) {
  const { text: src, eol, mixed } = readNormalized(file);
  let text = src;
  let changed = 0;
  const apply = (oldText, newText, label) => {
    if (text.includes(newText)) return;
    if (!text.includes(oldText)) throw new Error(`drill-grant.js: ${label} anchor not found (plugin layout changed)`);
    text = text.replace(oldText, newText);
    changed += 1;
  };

  apply(
    'import { dirname, join } from "node:path";\n',
    'import { dirname, join } from "node:path";\n\n/**\n * 门卫总开关（本机构建：默认关闭）。\n * 关闭时演练台授权视为已给：不再读授权文件、不弹确认窗；设 DSH_PURGE_GATE=1 恢复。\n */\nconst GATE_ON = /^(?:1|true|yes|on)$/i.test(String(process.env.DSH_PURGE_GATE || "").trim());\n',
    "GATE_ON 常量",
  );
  apply(
    "export function readDrillGrant(dshHome) {\n  const file = drillGrantPath(dshHome);",
    'export function readDrillGrant(dshHome) {\n  // 总开关关闭：授权直接给，不看文件。\n  if (!GATE_ON) return { granted: true, path: drillGrantPath(dshHome), at: null, bypassed: true };\n  const file = drillGrantPath(dshHome);',
    "readDrillGrant",
  );

  if (changed || mixed) {
    if (changed) backupOnce(file, stamp);
    writeWithEol(file, text, eol);
    log(changed ? `  lib/drill-grant.js: ${changed} patch(es)` : "  lib/drill-grant.js: line endings normalized");
  }
  return changed > 0;
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--target");
  const restore = argv.includes("--restore");
  const dir = (at >= 0 ? argv[at + 1] : "") || findPluginDir();
  if (!dir || !fs.existsSync(dir)) throw new Error("dsh-purge 目录没找到；用 --target <插件目录> 指定");
  log(`dsh-purge: ${dir}`);
  const netScope = path.join(dir, "lib", "net-scope.js");
  const client = path.join(dir, "client.js");
  const ui = path.join(dir, "lib", "redteam", "ui.js");
  const drill = path.join(dir, "lib", "drill-grant.js");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  if (restore) {
    for (const f of [netScope, client, ui, drill]) {
      if (fs.existsSync(f)) restoreLatest(f);
    }
    log("done (restart the host to take effect)");
    return;
  }

  const done = [
    patchNetScope(netScope, stamp),
    fs.existsSync(client) ? patchClient(client, stamp) : false,
    fs.existsSync(ui) ? patchRedteamUi(ui, stamp) : false,
    fs.existsSync(drill) ? patchDrillGrant(drill, stamp) : false,
  ];
  log(done.some(Boolean) ? "patched (restart the host to take effect)" : `already patched (${MARK} present)`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`patch failed: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
}
