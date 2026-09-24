const { httpError } = require("./errors");
const occupancy = require("./occupancy");
const { currentVersion, bumpVersion, checkVersion } = require("./versioning");

const nowIso = () => new Date().toISOString();

function findSection(db, sectionId) {
  const section = db.sections.find((item) => item.id === sectionId);
  if (!section) throw httpError(404, "区间不存在", "SECTION_NOT_FOUND", { sectionId });
  return section;
}

// 给区间附上实时占用快照，供列表/详情接口展示「当前由谁处理」
function decorateSection(db, section, now = Date.now()) {
  return { ...section, occupancy: occupancy.describeLock(db, section.id, now) };
}

// 开始校对：登记处理人与领取时的区间版本；同区间有人处理则由 occupancy 拒绝
function claimSection(db, sectionId, holder, options = {}) {
  const section = findSection(db, sectionId);
  const ttlMs = options.ttlMs;
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw httpError(400, "ttlMs 必须是正数毫秒值", "INVALID_TTL", { ttlMs: options.ttlMs });
  }
  const { status, lock, previousHolder } = occupancy.claim(
    db,
    sectionId,
    holder,
    currentVersion(section),
    ttlMs,
    options.now
  );
  section.claimedBy = holder;
  return {
    section: decorateSection(db, section, options.now),
    claim: {
      status,
      holder,
      sectionId,
      baseVersion: lock.baseVersion,
      claimedAt: lock.claimedAt,
      expiresAt: lock.expiresAt,
      previousHolder
    }
  };
}

// 提交试奏结果：必须带回领取时的版本；版本过期则拒绝并提示重新领取
function submitTrial(db, sectionId, holder, expectedVersion, body, options = {}) {
  const section = findSection(db, sectionId);
  occupancy.requireActiveHolder(db, sectionId, holder, options.now);

  const versionCheck = checkVersion(section, expectedVersion);
  if (versionCheck.stale) {
    // 占用随失败提交一起释放，处理人需要重新领取再提交
    occupancy.release(db, sectionId);
    section.claimedBy = null;
    throw httpError(409, "区间在你领取后已被更新，试奏结果已拒绝提交，请重新领取后再试", "VERSION_STALE", {
      sectionId,
      expectedVersion: versionCheck.expected,
      currentVersion: versionCheck.current
    });
  }

  section.trialResult = {
    note: body.note ?? "",
    issuesFound: Array.isArray(body.issuesFound) ? body.issuesFound : [],
    submittedBy: holder,
    submittedAt: nowIso()
  };
  section.note = body.note ?? section.note;
  section.proofState = "submitted";
  section.checked = false;
  section.confirmedAt = null;
  section.claimedBy = null;
  bumpVersion(section);
  occupancy.release(db, sectionId);
  return { section: decorateSection(db, section, options.now), submitted: true };
}

// 主动退出占用
function cancelClaim(db, sectionId, holder, options = {}) {
  findSection(db, sectionId);
  const result = occupancy.cancel(db, sectionId, holder, options.now);
  if (result.released) {
    const section = db.sections.find((item) => item.id === sectionId);
    if (section && section.claimedBy === holder) section.claimedBy = null;
  }
  return { sectionId, ...result };
}

// 确认/驳回待确认的试奏结果
function reviewTrial(db, sectionId, decision, note, options = {}) {
  const section = findSection(db, sectionId);
  if (section.proofState !== "submitted") {
    throw httpError(409, "该区间没有待确认的试奏结果", "NO_PENDING_TRIAL", {
      sectionId,
      proofState: section.proofState
    });
  }
  if (decision === "confirm") {
    section.proofState = "confirmed";
    section.checked = true;
    section.confirmedAt = nowIso();
  } else if (decision === "reject") {
    section.proofState = "pending";
    section.checked = false;
    section.confirmedAt = null;
    section.trialResult = null;
  } else {
    throw httpError(400, "decision 只支持 confirm 或 reject", "INVALID_DECISION", { decision });
  }
  if (note !== undefined) section.note = note;
  bumpVersion(section);
  return { section: decorateSection(db, section, options.now) };
}

function buildProgress(db, tuneId, now = Date.now()) {
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  const pendingReview = sections.filter((item) => item.proofState === "submitted").length;
  const activeClaims = sections.filter((item) => occupancy.getActiveLock(db, item.id, now)).length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    pendingReview,
    activeClaims,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

module.exports = {
  findSection,
  decorateSection,
  claimSection,
  submitTrial,
  cancelClaim,
  reviewTrial,
  buildProgress
};
