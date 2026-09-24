// 冒烟测试：占用领取/冲突/版本判定/超时接管/取消/重启后状态
// 运行：node scripts/smoke-test.js
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `occupancy-smoke-${process.pid}.json`);

let server = null;
let failures = 0;

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function check(cond, label, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: ["ignore", "ignore", "inherit"]
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          clearInterval(timer);
          resolve();
        }
      } catch {
        if (attempts > 50) {
          clearInterval(timer);
          reject(new Error("服务启动超时"));
        }
      }
    }, 100);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    server.kill();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(DB_FILE, { force: true });
  await startServer();

  console.log("1. 领取与冲突");
  let r = await api("POST", "/sections/section_demo_2/claim", { handler: "张三" });
  check(r.status === 201 && r.body.data.handler === "张三" && r.body.data.version === 1, "张三领取成功，登记版本 v1", r.body);
  check(r.body.tookOverFrom === null, "无接管", r.body);

  r = await api("POST", "/sections/section_demo_2/claim", { handler: "李四" });
  check(r.status === 409 && r.body.code === "SECTION_OCCUPIED", "李四领取被拒：区间有人处理", r.body);

  r = await api("POST", "/sections/section_demo_2/claim", { handler: "张三" });
  check(r.status === 201 && r.body.renewed === true, "张三重复领取视为续期", r.body);

  console.log("2. 提交试奏结果与版本判定");
  r = await api("POST", "/sections/section_demo_2/submit", { handler: "张三", note: "缺版本" });
  check(r.status === 400, "缺少 version 被拒", r.body);

  r = await api("POST", "/sections/section_demo_2/submit", { handler: "张三", version: 99 });
  check(r.status === 409 && r.body.code === "VERSION_CONFLICT" && r.body.currentVersion === 1, "版本过期被拒并提醒重新领取", r.body);

  r = await api("POST", "/sections/section_demo_2/submit", { handler: "李四", version: 1 });
  check(r.status === 409 && r.body.code === "HANDLER_MISMATCH", "非占有人提交被拒", r.body);

  r = await api("POST", "/sections/section_demo_2/submit", { handler: "张三", version: 1, note: "副歌段试奏通过", result: "通过" });
  check(r.status === 200 && r.body.data.section.checked === true && r.body.data.section.version === 2, "提交成功，版本推进到 v2", r.body);
  check(r.body.data.occupancy.status === "released", "提交后占用已释放", r.body);

  r = await api("GET", "/sections/section_demo_2/occupancy");
  check(r.body.data === null, "释放后区间无占用", r.body);

  console.log("3. 旧接口修改后版本过期");
  r = await api("POST", "/sections/section_demo_2/claim", { handler: "张三" });
  check(r.status === 201 && r.body.data.version === 2, "张三重新领取，登记版本 v2", r.body);
  r = await api("PATCH", "/sections/section_demo_2/check", { note: "旧接口改动" });
  check(r.status === 200 && r.body.data.version === 3, "旧 check 接口推进版本到 v3", r.body);
  r = await api("POST", "/sections/section_demo_2/submit", { handler: "张三", version: 2 });
  check(r.status === 409 && r.body.code === "VERSION_CONFLICT", "旧版本提交被拒", r.body);
  r = await api("POST", "/sections/section_demo_2/release", { handler: "张三" });
  check(r.status === 200 && r.body.data.status === "cancelled", "取消占用退出", r.body);
  r = await api("POST", "/sections/section_demo_2/submit", { handler: "张三", version: 3 });
  check(r.status === 409 && r.body.code === "NOT_CLAIMED", "取消后再提交被拒", r.body);

  console.log("4. 超时接管");
  r = await api("POST", "/sections/section_demo_2/claim", { handler: "王五", ttlMinutes: 0.02 });
  check(r.status === 201, "王五领取（短超时）", r.body);
  await sleep(1500);
  r = await api("POST", "/sections/section_demo_2/claim", { handler: "赵六" });
  check(r.status === 201 && r.body.tookOverFrom === "王五", "超时后赵六接管", r.body);
  r = await api("POST", "/sections/section_demo_2/submit", { handler: "王五", version: 3 });
  check(r.status === 409 && r.body.code === "HANDLER_MISMATCH", "王五超时后提交被拒", r.body);
  r = await api("GET", "/occupancies?sectionId=section_demo_2&status=expired");
  check(r.body.data.some((item) => item.handler === "王五"), "王五的占用记录已标记超时", r.body);

  console.log("5. 重启后查看处理状态和待确认数量");
  r = await api("POST", "/tunes/tune_demo/sections", { startBeat: 65, endBeat: 96, laneRange: "1-10" });
  check(r.status === 201 && r.body.data.version === 1, "新建区间自带版本 v1", r.body);
  await stopServer();
  await startServer();
  r = await api("GET", "/tunes/tune_demo/occupancy-status");
  const active = (r.body.data.occupancies || []).filter((item) => item.status === "active");
  check(active.length === 1 && active[0].handler === "赵六", "重启后仍能看到赵六正在处理", r.body);
  check(r.body.data.pendingConfirmations === 1, "重启后待确认数量正确（1 个未确认区间）", r.body);

  r = await api("POST", "/sections/section_demo_2/release", { handler: "赵六" });
  check(r.status === 200 && r.body.data.status === "cancelled", "赵六取消占用", r.body);
  r = await api("GET", "/tunes/tune_demo/occupancy-status");
  check(r.body.data.occupancies.length === 0, "取消后无进行中占用", r.body);

  await stopServer();
  fs.rmSync(DB_FILE, { force: true });

  if (failures) {
    console.error(`\n${failures} 项未通过`);
    process.exit(1);
  }
  console.log("\n全部通过");
}

main().catch(async (error) => {
  console.error(error);
  await stopServer();
  fs.rmSync(DB_FILE, { force: true });
  process.exit(1);
});
