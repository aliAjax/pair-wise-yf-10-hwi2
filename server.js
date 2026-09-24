const http = require("http");
const { readFile, writeFile } = require("fs/promises");
const { readDb, writeDb } = require("./lib/store");
const { httpError } = require("./lib/errors");
const occupancy = require("./lib/occupancy");
const { bumpVersion } = require("./lib/versioning");
const proofreading = require("./lib/proofreading");

const PORT = Number(process.env.PORT || 3019);

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "POST /sections/:id/claim",
  "DELETE /sections/:id/claim",
  "POST /sections/:id/trial",
  "POST /sections/:id/review",
  "GET /occupancy",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON", "INVALID_JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`, "MISSING_FIELDS", { missing });
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw httpError(404, "曲目不存在", "TUNE_NOT_FOUND", { tuneId });
  return tune;
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();
  const now = Date.now();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: proofreading.buildProgress(db, tune.id, now) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const sections = db.sections
      .filter((item) => item.tuneId === tuneId)
      .map((section) => proofreading.decorateSection(db, section, now));
    return send(res, 200, { data: sections });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || "",
      version: 0,
      proofState: "pending",
      trialResult: null,
      claimedBy: null,
      confirmedAt: null
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: proofreading.decorateSection(db, section, now) });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    const sections = db.sections
      .filter((item) => item.tuneId === tuneId && !item.checked)
      .map((section) => proofreading.decorateSection(db, section, now));
    return send(res, 200, { data: sections });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    findTune(db, progressMatch[1]);
    return send(res, 200, { data: proofreading.buildProgress(db, progressMatch[1], now) });
  }

  // —— 校对占用 / 试奏流程 ——

  const claimMatch = pathname.match(/^\/sections\/([^/]+)\/claim$/);
  if (claimMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["holder"]);
    const result = proofreading.claimSection(db, claimMatch[1], String(body.holder), {
      ttlMs: body.ttlMs === undefined ? undefined : Number(body.ttlMs),
      now
    });
    await writeDb(db);
    return send(res, 200, { message: "占用登记成功", ...result });
  }

  if (claimMatch && req.method === "DELETE") {
    const body = await parseBody(req);
    required(body, ["holder"]);
    const result = proofreading.cancelClaim(db, claimMatch[1], String(body.holder), { now });
    await writeDb(db);
    return send(res, 200, { message: "已退出占用", ...result });
  }

  const trialMatch = pathname.match(/^\/sections\/([^/]+)\/trial$/);
  if (trialMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["holder", "version"]);
    const result = proofreading.submitTrial(db, trialMatch[1], String(body.holder), body.version, body, { now });
    await writeDb(db);
    return send(res, 200, { message: "试奏结果已提交，等待确认", ...result });
  }

  const reviewMatch = pathname.match(/^\/sections\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["decision"]);
    const result = proofreading.reviewTrial(db, reviewMatch[1], body.decision, body.note, { now });
    await writeDb(db);
    return send(res, 200, { message: body.decision === "confirm" ? "试奏结果已确认" : "试奏结果已驳回", ...result });
  }

  // 当前处理状态：活动占用 + 待确认数量；重启后仍可查询
  if (req.method === "GET" && pathname === "/occupancy") {
    const tuneId = searchParams.get("tuneId");
    const activeLocks = occupancy.listActive(db, now).map((lock) => {
      const section = db.sections.find((item) => item.id === lock.sectionId);
      return { ...occupancy.describeLock(db, lock.sectionId, now), tuneId: section ? section.tuneId : null };
    });
    const sections = db.sections.filter((item) => !tuneId || item.tuneId === tuneId);
    const lockSections = activeLocks.filter((lock) => !tuneId || lock.tuneId === tuneId);
    return send(res, 200, {
      data: {
        activeClaims: lockSections,
        activeClaimCount: lockSections.length,
        pendingReview: sections.filter((item) => item.proofState === "submitted").length
      }
    });
  }

  // 旧的直接校对接口：保留，变更时同样推进版本号，避免绕过占用导致版本不一致
  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    section.proofState = section.checked ? "confirmed" : "pending";
    section.confirmedAt = section.checked ? new Date().toISOString() : null;
    bumpVersion(section);
    await writeDb(db);
    return send(res, 200, { data: proofreading.decorateSection(db, section, now) });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

// 请求串行化：占用领取是“读-判断-写”流程，并发请求交错会互相覆盖占用，
// 这里用链队列保证每个请求原子完成读改写。
let queueTail = Promise.resolve();

const server = http.createServer((req, res) => {
  queueTail = queueTail
    .catch(() => {})
    .then(() => handle(req, res))
    .catch((error) => {
      const status = error.status || 500;
      send(res, status, {
        error: error.message || "服务器错误",
        code: error.code || "INTERNAL_ERROR",
        ...(error.details ? { details: error.details } : {})
      });
    });
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
