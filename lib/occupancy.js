const { httpError, makeId } = require("./helpers");
const { assertSectionVersion } = require("./versionCheck");

const DEFAULT_TTL_MINUTES = Number(process.env.CLAIM_TTL_MINUTES || 30);
const MIN_TTL_MINUTES = 0.01;
const MAX_TTL_MINUTES = 240;

function clampTtl(ttlMinutes) {
  const value = Number(ttlMinutes);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(Math.max(value, MIN_TTL_MINUTES), MAX_TTL_MINUTES);
}

function isExpired(occupancy, now = Date.now()) {
  return occupancy.status === "active" && Date.parse(occupancy.expiresAt) <= now;
}

function effectiveStatus(occupancy, now = Date.now()) {
  return isExpired(occupancy, now) ? "expired" : occupancy.status;
}

function findActiveOccupancy(db, sectionId) {
  return db.occupancies.find((item) => item.sectionId === sectionId && item.status === "active") || null;
}

function toOccupancyView(occupancy, now = Date.now()) {
  const status = effectiveStatus(occupancy, now);
  return {
    id: occupancy.id,
    tuneId: occupancy.tuneId,
    sectionId: occupancy.sectionId,
    handler: occupancy.handler,
    version: occupancy.version,
    status,
    claimedAt: occupancy.claimedAt,
    expiresAt: occupancy.expiresAt,
    closedAt: occupancy.closedAt,
    remainingSeconds: status === "active" ? Math.max(0, Math.round((Date.parse(occupancy.expiresAt) - now) / 1000)) : 0
  };
}

// 领取校对区间：登记处理人和开始时的版本
function claimSection(db, section, { handler, ttlMinutes }) {
  const now = Date.now();
  const ttl = clampTtl(ttlMinutes);
  const existing = findActiveOccupancy(db, section.id);

  if (existing && !isExpired(existing, now)) {
    if (existing.handler === handler) {
      // 同一处理人重复领取视为续期，版本不变
      existing.expiresAt = new Date(now + ttl * 60000).toISOString();
      return { occupancy: toOccupancyView(existing, now), tookOverFrom: null, renewed: true };
    }
    throw httpError(409, `区间正由 ${existing.handler} 校对中，请等待其提交、取消或占用超时后再领取`, {
      code: "SECTION_OCCUPIED",
      occupancy: toOccupancyView(existing, now)
    });
  }

  let tookOverFrom = null;
  if (existing) {
    // 占用已超时，由新处理人接管
    existing.status = "expired";
    existing.closedAt = new Date(now).toISOString();
    tookOverFrom = existing.handler;
  }

  const occupancy = {
    id: makeId("occ"),
    tuneId: section.tuneId,
    sectionId: section.id,
    handler,
    version: section.version,
    status: "active",
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 60000).toISOString(),
    closedAt: null
  };
  db.occupancies.push(occupancy);
  return { occupancy: toOccupancyView(occupancy, now), tookOverFrom, renewed: false };
}

// 提交/取消前校验：必须持有未超时的占用
function requireActiveClaim(db, section, handler, action) {
  const now = Date.now();
  const occupancy = findActiveOccupancy(db, section.id);
  if (!occupancy) {
    throw httpError(409, `区间当前无人占用，无法${action}，请先领取校对任务`, { code: "NOT_CLAIMED" });
  }
  if (isExpired(occupancy, now)) {
    occupancy.status = "expired";
    occupancy.closedAt = new Date(now).toISOString();
    throw httpError(409, `占用已超时，无法${action}，请重新领取校对任务`, { code: "CLAIM_EXPIRED" });
  }
  if (occupancy.handler !== handler) {
    throw httpError(409, `区间正由 ${occupancy.handler} 处理，无法${action}他人的占用`, {
      code: "HANDLER_MISMATCH",
      occupancy: toOccupancyView(occupancy, now)
    });
  }
  return occupancy;
}

// 提交试奏结果：校验占用 + 版本，成功后释放占用并推进区间版本
function submitTrialResult(db, section, { handler, version, note, checked, result }) {
  const occupancy = requireActiveClaim(db, section, handler, "提交");
  assertSectionVersion(section, version);

  section.checked = checked === undefined ? true : Boolean(checked);
  if (note !== undefined) section.note = note;
  section.version += 1;
  section.lastTrial = {
    handler,
    result: result === undefined ? null : result,
    submittedAt: new Date().toISOString()
  };

  occupancy.status = "released";
  occupancy.closedAt = new Date().toISOString();
  return { section, occupancy: toOccupancyView(occupancy) };
}

// 取消占用：不提交结果，直接退出
function cancelClaim(db, section, handler) {
  const occupancy = requireActiveClaim(db, section, handler, "取消");
  occupancy.status = "cancelled";
  occupancy.closedAt = new Date().toISOString();
  return toOccupancyView(occupancy);
}

function getSectionOccupancy(db, sectionId) {
  const occupancy = findActiveOccupancy(db, sectionId);
  return occupancy ? toOccupancyView(occupancy) : null;
}

// 曲目当前处理状态 + 待确认数量（未校对确认的区间数）
function tuneOccupancyStatus(db, tuneId) {
  const now = Date.now();
  const occupancies = db.occupancies
    .filter((item) => item.tuneId === tuneId && item.status === "active")
    .map((item) => toOccupancyView(item, now));
  const pendingConfirmations = db.sections.filter((item) => item.tuneId === tuneId && !item.checked).length;
  return { tuneId, occupancies, pendingConfirmations };
}

function countProcessing(db, tuneId) {
  const now = Date.now();
  return db.occupancies.filter((item) => item.tuneId === tuneId && !isExpired(item, now) && item.status === "active").length;
}

function listOccupancies(db, { tuneId, sectionId, status } = {}) {
  const now = Date.now();
  return db.occupancies
    .map((item) => toOccupancyView(item, now))
    .filter((item) => (!tuneId || item.tuneId === tuneId))
    .filter((item) => (!sectionId || item.sectionId === sectionId))
    .filter((item) => (!status || item.status === status))
    .sort((a, b) => (a.claimedAt < b.claimedAt ? 1 : -1));
}

module.exports = {
  claimSection,
  submitTrialResult,
  cancelClaim,
  getSectionOccupancy,
  tuneOccupancyStatus,
  countProcessing,
  listOccupancies
};
