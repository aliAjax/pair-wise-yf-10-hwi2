const { httpError } = require("./errors");

// 占用相关：登记处理人与领取版本，同一区间只允许一位处理人进入；
// 占用带超时，超时后新的处理人可以接管。占用记录随 db 一起落盘，
// 服务重启后仍能看到当前处理状态。
const DEFAULT_TTL_MS = Number(process.env.OCCUPANCY_TTL_MS) || 10 * 60 * 1000;

function findLock(db, sectionId) {
  return db.locks.find((item) => item.sectionId === sectionId);
}

function getActiveLock(db, sectionId, now = Date.now()) {
  const lock = findLock(db, sectionId);
  if (!lock) return null;
  return new Date(lock.expiresAt).getTime() > now ? lock : null;
}

function describeLock(db, sectionId, now = Date.now()) {
  const lock = findLock(db, sectionId);
  if (!lock) {
    return { sectionId, occupied: false, expired: false, holder: null, claimedAt: null, expiresAt: null, remainingMs: 0, baseVersion: null };
  }
  const remainingMs = new Date(lock.expiresAt).getTime() - now;
  const expired = remainingMs <= 0;
  return {
    sectionId,
    occupied: !expired,
    expired,
    holder: lock.holder,
    claimedAt: lock.claimedAt,
    expiresAt: lock.expiresAt,
    remainingMs: Math.max(remainingMs, 0),
    baseVersion: lock.baseVersion,
    renewedCount: lock.renewedCount
  };
}

function listActive(db, now = Date.now()) {
  return db.locks.filter((lock) => new Date(lock.expiresAt).getTime() > now);
}

// 领取 / 续租 / 超时接管。baseVersion 为领取时的区间版本。
// 返回 status: acquired 新领取 | renewed 本人续租 | takenOver 超时接管他人占用
function claim(db, sectionId, holder, baseVersion, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  const existing = findLock(db, sectionId);
  const active = existing && new Date(existing.expiresAt).getTime() > now ? existing : null;

  if (active && active.holder !== holder) {
    throw httpError(409, `区间正由「${active.holder}」校对中，请先等待或稍后重试`, "SECTION_OCCUPIED", {
      sectionId,
      holder: active.holder,
      claimedAt: active.claimedAt,
      expiresAt: active.expiresAt,
      retryAfterMs: Math.max(new Date(active.expiresAt).getTime() - now, 0)
    });
  }

  let status;
  let previousHolder = null;
  if (!existing) {
    status = "acquired";
  } else if (existing.holder === holder) {
    status = "renewed";
  } else {
    status = "takenOver";
    previousHolder = existing.holder;
  }

  const lock = {
    sectionId,
    holder,
    // 续租保留首次领取时间
    claimedAt: active ? existing.claimedAt : new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    // 每次领取（含续租/接管）都以区间当前版本为基准，
    // 这样冲突后重新领取即可拿到新版本重新提交
    baseVersion,
    renewedCount: status === "acquired" ? 0 : (existing.renewedCount || 0) + 1
  };

  if (existing) db.locks.splice(db.locks.indexOf(existing), 1, lock);
  else db.locks.push(lock);
  return { lock, status, previousHolder };
}

// 提交、取消前核验当前处理人身份；非本人持锁一律拒绝。
function requireActiveHolder(db, sectionId, holder, now = Date.now()) {
  const lock = getActiveLock(db, sectionId, now);
  if (!lock) {
    throw httpError(409, "该区间当前未被你占用，请重新领取后再操作", "SECTION_NOT_CLAIMED", { sectionId });
  }
  if (lock.holder !== holder) {
    throw httpError(409, `占用者为「${lock.holder}」，与请求处理人不一致`, "OCCUPANCY_HOLDER_MISMATCH", {
      sectionId,
      holder: lock.holder
    });
  }
  return lock;
}

function release(db, sectionId) {
  const index = db.locks.findIndex((item) => item.sectionId === sectionId);
  if (index >= 0) db.locks.splice(index, 1);
}

// 主动退出：本人持锁可释放；本人占用已超时（尚未被他人接管）也可退出；
// 已被他人接管则拒绝。
function cancel(db, sectionId, holder, now = Date.now()) {
  const existing = findLock(db, sectionId);
  if (!existing) return { released: false, status: "none" };
  if (existing.holder !== holder) {
    throw httpError(409, `占用者为「${existing.holder}」，你不能取消他人的占用`, "OCCUPANCY_HOLDER_MISMATCH", {
      sectionId,
      holder: existing.holder
    });
  }
  release(db, sectionId);
  return { released: true, status: "cancelled" };
}

module.exports = {
  DEFAULT_TTL_MS,
  findLock,
  getActiveLock,
  describeLock,
  listActive,
  claim,
  requireActiveHolder,
  release,
  cancel
};
