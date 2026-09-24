# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题和校对占用。

## 启动

```bash
PORT=3019 node server.js
```

占用超时默认 10 分钟，可用环境变量调整：`OCCUPANCY_TTL_MS=600000 node server.js`。

## 校对占用流程（防止试奏结果互相覆盖）

1. **领取区间**：`POST /sections/:id/claim`，登记处理人和区间当前版本，返回 `baseVersion` 与占用到期时间。同一区间已有人处理时返回 `409 SECTION_OCCUPIED`，请等待后重试。
2. **提交试奏结果**：`POST /sections/:id/trial`，必须带回领取时的版本 `version`。区间在领取后被更新过则返回 `409 VERSION_STALE`，拒绝写入并提示重新领取。
3. 提交成功后占用自动释放；**取消**用 `DELETE /sections/:id/claim` 退出。
4. 占用超时后，新的处理人再次领取会自动**接管**（响应 `claim.status = takenOver`）。
5. 试奏结果提交后进入待确认状态，由 `POST /sections/:id/review`（`decision: confirm|reject`）确认或驳回。

## 主要接口

- `GET /health`
- `GET /tunes` / `POST /tunes`
- `GET /tunes/:id/progress`（含 `pendingReview` 待确认数量、`activeClaims` 处理中数量）
- `GET /tunes/:id/sections`（每个区间附带 `occupancy` 当前处理状态）
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `POST /sections/:id/claim` — 开始校对，登记处理人与版本
- `DELETE /sections/:id/claim` — 取消占用
- `POST /sections/:id/trial` — 提交试奏结果（带版本，过期拒绝）
- `POST /sections/:id/review` — 确认 / 驳回试奏结果
- `PATCH /sections/:id/check` — 旧式直接校对（保留，变更同样推进版本号）
- `GET /occupancy?tuneId=` — 当前活动占用与待确认数量（服务重启后仍可查看）
- `GET /issues?tuneId=&status=` / `POST /issues` / `PATCH /issues/:id/status`

## 闭环示例

```bash
# 甲领取副歌区间（记下返回的 baseVersion）
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/claim \
  -H 'Content-Type: application/json' -d '{"holder":"甲"}'

# 乙同时领取会被拒绝（409 SECTION_OCCUPIED）
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/claim \
  -H 'Content-Type: application/json' -d '{"holder":"乙"}'

# 甲带版本提交试奏结果，成功后释放占用
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/trial \
  -H 'Content-Type: application/json' \
  -d '{"holder":"甲","version":0,"note":"副歌已试奏，第41拍漏孔"}'

# 查看当前处理状态与待确认数量
curl http://127.0.0.1:3019/occupancy

# 确认试奏结果
curl -X POST http://127.0.0.1:3019/sections/section_demo_2/review \
  -H 'Content-Type: application/json' -d '{"decision":"confirm"}'
```

## 代码结构

- `server.js`：请求入口（路由、参数、响应）
- `lib/occupancy.js`：占用登记、等待冲突、取消、超时接管
- `lib/versioning.js`：区间版本号与提交时的版本过期判定
- `lib/proofreading.js`：校对业务编排（领取/提交/确认/进度）
- `lib/store.js`：JSON 持久化与历史数据迁移
