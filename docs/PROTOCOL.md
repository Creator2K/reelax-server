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
| `/api/shop/purchases` | POST | 买商店商品 `{ productId, quantity }`（**商品 id 表见 §4.3，写错会静默失效**） |
| `/api/baits` / `/api/baits/<id>` | GET/POST | 鱼饵查询/购买 |
| `/api/baits/auto-refill` | PATCH | 自动补饵开关 `{ enabled }` |
| `/api/tournaments/overview` | GET | 个人赛总览 |
| `/api/guild-tournaments/overview` | GET | 公会赛总览 |
| `/api/events/world-boss` | GET | 世界 Boss 围猎总览（见 §4.2） |
| `/api/events/world-boss/selection` | POST | 渊潮围猎：选定出战属性 `{ stat }`，**选中即参战** |
| `/api/events/world-boss/history` | GET | 围猎历史 `?cursor=&limit=` |
| `/api/events/world-boss/collections` | GET | 遗珍藏品册；`/collections/register` 登记藏品 |
| `/api/events/arcane-sacrifice` | GET | 奥秘献祭总览（见 §4.6） |
| `/api/events/arcane-sacrifice/contributions` | POST | 献祭资源 `{ resourceType, rarity?, quantity }`（见 §4.6） |
| `/api/party-boats/overview` | GET | 派对船 |
| `/api/guilds/me` | GET | 公会信息（含金库 / 权限，见 §4.7） |
| `/api/guilds/me/boosts` | GET/POST | 公会区域经验增益：查询 / `POST /{biomeId} { units }` 购买（见 §4.7） |
| `/api/player/stats/allocate` | POST | 属性加点 |
| `/api/gear/loadouts` | GET | 装备配装方案列表（见 §4.4） |
| `/api/gear/loadouts/<slot>/load` | POST | 装载（穿上）某套配装（见 §4.4） |

### 4.0 `GET /api/biomes` 的字段（多个模块都依赖，改版时先看这里）

```jsonc
{
  "biomes": [
    {
      "id": "b_009",
      "name": "极昼冰湾",
      "isCurrent": true,           // ★ 当前地图（模块靠它找「我在哪」）
      "isUnlocked": true,
      "valueMultiplier": 1.4,
      "weather": {                 // ★ 天气：id 字段是 weatherId（不是 id）
        "weatherId": "arcane_surge",
        "name": "奥秘涌流",
        "effect": "经验 +75%；高阶鱼与遗物权重提高",
        "startedAt": "…", "endsAt": "…"
      },
      "activeCompetitions": []      // 本图正在进行的比赛
    }
  ],
  "currentBiomeId": "b_009",
  "serverTime": "…"
}
```

- 天气 id 只有 9 种：`clear / rain / gale / mist / heatwave / tempest / wither_tide / gilded_current / arcane_surge`。
- ★ 游戏前端内部会把 `weather.weatherId` 映射成 `weather.id` 再给插件用，**服务端原始响应里是 `weatherId`**。
  读天气时两者都兜一下最稳（状态面板就是这么写的）。


## 4.1 官方航线助手（/api/convenience）

### ★ 谁在执行？——决策在浏览器，执行在服务端（这一点决定了「挂机时助手不生效」）

抓游戏前端 bundle 可以确认：助手的**决策逻辑全部在浏览器里** ——
一个 React `useEffect` 里用 react-query 缓存 + `window.setTimeout` 反复计算
「该不该换图 / 该不该买 Buff」，算出结果后**才**去调服务端的接口执行。

```
浏览器（游戏页面）                          服务端
  ├─ 读 react-query 缓存（/api/me、/api/biomes、/api/shop…）
  ├─ rP()/xP() 决策：该不该换图、该买哪个 Buff
  └─ 执行 ─────────────────────────────►  POST /api/route-assistant/travel
                                          POST /api/route-assistant/personal-experience-buff/purchase
                                          POST /api/route-assistant/world-boss/register
                                          POST /api/route-assistant/arcane-sacrifice/contribute
                                          PUT  /api/convenience/route-assistant/enabled | /settings
```

结论：
- **没人开着游戏页面 → 助手一个动作都不会做**（本辅助挂机时就属于这种情况）。
- 但助手的**开关存在服务端**，所以「`isAutoTravelEnabled` 是 true」这件事一直成立。
- 早期只看开关就判定「与助手硬冲突、拒绝启动自动切图」，于是出现
  「助手明明没在跑，却报冲突」的假冲突。
