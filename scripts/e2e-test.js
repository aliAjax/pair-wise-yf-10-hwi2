#!/usr/bin/env node
// 端到端验证：占用互斥、版本冲突、取消、超时接管、重启后状态
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const SECTION = "section_demo_2";
const dbPath = path.join(os.tmpdir(), `strip-test-${Date.now()}.json`);

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(PORT), DB_FILE: dbPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running")) resolve(child);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => {
      if (code) reject(new Error(`server exited ${code}`));
    });
    setTimeout(() => reject(new Error("server start timeout")), 5000);
  });
}

async function req(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

let passed = 0;
function check(name, condition, extra) {
  if (!condition) {
    console.error(`FAIL: ${name}`, extra || "");
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`PASS: ${name}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  server = await startServer();

  // 1. 甲领取成功
  let r = await req("POST", `/sections/${SECTION}/claim`, { holder: "甲", ttlMs: 600000 });
  check("甲领取成功", r.status === 200 && r.json.claim.status === "acquired", r.json);
  check("领取返回 baseVersion=0", r.json.claim.baseVersion === 0, r.json.claim);

  // 2. 乙同时领取被拒，需等待
  r = await req("POST", `/sections/${SECTION}/claim`, { holder: "乙" });
  check("乙被占用挡住(409 SECTION_OCCUPIED)", r.status === 409 && r.json.code === "SECTION_OCCUPIED", r.json);
  check("冲突返回 retryAfterMs", typeof r.json.details.retryAfterMs === "number", r.json.details);

  // 3. 非占用者提交被拒
  r = await req("POST", `/sections/${SECTION}/trial`, { holder: "乙", version: 0, note: "乙的结果" });
  check("乙提交被拒(409)", r.status === 409, r.json);

  // 4. 乙无法取消甲的占用
  r = await req("DELETE", `/sections/${SECTION}/claim`, { holder: "乙" });
  check("乙不能取消甲的占用", r.status === 409 && r.json.code === "OCCUPANCY_HOLDER_MISMATCH", r.json);

  // 5. 版本过期：区间在甲领取后被旧接口更新（版本推进），甲再提交被拒
  r = await req("PATCH", `/sections/${SECTION}/check`, { note: "管理员补改" });
  check("旧接口推进版本到1", r.json.data.version === 1, r.json.data);
  r = await req("POST", `/sections/${SECTION}/trial`, { holder: "甲", version: 0, note: "甲的结果" });
  check("过期版本提交被拒(VERSION_STALE)", r.status === 409 && r.json.code === "VERSION_STALE", r.json);
  check("过期提交后占用已释放", r.json.details.currentVersion === 1, r.json.details);

  // 6. 甲重新领取拿到新版本，提交成功
  r = await req("POST", `/sections/${SECTION}/claim`, { holder: "甲" });
  check("甲重新领取拿到版本1", r.json.claim.baseVersion === 1, r.json.claim);
  r = await req("POST", `/sections/${SECTION}/trial`, { holder: "甲", version: 1, note: "副歌已试奏" });
  check("甲带正确版本提交成功", r.status === 200 && r.json.section.proofState === "submitted", r.json);
  check("提交后版本推进到2", r.json.section.version === 2, r.json.section);
  check("提交后占用释放", r.json.section.occupancy.occupied === false, r.json.section.occupancy);

  // 7. 待确认数量
  r = await req("GET", "/occupancy");
  check("待确认数量=1", r.json.data.pendingReview === 1, r.json.data);
  check("活动占用=0", r.json.data.activeClaimCount === 0, r.json.data);

  // 8. 确认后 checked，待确认归零
  r = await req("POST", `/sections/${SECTION}/review`, { decision: "confirm" });
  check("确认成功", r.status === 200 && r.json.section.checked === true && r.json.section.proofState === "confirmed", r.json);
  r = await req("GET", "/occupancy");
  check("确认后待确认=0", r.json.data.pendingReview === 0, r.json.data);

  // 9. 超时接管：短TTL领取后等过期，新处理人接管
  r = await req("POST", `/sections/${SECTION}/claim`, { holder: "甲", ttlMs: 300 });
  check("甲再次领取(acquired)", r.json.claim.status === "acquired", r.json.claim);
  await sleep(400);
  r = await req("POST", `/sections/${SECTION}/claim`, { holder: "乙" });
  check("乙超时接管(takenOver)", r.status === 200 && r.json.claim.status === "takenOver" && r.json.claim.previousHolder === "甲", r.json.claim);

  // 10. 甲续租/取消被拒，乙取消成功
  r = await req("DELETE", `/sections/${SECTION}/claim`, { holder: "甲" });
  check("甲无法取消已被乙接管的占用", r.status === 409, r.json);
  r = await req("DELETE", `/sections/${SECTION}/claim`, { holder: "乙" });
  check("乙取消占用成功", r.status === 200 && r.json.released === true, r.json);

  // 11. 重启后仍能看到状态：领取一个区间，重启进程，再查询
  r = await req("POST", `/sections/${SECTION}/claim`, { holder: "丙" });
  check("丙领取(准备验证重启)", r.status === 200, r.json);
  server.kill("SIGTERM");
  await sleep(300);
  server = await startServer();
  r = await req("GET", "/occupancy");
  check("重启后活动占用仍在(holder=丙)", r.json.data.activeClaimCount === 1 && r.json.data.activeClaims[0].holder === "丙", r.json);
  r = await req("GET", `/tunes/tune_demo/progress`);
  check("重启后进度含 activeClaims=1", r.json.data.activeClaims === 1 && r.json.data.checkedSections === 2, r.json.data);

  server.kill("SIGTERM");
  fs.rmSync(dbPath, { force: true });
  console.log(`\n${passed} 项通过${process.exitCode ? "，存在失败" : ""}`);
})().catch((error) => {
  console.error("测试异常:", error);
  try { server.kill("SIGTERM"); } catch {}
  fs.rmSync(dbPath, { force: true });
  process.exit(1);
});
