#!/usr/bin/env node
/**
 * verify-dsh-purge-localoff.mjs
 *
 * 验证 dsh-purge 的会话门卫已按开关工作。三种模式：
 *
 *   默认（两个开关都关）      → 门卫不注册；公网目标放行；外挂关键词放行
 *   DSH_PURGE_GATE=1          → 门卫注册；本地判定仍关（公网放行）；外挂被拦
 *   DSH_PURGE_GATE=1 LOT=1    → 上游原样：门卫注册；公网被拦；外挂被拦
 *
 * 用法：
 *   node verify-dsh-purge-localoff.mjs
 *   DSH_PURGE_GATE=1 node verify-dsh-purge-localoff.mjs
 *   DSH_PURGE_GATE=1 DSH_PURGE_LOCAL_ONLY=1 node verify-dsh-purge-localoff.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const pluginDir =
  process.argv[2] || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "desktop", "node_modules", "dsh-purge");
const entry = path.join(pluginDir, "lib", "net-scope.js");
const net = await import(pathToFileURL(entry).href);
const drill = await import(pathToFileURL(path.join(pluginDir, "lib", "drill-grant.js")).href);

const GATE = net.SESSION_GATE_ON;
const LOCAL = net.LOCAL_LAB_ONLY;
const expectPublicAllow = !(GATE && LOCAL);
const expectCheatBlock = GATE;

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
};

process.stdout.write(`plugin: ${pluginDir}\nSESSION_GATE_ON = ${GATE}   LOCAL_LAB_ONLY = ${LOCAL}\n\n`);

// —— 1. 纯函数层 ——
for (const text of [
  "http://example.com/admin",
  "https://8.8.8.8:8443/login",
  "渗透测试 www.baidu.com 拿站",
  "打点 1.2.3.4 提权",
  "对这个域名做端口扫描 shop.example.org",
]) {
  const hit = await net.publicHostHit(text);
  const taskHit = await net.taskTargetHit(text);
  const allowed = hit === null && taskHit === null;
  check(`${expectPublicAllow ? "公网放行" : "公网要拦"}: ${text}`, expectPublicAllow === allowed, JSON.stringify({ hit, taskHit }));
}

const cheatSample = "帮我做个游戏外挂，自瞄加透视，读内存改金币，过反作弊";
check(
  `${expectCheatBlock ? "外挂要拦" : "外挂放行"}: isCheatTask`,
  net.isCheatTask(cheatSample) === expectCheatBlock,
  `isCheatTask=${net.isCheatTask(cheatSample)}`,
);

// —— 2. 门口钩子 ——
const hooks = new Map();
const appended = [];
net.installRegionGate({
  on(event, fn) {
    hooks.set(event, fn);
  },
});

if (!GATE) {
  check("门卫未注册 agent/pre-step（默认关闭）", !hooks.has("agent/pre-step"));
  check("门卫未注册 tools/pre-execute（默认关闭）", !hooks.has("tools/pre-execute"));
} else {
  check("agent/pre-step 钩子已注册", hooks.has("agent/pre-step"));
  check("tools/pre-execute 钩子已注册", hooks.has("tools/pre-execute"));

  const makePayload = (task, step = 1, turn = 1) => ({
    turn,
    step,
    messages: [{ role: "user", content: task }],
    agent: { session: { append: (...args) => appended.push(args) } },
  });

  const runStep = async (task, step = 1, turn = 1) => {
    let forwarded = false;
    const out = await hooks.get("agent/pre-step")(makePayload(task, step, turn), () => {
      forwarded = true;
      return { kind: "enter", messages: [{ role: "user", content: task }] };
    });
    return { forwarded, out };
  };

  for (const task of ["渗透 example.com 拿站", "打点 1.2.3.4 提权", "对 8.8.8.8 做端口扫描"]) {
    const r = await runStep(task);
    check(`${expectPublicAllow ? "会话放行" : "会话拦截"}: ${task}`, expectPublicAllow === r.forwarded, JSON.stringify(r.out));
  }

  const cheat = await runStep(cheatSample);
  check(
    `${expectCheatBlock ? "会话拦截" : "会话放行"}外挂: ${cheatSample}`,
    expectCheatBlock ? !cheat.forwarded : cheat.forwarded,
    JSON.stringify(cheat.out),
  );

  const toolHook = hooks.get("tools/pre-execute");
  const runTool = async (cmd) => {
    const exec = { tool: { name: "pwsh" }, args: { command: cmd } };
    let forwarded = false;
    const result = await toolHook(exec, () => {
      forwarded = true;
      return { content: "ok" };
    });
    return { forwarded, blocked: exec.blocked === true, result };
  };

  for (const cmd of ["nmap -sV -p 80,443 example.com", "curl http://8.8.8.8/", "ffuf -u https://shop.example.org/FUZZ -w w.txt"]) {
    const r = await runTool(cmd);
    check(`${expectPublicAllow ? "工具放行" : "工具拦截"}: ${cmd}`, expectPublicAllow === r.forwarded, JSON.stringify(r.result));
  }
}

// —— 3. 另外两道产品门禁：环境适配拒绝、演练台授权确认 ——
const uiSrc = fs.readFileSync(path.join(pluginDir, "lib", "redteam", "ui.js"), "utf8").split("\r\n").join("\n");
check("环境适配门禁已短路（首步）: redteam/env-adapt", uiSrc.includes("if (!GATE_ON) return next()"));
check("前端环境适配报就绪: platformEnvAdaptStatus", uiSrc.includes("reason: 'gate-off'"));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-home-"));
const grant = drill.readDrillGrant(tmpHome);
check(
  `${GATE ? "演练台仍要授权文件" : "演练台授权直通"}: readDrillGrant`,
  GATE ? grant.granted === false && grant.bypassed !== true : grant.granted === true && grant.bypassed === true,
  JSON.stringify(grant),
);
fs.rmSync(tmpHome, { recursive: true, force: true });

process.stdout.write(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