- ★ 但**执行端点是可以由本辅助调用的**，而且 `travel` 由服务端决策 ——
  所以「让助手在挂机时也生效」是可以做到的（见 §4.5 与「航线助手调度」功能）。

`GET /api/convenience` 返回便利权益与航线助手状态（已实测，字段名与前端 schema 一致）：

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
      "isPartyAllMembersUnlockedOnly": true,   // 船队换图：要求全员解锁
      "isPartySummonAllowed": true,
      "isAutoCheckInEnabled": true,            // 自动签到
      "isAutoBaitEnabled": true,               // 场景鱼饵（baitByScene）
      "isAutoWorldBossRegistrationEnabled": true, // 渊潮围猎自动报名
      "isAutoArcaneSacrificeEnabled": false,   // 奥秘献祭（注意：≠地图专精献祭 /api/mastery）
      "priorities": ["competition", "golden", "experience"],   // 必须恰好 3 项且不重复
      "baitByScene": { "personalCompetition": [], "guildCompetition": [], "golden": [],
                       "arcaneSurge": [], "normal": [] },      // 每个场景用哪些饵
      "experienceBuffAutomation": {
        // ★ 助手只买经验类 Buff：潮痕研习 I/II + 碎光顿悟(+公会地图增益)
        "relic":    { "isEnabled": false, "productId": "relic-xp-i|relic-xp-ii",
                      "purchaseMode": "always|arcane_surge", "minimumBalance": 0 },
        "fragment": { "isEnabled": false, "purchaseMode": "always|arcane_surge", "minimumBalance": 0 },
        "guild":    { "isEnabled": false, "activationMode": "always|guild_tournament|arcane_surge",
                      "minimumTreasuryGold": 0 }
      }
    },
    "occupancy": { "...": "组队占用：谁在控制船队换图" }
  }
}
```

写设置的规矩：
- 总开关：`PUT /api/convenience/route-assistant/enabled`，body `{ enabled }`。
- 功能开关：`PUT /api/convenience/route-assistant/settings`，body 是**整份 settings**
  （服务端用严格 schema，游戏自己的面板也是 `structuredClone(settings)` 之后整体提交）。
  所以改一项必须先把整份读回来、只翻那个字段再整体 PUT。
- 打开总开关时，如果当前船队身份没有换图权限，服务端会**自动把 `isAutoTravelEnabled` 关掉**
  （响应里能看出来），并提示「自动鱼饵与签到仍可使用」。

与本辅助插件的关系：**本项目完全不调用助手的任何接口**（包括读 `/api/convenience`）——
既不接管它的开关、也不代它执行、也不做提示。功能全部自己做，用的是游戏自己的端点。

| 助手功能 | 本辅助对应模块 | 用的是哪个端点 |
| --- | --- | --- |
| 自动换图 | `auto-travel` / `auto-pity` | `PUT /api/player/current-biome` |
| 场景鱼饵 | `auto-bait` | `/api/baits/{id}/purchase` + `/equip` |
| 自动签到 | `daily-checkin` | `/api/daily-check-in/claim` |
| 围猎自动报名 | `auto-world-boss` | `/api/events/world-boss/selection`（自己挑最高属性） |
| 经验 Buff 自动化 | `auto-xp-buff` | `/api/shop/purchases`（另含渊流臂力 II / 星鳞灵感 II / 万流共鸣） |
| 奥秘献祭 | `auto-sacrifice` | `/api/events/arcane-sacrifice/contributions`（见 §4.6） |
| 公会区域增益 | `auto-guild-boost` | `/api/guilds/me/boosts/{biomeId}`（见 §4.7） |

> ★ 为什么不再「代助手去问」或「临时接管它的开关」：
> 那等于替用户改游戏里的设置，进程被 kill 还可能忘了恢复；
> 而本项目已经把助手的功能全包了，**用户在游戏里关掉它**才是一劳永逸。
> 助手是跑在浏览器里的循环（见下面 §4.5），挂机时它本来就不动。


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

## 4.3 商店商品表（`POST /api/shop/purchases`）

★ 这份表是抓游戏前端 bundle 得到的（前端 0.25.2 / contentVersion 2026.20），**不是猜的**。
`productId` 写错的后果非常隐蔽：请求只会返回一个错误，模块看起来「什么都没做」。

| productId | 名称 | 商店 | category | 效果 | 时长 | 价格 |
| --- | --- | --- | --- | --- | --- | --- |
| `relic-xp-i` | 潮痕研习 I | 遗物 | experience | 个人经验 +30% | 1800s | 75 遗物 |
| `relic-xp-ii` | 潮痕研习 II | 遗物 | experience | 个人经验 +75% | 1800s | 150 遗物 |
| `relic-strength-i` | 渊流臂力 I | 遗物 | strength | 有效力量 +10% | 1800s | 75 遗物 |
| `relic-strength-ii` | 渊流臂力 II | 遗物 | strength | 有效力量 +25% | 1800s | 150 遗物 |
| `relic-luck-i` | 星鳞灵感 I | 遗物 | luck | 有效运气 +10% | 1800s | 75 遗物 |
| `relic-luck-ii` | 星鳞灵感 II | 遗物 | luck | 有效运气 +25% | 1800s | 150 遗物 |
| `fragment-personal-xp` | 碎光顿悟 | 碎片 | experience | 个人经验 +25% | 7200s | 20 碎片 |
| `fragment-global-xp` | 万流共鸣 | 碎片 | experience | 全服经验 +50%（按购买顺序生效） | 7200s | 50 碎片 |

购买规则（商店 UI 与航线助手自动化都按这个来）：

- 请求体 `{ productId, quantity }`，写操作带幂等键。
- **同商店 + 同 category 只能有一个个人增益生效**：买同一商品 = 续期；
  买**另一个**同类商品会被拒（商店里按钮直接显示「同类增益生效中」而禁用）。
  所以自动化在「同类增益正生效」时不该去撞，等它结束。
- 不同 category 可以并存（遗物商店里经验 / 力量 / 运气可以同时挂着）。
- 玩家身上的对应字段：`GET /api/fishing/state` 的 `activeBuffs[]`，个人增益的形状是
  `{ id, source: "personal_shop", shop, buffType(=category), displayTag(=productName),
     displayDescription, bonusBasisPoints, startsAt, endsAt, status }`。
- 官方航线助手的「经验 Buff 自动化」只会买上表里的**经验类**（`relic-xp-i/ii`、
  `fragment-personal-xp`，外加公会地图增益），**不买**`relic-strength-ii` / `relic-luck-ii`。
  所以「自动 Buff」模块里那两项是独有的功能，不是重复实现。

## 4.4 装备配装（`/api/gear/loadouts`）

```jsonc
// GET /api/gear/loadouts
{
  "loadouts": [
    {
      "slot": 1,                    // 配装序号（游戏里叫「配装 1 / 配装 2 …」）
      "name": "刷经验",              // 没存过内容时为 null
      "gear": {                     // 以部位为键，空位是 null
        "head": { "id": "…", "name": "…" },
        "chest": null, "legs": null, "boots": null, "gloves": null,
        "amulet": null, "ring_1": null, "ring_2": null, "charm": null
      },
      "stats": { "…": 0 }
    }
  ]
}
```

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/gear/loadouts` | GET | 列出全部配装槽（含空槽） |
| `/api/gear/loadouts/<slot>` | PUT | 把**当前身上这套**存进该槽，body `{ name }`（名字上限 24 字） |
| `/api/gear/loadouts/<slot>/load` | POST | 装载该槽，把身上装备换成配装内容 |
| `/api/gear/loadouts/<slot>` | DELETE | 清空该槽 |

- 部位键固定为：`head / chest / legs / boots / gloves / amulet / ring_1 / ring_2 / charm`。
- 装备被**锁定**或**挂到市场**后会被游戏自动从配装里移除；此时装载会失败，
  自动化应当在日志里说明原因并退避重试，而不是每分钟撞一次。
- 官方航线助手没有配装自动化，**不冲突**。

## 4.5 官方助手的执行端点（`/api/route-assistant/*`）—— 本项目**不用**，仅作参考

这一节留着是因为它解释了很多现象（为什么挂机时助手不干活、它的功能各由谁执行）。
本项目**不调用**这些端点：助手的功能要么本项目自己实现（§4.6 / §4.7 与 §4.1 的对照表），
要么本项目用不上。历史上的「代驱动换图」「临时接管开关」都因此删掉了。

```
POST /api/route-assistant/travel          # 无 body，写操作带幂等键
```

响应（实测 + 对照游戏前端 bundle）：

```jsonc
{
  "status": "traveled | deferred | idle | …",
  "reason": "competition | golden | experience | …",   // 为什么换（比赛 > 金风 > 经验）
  "scope": "personal | party",
  "targetBiomeId": "b_012",
  "personalTravel": { "player": { "currentBiomeId": "…" }, … },   // 已生效的换图结果（局部 patch）
  "partyTravel":    { "currentBoatBiomeId": "…", "changed": true, "movedCount": 3,
                      "skippedLockedCount": 0, "skippedAwayCount": 0,
                      "skippedGuildCompetitionCount": 0 },
  "executeAt": "…",        // status=deferred 时：服务器打算什么时候真的换
  "reevaluateAt": "…",     // 建议什么时候再问一次
  "serverTime": "…"
}
```

**下一次该隔多久问**（游戏客户端就是这么算的）：
取 `executeAt` 与 `reevaluateAt` 里**最近的未来时刻**，等 `min(executeAt, reevaluateAt) - serverTime`；
两个都没有就给个兜底间隔。

失败码（都在 bundle 的文案表里，可以直接展示给用户）：

| 错误码 | 含义 |
| --- | --- |
| `CONVENIENCE_ENTITLEMENT_REQUIRED` | 便利权益未生效（需要购买 / 续期） |
| `ROUTE_ASSISTANT_OCCUPIED` | 船队的自动航线已由其他成员控制 |
| `ROUTE_ASSISTANT_PERMISSION_DENIED` | 只有船长 / 舵手能开启船队自动换图 |
| `PARTY_BOAT_BIOME_NOT_UNLOCKED_BY_ALL` | 有船队成员尚未解锁目标地图，已取消自动换图 |

- 助手总开关 `isEnabled=false` 或权益过期时，服务端不会真的执行。
- 同类端点还有：`/api/route-assistant/personal-experience-buff/purchase {shop}`（买经验 Buff）、
  `/api/route-assistant/world-boss/register`（围猎报名）、
  `/api/route-assistant/arcane-sacrifice/contribute`（奥秘献祭）、
  `/api/route-assistant/guild-experience-boost/activate`（公会地图增益）。
  它们的共同套路是「浏览器决定**要不要**，服务端决定**做什么**」。

### 助手的功能里，哪些能「代替浏览器」做完？

判断标准：**这个功能有没有服务端执行端点**。有 → 调用它（行为与助手一致）；
没有（纯浏览器逻辑）→ 只能自己复刻决策，否则挂机时就是没人做。

**注意**：下表的「本服务的做法」列说的是**现在**的实现 —— 本项目一律用游戏自己的端点自己实现，
不调用助手那些 `/api/route-assistant/*`（那需要助手权益，而且等于借道它的自动化）。

| 助手功能 | 助手用的执行端点 | 浏览器那一步在决定什么 | 本服务的做法 |
| --- | --- | --- | --- |
| 自动换图 | `POST /api/route-assistant/travel` | 按什么节奏去问 | 自己算图：`auto-travel` / `auto-pity` 直接 `PUT /api/player/current-biome` |
| 围猎自动报名 | `POST /api/route-assistant/world-boss/register` | 场次 preparing/active 且尚未选属性 | 自己报名 + 自己挑最高属性（`auto-world-boss` → `/api/events/world-boss/selection`） |
| 奥秘献祭 | `POST .../arcane-sacrifice/contribute` | 有开放轮次且本轮还没贡献 | 自己算数量并提交（`auto-sacrifice` → §4.6） |
| 公会区域增益 | `POST .../guild-experience-boost/activate` | 权限 + 公会资金 + 生效窗口 | 自己买（`auto-guild-boost` → §4.7） |
| 经验 Buff 自动化 | `POST .../personal-experience-buff/purchase {shop}` | purchaseMode / 余额下限 / 剩余时间 | 自己买（`auto-xp-buff` → `/api/shop/purchases`），还多买两种属性 Buff |
| 自动签到 | 无（浏览器直接 `POST /api/daily-check-in/claim`） | 是否能领 | 直接调同一个端点（`daily-checkin`） |
| 场景鱼饵 | **无** | 按 `baitByScene` 挑饵并 `purchase` + `equip` | 只能自己复刻（`auto-bait` 就是这么做的） |

## 4.6 奥秘献祭（`/api/events/arcane-sacrifice`）

全世界共同消耗资源推进轮次，达成后激活覆盖所有地图的「奥秘涌流」。

```jsonc
// GET /api/events/arcane-sacrifice
{
  "status": "ready | …",
  "day": { "date": "2026-10-10" },
  "currentRound": {
    "roundNumber": 3,
    "status": "open | settled | …",          // 只有 open 能献
    "resourceType": "fish | gold | relic",   // 本轮要哪种资源
    "target": 1000,                          // 本轮目标（点数）
    "progress": 200
  },
  "currentPlayerRoundContribution": {
    "contribution": 10,        // 我在本轮已贡献的点数
    "remaining": 100,          // ★ 服务端算好的「我还能贡献多少点」（单人上限，别自己算）
    "limitBasisPoints": 5000   // 单人上限 = 目标的 50%
  },
  "availableAssets": { "fish": { "common": 500, "rare": 3 }, "gold": 50000, "relics": 800 },
  "fishPoints": { "common": 1, "uncommon": 2, "fine": 4, "rare": 8, "epic": 16 },
  "rounds": [ … ], "todayLeaderboard": [ … ], "currentPlayerRank": null,
  "serverTime": "…"
}
```

```
POST /api/events/arcane-sacrifice/contributions
  fish  → { "resourceType": "fish", "rarity": "common", "quantity": 100 }
  gold  → { "resourceType": "gold", "quantity": 100 }     // 1 金币 = 1 点
  relic → { "resourceType": "relic", "quantity": 100 }
→ { "contribution": { "resourceType", "inputQuantity", "contribution", "assetBalanceAfter" }, … }
```

- **可献数量 = min(该资源持有量, floor(剩余额度 ÷ 单位点数))**（游戏自己的献祭页就是这么算的）。
- 可献的鱼只有 5 档：`common / uncommon / fine / rare / epic`。
- ★ 献祭**不可撤回**：即使本轮全服没达标也不返还；金币 / 遗物走 `availableAssets.gold / relics`。
- 另有只读端点：`/leaderboard?resource=&limit=`、`/current-leaderboard?resource=&limit=`、`/rewards`。

## 4.7 公会区域经验增益（`/api/guilds/me/boosts`）

给某张地图买「公会经验 +50%」，**消耗公会金库**，只有干部能开。

```jsonc
// GET /api/guilds/me
{ "guild": { "treasuryGold": 123456 }, "config": { "boostUnitCost": 500 },
  "membership": { "permissions": { "canActivateBoosts": true } } }
```

```jsonc
// GET /api/guilds/me/boosts
{
  "boosts": [ { "biomeId": "b_009", "isActive": true, "isQueued": false, "endsAt": "…" } ],
  "unitCost": 500,               // 每份多少金币（通常等于 config.boostUnitCost）
  "unitDurationMinutes": 30,     // 每份多少分钟
  "maxUnits": 10,                // 单次最多买几份
  "serverTime": "…"
}
```

```
POST /api/guilds/me/boosts/{biomeId}   body { "units": 2 }   → 开启 / 延长该图的增益
```

- 费用 = `units × unitCost`，从**公会金库**扣；买之前应校验 `treasuryGold` 够不够。
- 官方助手的做法是：只在**当前地图**开、每次 1 份、并且等已有增益结束（+10 分钟）再续。
  本项目的 `auto-guild-boost` 更灵活：可固定地图、可设份数、可设「还剩多少分钟就续」，
  还可以设一个**金库保留下限**（默认 0，建议调高 —— 花的是大家的钱）。

## 5. 实现参考

- 本项目签名客户端：`server/src/game/client.ts`
- 在线循环：`server/src/game/account-runtime.ts` 的 `tickLoop()`
- 各功能模块：`server/src/modules/<id>/index.ts`（清单见 `server/src/modules/registry.ts`）
- 社区油猴脚本（协议参考）：`奥术摸鱼大师辅助-v2.1.3.js`（同目录）
