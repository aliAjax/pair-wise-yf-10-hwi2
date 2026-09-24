// 区间版本管理：每次区间内容变更都让版本号 +1，
// 处理人领取时拿到当前版本，提交试奏结果时必须带回该版本，
// 版本落后说明区间已被别人改过，判定为冲突并拒绝提交。

function ensureVersion(section) {
  if (typeof section.version !== "number") section.version = 0;
  return section.version;
}

function currentVersion(section) {
  return ensureVersion(section);
}

function bumpVersion(section) {
  ensureVersion(section);
  section.version += 1;
  return section.version;
}

// expectedVersion 为领取时拿到的版本；不传或非法一律视为过期，
// 强制处理人重新领取，避免无版本信息的提交覆盖他人结果。
function checkVersion(section, expectedVersion) {
  const current = ensureVersion(section);
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected !== current) {
    return {
      stale: true,
      current,
      expected: Number.isInteger(expected) ? expected : null
    };
  }
  return { stale: false, current, expected };
}

module.exports = { ensureVersion, currentVersion, bumpVersion, checkVersion };
