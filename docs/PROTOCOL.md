# 游戏协议备忘（Arcane Reelax / reelax.cn）

> 本文档记录辅助控制台所依赖的游戏通信协议，全部通过抓包与实测（2026-09）验证。
> 游戏版本迭代后如辅助失效，可按此文档对照排查。**仅供个人学习研究。**

## 1. 基础

- 生产服 `https://reelax.cn`，静态资源 `https://static.reelax.cn`
- 全部业务接口为 REST + JSON，前缀 `/api`
- 客户端版本号：`GET /api/meta/frontend-release` 返回 `{ latestVersion }`（当前 0.24.3），请求头 `x-frontend-version` 携带
- 服务器时间：响应头 `x-arcane-server-time`（毫秒时间戳），`/api/me` 响应体也含 `serverTime`

## 2. 认证

### 2.1 登录

```
POST /api/auth/login
Content-Type: application/json
Idempotency-Key: <uuid>

{ "email": "...", "password": "..." }
```

- 成功：`Set-Cookie: arcane_session=...`（会话凭证），响应体 `{ player, publicIdentity, party, serverTime }`
- 失败：400 `VALIDATION_ERROR` 等（错误格式 `{ error: { code, message } }`）
- 注册接口 `/api/auth/register` 需要邮箱验证码，本辅助未使用

### 2.2 请求签名（核心反作弊机制）

除白名单路径外，所有请求必须携带 HMAC 签名头：

```
x-arcane-request-proof      密钥（base64url(JSON{version,expiresAt}) + "." + 签名）
x-arcane-request-timestamp  毫秒时间戳（需按服务器时间校正）
x-arcane-request-signature  base64url(HMAC-SHA256(payload))
```

payload（`\n` 连接）：

```
v1
<METHOD 大写>
<path>?<query>       如 /api/fishing/sync
<timestamp>
<body>               GET 为空字符串；有 body 时为 JSON 字符串（与实际发送字节一致）
```

- **获取密钥**：任意响应（包括登录响应）的头 `x-arcane-request-proof`；或 `GET /api/me`（无需签名）
- **密钥过期**：解析 proof 第一段 base64url JSON 的 `expiresAt`；有效期为 ~15~20 分钟，随响应滚动续期
- **过期表现**：`403 { "error": { "code": "REQUEST_SIGNATURE_INVALID", "message": "请求签名已失效..." } }`
- **恢复方式**：重新 `GET /api/me` 即可拿到新 proof（Cookie 有效时）；Cookie 也失效则重新登录
- 白名单（无需签名）：`/api/auth/*`、`/api/content/bootstrap`、`/api/meta/frontend-release`、`/api/market/fish/events` 等

## 3. 在线钓鱼循环（保持在线的核心）

钓鱼由**客户端驱动**：服务端只按时间推进，客户端定时 sync 领取结算。

```
POST /api/fishing/start        开始一轮（若次数不足会报错）
GET  /api/fishing/state        查询状态（不推进）
POST /api/fishing/sync         领取自上次同步以来的结算（核心循环）
POST /api/fishing/refill       补满钓鱼次数（消耗金币）
POST /api/fishing/stop         结束本轮
POST /api/route-assistant/travel  按游戏内航线助手切图（服务端决策）
```

### 3.1 run 对象（`/api/fishing/state` 与 sync 响应中）

```json
{
  "id": "uuid",
  "status": "running | stopped | completed",
  "mode": "online | offline",
  "biomeId": "b_001",
  "totalCasts": 200,
  "remainingCasts": 200,
  "cycleDurationMs": 6000,
  "nextCastAt": "2026-09-06T17:58:34.223Z",
  "stats": { "strength": 0, "intelligence": 0, "luck": 0, "endurance": 100 },
  "effects": { "...": "加成快照" },
  "snapshotKey": "v1:XcJSG1a1m1PXn1JJ"   // 仅 sync 响应携带
}
```

### 3.2 sync 循环

```
POST /api/fishing/sync
X-Fishing-Run-Snapshot-Key: <snapshotKey 或 "missing">
Idempotency-Key: <uuid>
```

- 首次同步（或 run 换代后）用 `"missing"`，响应里取 `run.snapshotKey`，之后沿用（同一 run 内不变）
- 每到 `nextCastAt` 服务端结算一杆；在其后 sync，响应 `settlement.castsResolved` 为结算杆数
- **只要同步及时，`settlement.mode === "online"` 即在线渔获**（离线结算收益通常较低）
- 结算结构 `settlement`：`{ mode, castsResolved, gold, directGoldNet, experience, fish[], gear[], chests[], bonusItems[], relics, recentResults[], appliedBuffs[] }`
- `lastResult`：最近一杆明细（fishId/rarity/gold/experience）

### 3.3 状态查询

`GET /api/fishing/state` 返回：`run, lastResult, batchSummary, dailyHarvest, activeBuffs[],
onlinePlayerCount, serverTime, nextDailyHarvestResetAt, arcaneSacrifice, party, unlimitedOnlineFishing, ...`

