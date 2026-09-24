const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

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
      createdAt: new Date().toISOString()
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
      version: 1
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对",
      version: 1
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
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  occupancies: []
};

// 兼容旧数据：补齐区间版本号和占用表
function normalizeDb(data) {
  data.tunes = Array.isArray(data.tunes) ? data.tunes : [];
  data.sections = Array.isArray(data.sections) ? data.sections : [];
  data.issues = Array.isArray(data.issues) ? data.issues : [];
  data.occupancies = Array.isArray(data.occupancies) ? data.occupancies : [];
  for (const section of data.sections) {
    if (!Number.isInteger(section.version) || section.version < 1) {
      section.version = 1;
    }
  }
  return data;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(normalizeDb(data), null, 2));
}

// 串行化"读-改-写"，避免两个请求同时读到旧状态导致占用被并发领取
let queue = Promise.resolve();

function updateDb(mutator) {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { readDb, writeDb, updateDb };
