function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra || {};
  return error;
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    throw httpError(400, `缺少字段：${missing.join(", ")}`);
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw httpError(404, "曲目不存在");
  return tune;
}

function findSection(db, sectionId) {
  const section = db.sections.find((item) => item.id === sectionId);
  if (!section) throw httpError(404, "区间不存在");
  return section;
}

function sendError(res, error) {
  send(res, error.status || 500, { error: error.message || "服务器错误", ...(error.extra || {}) });
}

module.exports = {
  send,
  sendError,
  parseUrl,
  parseBody,
  makeId,
  required,
  httpError,
  findTune,
  findSection
};