## 4. 其他常用端点（实测可用）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/me` | GET | 玩家信息 + 刷新 proof |
| `/api/content/bootstrap` | GET | 静态内容（鱼类/地图/物品字典） |
| `/api/convenience` | GET | 便利权益 + **官方航线助手状态**（见下） |
| `/api/convenience/route-assistant/enabled` | PUT | 助手总开关 `{ enabled }` |
| `/api/convenience/route-assistant/settings` | PUT | 助手功能设置 |
| `/api/inventory/fish` | GET | 背包鱼类（含 sellPrice/totalSellValue） |
| `/api/inventory/fish/sell` | POST | 卖鱼 `{ items: [{ fishId, quantity }] }` |
| `/api/inventory/gear/sell` | POST | 卖装备 `{ gearIds: [] }` |
| `/api/daily-check-in` | GET | 签到状态 `{ checkedInToday, canClaim, currentStreak, rewards[] }` |
| `/api/daily-check-in/claim` | POST | 签到（游戏日为北京时间；重复领 409 ALREADY_CLAIMED） |
| `/api/shop/purchases` | POST | 买 Buff `{ productId }` |
| `/api/baits` / `/api/baits/<id>` | GET/POST | 鱼饵查询/购买 |
| `/api/baits/auto-refill` | PATCH | 自动补饵开关 `{ enabled }` |
| `/api/tournaments/overview` | GET | 个人赛总览 |
| `/api/guild-tournaments/overview` | GET | 公会赛总览 |
| `/api/events/world-boss` | GET | 世界 Boss 围猎总览（见 §4.2） |
| `/api/events/world-boss/selection` | POST | 渊潮围猎：选定出战属性 `{ stat }`，**选中即参战** |
| `/api/events/world-boss/history` | GET | 围猎历史 `?cursor=&limit=` |
| `/api/events/world-boss/collections` | GET | 遗珍藏品册；`/collections/register` 登记藏品 |
| `/api/events/arcane-sacrifice` | GET | 奥秘献祭 |
| `/api/party-boats/overview` | GET | 派对船 |
| `/api/guilds/me` | GET | 公会信息 |
| `/api/player/stats/allocate` | POST | 属性加点 |
| `/api/gear/loadouts` | GET/POST | 装备方案 |

## 4.1 官方航线助手（/api/convenience）

`GET /api/convenience` 返回便利权益与航线助手状态（已实测）：

```jsonc
{
  "products": [ { "id": "route-assistant", "name": "航线助手", ... } ],
  "entitlements": {
    "route-assistant": { "isActive": true, "endsAt": "..." }   // 免费期仍有权益到期时间
  },
  "routeAssistant": {
    "isEnabled": false,       // 用户总开关
    "isOperational": false,   // isEnabled && 权益有效；助手真正干活的条件
    "settings": {
      "isAutoTravelEnabled": true,             // 自动换图（比赛/金风 golden/经验 priorities）
      "isAutoCheckInEnabled": true,            // 自动签到
      "isAutoBaitEnabled": true,               // 场景鱼饵（baitByScene）
      "isAutoWorldBossRegistrationEnabled": true, // 渊潮围猎自动报名
      "isAutoArcaneSacrificeEnabled": false,   // 奥秘献祭（注意：≠地图专精献祭 /api/mastery）
      "priorities": ["competition", "golden", "experience"],
      "experienceBuffAutomation": { "...": "经验 Buff/公会增益自动化" }
    },
    "occupancy": { "...": "组队占用" }
  }
}
```

与本辅助插件的冲突矩阵（助手 `isOperational` 且对应开关打开时）：

| 本辅助插件 | 冲突开关 | 处理 |
| --- | --- | --- |
| 自动切图 | `isAutoTravelEnabled` | **硬冲突**：拒绝启动 + 运行中每 8 分钟软检测自动停手（两者都会把你换图） |
| 渊潮围猎参战 | `isAutoWorldBossRegistrationEnabled` | 只提示不停手：两者都只是 POST `selection`，服务端只认第一次选择 |
| 每日签到 | `isAutoCheckInEnabled` | 只提示不停手：签到幂等，重复领只会返回 `ALREADY_CLAIMED` |
| 自动报名赛事（进图部分） | `isAutoTravelEnabled` | 只停进图，报名照常 |
| 自动专精献祭 | 无（助手做的是「奥秘献祭」） | 不冲突 |

> 官方助手的「自动签到 / 围猎自动报名」要游戏页面打开、由前端客户端触发；本辅助是直接
> 打服务端 API，24 小时挂机也会执行，所以这两项不再让位（避免助手开关一开着就永远「启动失败」）。

## 4.2 渊潮围猎（世界 Boss）

`GET /api/events/world-boss`（实测 + 对照游戏前端 bundle）：

```jsonc
{
  "session": {                        // 没有场次时为 null
    "id": "…", "battleAt": "2026-09-29T11:00:00.000Z",
    "status": "registration | preparing | active | settling | defeated | escaped | canceled",
    "currentHealth": 900000,
    "boss":   { "name": "…", "epithet": "…", "weaknessStat": "intelligence", "defenseStat": "strength" },
    "player": { "selectedStat": null, "damage": 0, "damageShare": 0, "rank": null,
                "recentDamage": 0, "dropWeight": null, "isLocked": false,
                "settlement": { "rewardStatus": "paid | failed" } },
    "topLeaderboard": [], "nearbyLeaderboard": []
  },
  "nextPrepareAt": "2026-09-29T11:00:00.000Z"
}
```

- **选中即参战**：`POST /api/events/world-boss/selection { stat }` 之后由服务端自动攻击。
  游戏内原文：「完成属性选择后，自动攻击不受页面停留或钓鱼状态影响。」
  因此**没有攻击接口**，也不需要进任何特定地图。
- **快照锁定**：第一次攻击产生时锁定本场属性与数值快照（`player.recentDamage > 0` 或
  `player.isLocked === true`），之后不能改。要打高伤害必须在开战前就用最强属性完成选择。
- 没选属性的场次不计个人伤害（游戏内原文：「你没有选择攻击属性，因此本场没有个人伤害或奖励。」）。
- 另有 `world-boss:registration-opened / started / ended` 三个 WS 事件；本辅助用轮询代替。

## 5. 实现参考

- 本项目客户端实现：`server/src/core/client.js`
- 在线循环实现：`server/src/plugins/keep-online.js`
- 社区油猴脚本（协议参考）：`奥术摸鱼大师辅助-v2.1.3.js`（同目录）
