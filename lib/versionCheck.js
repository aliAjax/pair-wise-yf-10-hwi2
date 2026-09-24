const { httpError } = require("./helpers");

// 版本冲突判定：提交携带的版本号必须与区间当前版本一致
function isVersionConflict(section, expectedVersion) {
  return Number(expectedVersion) !== section.version;
}

function assertSectionVersion(section, expectedVersion) {
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw httpError(400, "version 必须是领取时登记的正整数版本号", { code: "VERSION_INVALID" });
  }
  if (isVersionConflict(section, version)) {
    throw httpError(
      409,
      `版本已过期（当前版本 v${section.version}），区间可能已被他人更新，请重新领取校对任务后再提交`,
      { code: "VERSION_CONFLICT", currentVersion: section.version }
    );
  }
}

module.exports = { isVersionConflict, assertSectionVersion };
