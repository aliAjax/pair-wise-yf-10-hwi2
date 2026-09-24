# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题和修订占用。

## 启动

```bash
PORT=3019 node server.js
```

可选环境变量：

- `PORT`：监听端口，默认 3019
- `DB_FILE`：数据文件路径，默认 `data/db.json`
- `CLAIM_TTL_MINUTES`：占用默认超时时长（分钟），默认 30

## 文件划分

- `server.js`：进程启动入口
- `lib/routes.js`：请求入口（全部路由）
- `lib/occupancy.js`：修订占用（领取、续期、超时接管、提交释放、取消、状态查询）
- `lib/versionCheck.js`：版本冲突判定
- `lib/db.js`：持久化与串行化写事务
- `lib/helpers.js`：公共工具
- `scripts/smoke-test.js`：冒烟测试（`node scripts/smoke-test.js`）

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `GET /tunes/:id/occupancy-status` — 当前处理状态 + 待确认数量
- `POST /sections/:id/claim` — 领取校对区间，登记处理人和版本
- `POST /sections/:id/submit` — 提交试奏结果（需带领取时的版本）
- `POST /sections/:id/release` — 取消占用
- `GET /sections/:id/occupancy` — 查看区间当前占用
- `PATCH /sections/:id/check` — 旧接口（保留兼容，修改会推进版本）
- `GET /occupancies?tuneId=&sectionId=&status=` — 占用记录（含历史）
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 修订占用流程

1. **领取**：`POST /sections/:id/claim`，body `{"handler":"张三","ttlMinutes":30}`。
   登记处理人和区间当前版本；同一区间已有人处理时返回 `409 SECTION_OCCUPIED`，需等待；
   占用超时后他人领取自动接管（响应带 `tookOverFrom`）；同一处理人重复领取视为续期。
2. **提交**：`POST /sections/:id/submit`，body `{"handler":"张三","version":1,"note":"试奏通过","result":"通过"}`。
   版本与区间当前版本不一致时返回 `409 VERSION_CONFLICT`，需重新领取；
   占用超时返回 `409 CLAIM_EXPIRED`；提交成功后释放占用并推进区间版本。
3. **取消**：`POST /sections/:id/release`，body `{"handler":"张三"}`，不提交结果直接退出。
4. **查看**：`GET /tunes/:id/occupancy-status` 返回进行中占用和待确认数量，
   占用记录持久化在 `db.json`，服务重启后状态不丢失。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress

# 领取区间（记下返回的 version）
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/claim \
  -H 'Content-Type: application/json' \
  -d '{"handler":"张三"}'

# 提交试奏结果（带领取时的版本）
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/submit \
  -H 'Content-Type: application/json' \
  -d '{"handler":"张三","version":1,"note":"副歌段试奏通过","result":"通过"}'

# 上报试奏问题
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 查看当前处理状态和待确认数量
curl http://127.0.0.1:3019/tunes/tune_demo/occupancy-status
```
