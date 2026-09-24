const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

const nowIso = () => new Date().toISOString();

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: nowIso()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏",
      version: 3,
      proofState: "confirmed",
      trialResult: { note: "开头主题已试奏", submittedBy: "初始化", submittedAt: nowIso() },
      confirmedAt: nowIso()
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对",
      version: 0,
      proofState: "pending",
      trialResult: null,
      claimedBy: null,
      confirmedAt: null
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: nowIso(),
      resolvedAt: null
    }
  ],
  locks: []
};

// 给历史数据补齐版本与占用相关字段
function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.locks)) {
    db.locks = [];
    changed = true;
  }
  for (const section of db.sections || []) {
    if (typeof section.version !== "number") {
      section.version = section.checked ? 1 : 0;
      changed = true;
    }
    if (!section.proofState) {
      section.proofState = section.checked ? "confirmed" : "pending";
      changed = true;
    }
    if (section.trialResult === undefined) {
      section.trialResult = section.checked ? { note: section.note || "", submittedBy: null, submittedAt: null } : null;
      changed = true;
    }
    if (section.claimedBy === undefined) {
      section.claimedBy = null;
      changed = true;
    }
    if (section.confirmedAt === undefined) section.confirmedAt = null;
  }
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let needInit = false;
  let db = null;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    needInit = true;
    db = JSON.parse(JSON.stringify(initialData));
  }
  if (migrate(db) || needInit) {
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

module.exports = { readDb, writeDb, ensureDb, DB_FILE };
