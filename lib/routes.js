const { readDb, updateDb } = require("./db");
const { send, parseUrl, parseBody, makeId, required, findTune, findSection } = require("./helpers");
const occupancy = require("./occupancy");

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/occupancy-status",
  "POST /sections/:id/claim",
  "POST /sections/:id/submit",
  "POST /sections/:id/release",
  "GET /sections/:id/occupancy",
  "PATCH /sections/:id/check",
  "GET /occupancies",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status"
];

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    processingSections: occupancy.countProcessing(db, tuneId),
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const db = await readDb();
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = await updateDb((db) => {
      const created = {
        id: makeId("tune"),
        title: body.title,
        composer: body.composer || "",
        stripSpec: body.stripSpec,
        createdAt: new Date().toISOString()
      };
      db.tunes.push(created);
      return created;
    });
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const db = await readDb();
    findTune(db, tuneSectionsMatch[1]);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneSectionsMatch[1]) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = await updateDb((db) => {
      findTune(db, tuneSectionsMatch[1]);
      const created = {
        id: makeId("section"),
        tuneId: tuneSectionsMatch[1],
        startBeat: Number(body.startBeat),
        endBeat: Number(body.endBeat),
        laneRange: body.laneRange,
        checked: Boolean(body.checked),
        note: body.note || "",
        version: 1
      };
      db.sections.push(created);
      return created;
    });
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const db = await readDb();
    findTune(db, uncheckedMatch[1]);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === uncheckedMatch[1] && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    const db = await readDb();
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  // 当前处理状态 + 待确认数量（占用记录持久化在 db.json，重启后仍可查）
  const occupancyStatusMatch = pathname.match(/^\/tunes\/([^/]+)\/occupancy-status$/);
  if (occupancyStatusMatch && req.method === "GET") {
    const db = await readDb();
    findTune(db, occupancyStatusMatch[1]);
    return send(res, 200, { data: occupancy.tuneOccupancyStatus(db, occupancyStatusMatch[1]) });
  }

  // 领取校对区间：登记处理人和开始时的版本
  const claimMatch = pathname.match(/^\/sections\/([^/]+)\/claim$/);
  if (claimMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["handler"]);
    const result = await updateDb((db) =>
      occupancy.claimSection(db, findSection(db, claimMatch[1]), {
        handler: String(body.handler),
        ttlMinutes: body.ttlMinutes
      })
    );
    return send(res, 201, { data: result.occupancy, tookOverFrom: result.tookOverFrom, renewed: result.renewed });
  }

  // 提交试奏结果：必须携带领取时的版本，版本过期拒绝并提醒重新领取
  const submitMatch = pathname.match(/^\/sections\/([^/]+)\/submit$/);
  if (submitMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["handler", "version"]);
    const result = await updateDb((db) =>
      occupancy.submitTrialResult(db, findSection(db, submitMatch[1]), {
        handler: String(body.handler),
        version: body.version,
        note: body.note,
        checked: body.checked,
        result: body.result
      })
    );
    return send(res, 200, { data: result });
  }

  // 取消占用：不提交结果，直接退出
  const releaseMatch = pathname.match(/^\/sections\/([^/]+)\/release$/);
  if (releaseMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["handler"]);
    const view = await updateDb((db) => occupancy.cancelClaim(db, findSection(db, releaseMatch[1]), String(body.handler)));
    return send(res, 200, { data: view });
  }

  const sectionOccupancyMatch = pathname.match(/^\/sections\/([^/]+)\/occupancy$/);
  if (sectionOccupancyMatch && req.method === "GET") {
    const db = await readDb();
    const section = findSection(db, sectionOccupancyMatch[1]);
    return send(res, 200, { data: occupancy.getSectionOccupancy(db, section.id) });
  }

  // 旧接口保留兼容；任何修改都会推进版本，使进行中的占用能检出过期
  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const section = await updateDb((db) => {
      const target = findSection(db, checkMatch[1]);
      target.checked = body.checked !== undefined ? Boolean(body.checked) : true;
      target.note = body.note ?? target.note;
      target.version += 1;
      return target;
    });
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/occupancies") {
    const db = await readDb();
    return send(res, 200, {
      data: occupancy.listOccupancies(db, {
        tuneId: searchParams.get("tuneId"),
        sectionId: searchParams.get("sectionId"),
        status: searchParams.get("status")
      })
    });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const db = await readDb();
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    const issue = await updateDb((db) => {
      findTune(db, body.tuneId);
      const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
      if (!section) throw Object.assign(new Error("区间不存在或不属于该曲目"), { status: 400 });
      const created = {
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
      db.issues.push(created);
      return created;
    });
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    required(body, ["status"]);
    const issue = await updateDb((db) => {
      const target = db.issues.find((item) => item.id === issueStatusMatch[1]);
      if (!target) throw Object.assign(new Error("问题不存在"), { status: 404 });
      target.status = body.status;
      target.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
      target.note = body.note ?? target.note;
      return target;
    });
    return send(res, 200, { data: issue });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle };
