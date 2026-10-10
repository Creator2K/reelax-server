# 架构与扩展

本项目**没有插件系统**（这是相对前身版本的刻意移除）。功能是一组编译期确定的内置模块，
由 `AccountRuntime` 直接驱动。本文说明数据流与「怎么加一个新功能」。

---

## 1. 分层

```
api/            Express 路由 + WebSocket 网关（只做参数校验、鉴权、调 service）
  └─ services/  业务服务：视图拼装、归属校验、跨仓储编排
      └─ db/repositories/   存储（只做 SQL，不碰加密）
security/       AES-256-GCM 加解密、凭证保管箱、scrypt 口令哈希
auth/           注册/登录/会话/RBAC/限流/cookie 策略
game/           签名客户端、代理层、账号运行时、运行时注册表
modules/        16 个内置功能 + 模块定义契约
```

**硬性规则**：

1. **路由层不直接写 SQL**，一律经 service → repository。
2. **每个按用户隔离的查询都必须带 `user_id`**，越权返回 **404**（不是 403，避免泄漏资源存在性）。
3. **只有 `security/vault.ts` 能把密文解成明文**，且必须显式传 `userId`（AAD 绑定）。
   列表查询永远不触碰密文字段。
4. **模块不 import 其他模块**，共享逻辑放 `modules/shared/`。

---

## 2. 一次钓鱼同步的完整链路

```
AccountRuntime.tickLoop()                         ← 唯一的时间驱动源
  │  等到 run.nextCastAt + 抖动
  ├─ GameClient.fishingSync(snapshotKey)          ← HMAC 签名 + 代理 dispatcher
  │     └─ 403/401 → refreshProof() → 失败则重登 → 只重试一次（复用同一幂等键）
  ├─ absorb(resp)                                 ← 续 proof / 校正服务器时间 / 更新 cookie
  ├─ reportRun(run)                                ← 同一 run 增量合并
  ├─ reportSync({run, settlement})                 ← 累加内存统计 + 写 account_stats_daily
  └─ bus.emit("fishing:sync", {...})
        ├─ WsGateway: 按 userId 推给该用户的浏览器
        └─ 各模块的 ctx.on("fishing:sync") 回调
              ├─ auto-stats      点数到账 → 3 秒后合并成一波加点
              ├─ auto-bait       比赛临近 → 换比赛饵（节流 1 分钟）
              ├─ auto-sell-gear  结算里有 gear 才触发
              ├─ daily-checkin   跨天检查（节流 5 分钟）
              └─ daily-digest    累计经验差值
```

`keep-online` 的循环刻意放在 `game/account-runtime.ts` 而不是模块里：

- 只有一个节拍源 → 不会出现「两个模块各自 sync 抢结算」
- 账号停止时不会留下「模块停了但循环还在跑」
- 模块只声明配置与开关语义，职责清晰

---

## 3. 怎么加一个新功能

### 3.1 写模块定义

新建 `server/src/modules/my-feature/index.ts`：

```ts
import { type ModuleDefinition } from "../types.ts";

const definition: ModuleDefinition = {
  id: "my-feature",              // 全局唯一，kebab-case
  name: "我的功能",
  version: "1.0.0",
  description: "一句话说明，会显示在功能卡片上。",
  defaultEnabled: false,         // 新账号是否默认启用（只有 keep-online 是 true）
  defaultConfig: { mode: "a", intervalMin: 10 },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "模式",
      hint: "显示在控件下方的说明",
      default: "a",
      options: [
        { value: "a", label: "方案 A" },
        { value: "b", label: "方案 B" },
      ],
    },
    { key: "intervalMin", type: "number", label: "间隔（分钟）", default: 10, min: 1, max: 120, step: 1 },
  ],

  // 启动前检查：抛错则该模块不启动，错误原样显示在功能卡片上
  async onStart(ctx) {
    // ctx.api 是签名游戏客户端；ctx.config 是合并后的配置
    ctx.log.info("我的功能", `已启动，模式=${ctx.config.mode}`);

    // 定时器与事件订阅都受管：账号停止时自动清理
    ctx.every(Number(ctx.config.intervalMin) * 60_000, async () => {
      const me = await ctx.api.me();
      ctx.log.info("我的功能", `金币 ${me?.player?.gold}`);
    });

    ctx.on("fishing:sync", (evt) => {
      // 每次结算后做点什么（注意节流！这个事件约每 6 秒一次）
    });
  },

  async onStop(ctx) {
    // 只清理自有资源；ctx.every/ctx.schedule/ctx.on 由框架自动清理
  },
};

export default definition;
```

### 3.2 注册到清单

`server/src/modules/registry.ts` 里 import 并加入 `MODULES` 数组：

```ts
import myFeature from "./my-feature/index.ts";

export const MODULES: ModuleDefinition[] = [
  keepOnline,
  // ...
  myFeature,     // ← 加在这里。数组顺序 = 前端展示顺序
];
```

启动时会跑 `assertRegistryValid()`：id 重复、select 没 options、min > max 都会**直接拒绝启动**
（而不是运行时才炸）。

前端不需要改任何代码 —— 功能卡片与配置表单由 `configSchema` 驱动渲染。

### 3.3 加测试

把决策逻辑抽成**纯函数**导出，然后单测。参考：

- `modules/auto-stats/index.ts` 的 `planAllocation()` / `parseRatio()`
- `modules/auto-sell-gear/index.ts` 的 `bucketOf()`
- `modules/auto-travel/index.ts` 的 `pickBest()` / `xpWeight()`
- `modules/keep-online/status-panel.ts` 的 `totalXpMultiplier()`
- `modules/auto-loadout/plan.ts` 的 `parsePlan()` / `pickPlanEntry()`（文本配置的时间表）
- `modules/shared/schedule.ts` 的 `parseSchedule()` / `parseOnOffPlan()` / `milestoneOccurrence()`
  （通用时间表：三个功能共用）
- `modules/auto-sacrifice/decide.ts` 的 `decideSacrifice()`（献祭多少：不可撤回的花费，判定要保守）
- `modules/auto-guild-boost/decide.ts` 的 `decideGuildBoost()`（花公会金库，判定同样要保守）
- `modules/auto-xp-buff/decide.ts` 的 `decidePurchase()`（商店商品表 + 该不该买）
- `services/account-schedule-service.ts` 的 `applyOne()`（账号定时启停的判定，见 §9）

对应测试在 `server/test/modules.test.ts`；模块级的「行为」测试（对着假游戏 API 跑真实
`onStart`）见 `server/test/auto-loadout-module.test.ts`、`server/test/auto-xp-buff-module.test.ts` ——
只测纯函数挡不住「一个商品失败把整个循环带走」这类问题，所以新模块最好两种都写。

### 3.4 配置预览（可选）

文本类配置（时间表、模板）光看输入框看不出效果，可以在 `modules/preview.ts` 的 `BUILDERS`
里登记一个纯函数，前端就会在表单旁边实时渲染（`ModulePreview` 走 `POST /api/modules/:id/preview`）。
预览**不做网络请求**、也不校验配置——它要能一边编辑一边看，非法值优雅地返回 `null` 即可。

---

## 4. 模块上下文（`ctx`）

| 成员 | 说明 |
| --- | --- |
| `ctx.moduleId` | 模块 id |
| `ctx.config` | 本账号的本模块配置（默认值 + 用户配置 + 校验后） |
| `ctx.state` | 模块私有内存（账号重启后清空，**不持久化**） |
| `ctx.log` | `info/warn/error/debug(tag, msg)`，已带账号与模块标签 |
| `ctx.api` | `GameClient`：已处理登录、签名、proof 续期、失效重登 |
| `ctx.account` | 账号运行时（状态上报、`emit`、`runtimeStats()`） |
| `ctx.on(evt, fn)` | 订阅账号级事件（只收到本账号的） |
| `ctx.every(ms, fn)` | 受管定时器（异步错误自动进日志） |
| `ctx.schedule(ms, fn)` | 受管延时任务 |

**事件列表**：`fishing:sync`、`account:started`、`account:stopped`、`account:status`、
`account:error`、`module:error`、`digest`

`module:error` 之外的所有事件都带 `accountId` / `userId`，框架已按账号过滤。

---

## 5. 状态上报 API（`ctx.account`）

| 方法 | 用途 |
| --- | --- |
| `setStatus(status, detail?)` | `starting` / `online` / `reconnecting` / `error` / `expired` |
| `reportRun(run)` | 上报 run 快照（同一 id 会增量合并） |
| `reportSync({run, settlement})` | 上报结算（自动累加统计并写日统计表） |
| `reportOnlineCount(n)` | 游戏内当前在线人数（展示用） |
| `reportStatusPanel(panel)` | 自定义展示面板内容 |
| `emit(event, payload)` | 抛结构化事件（如日报的 `digest`） |
| `runtimeStats()` | 本次运行累计统计（日报「无基线」兜底用） |

> `reportStatusPanel` 的实现是 **keep-online 反向注入**的：
> `account-runtime` 与 `modules/types` 之间有循环依赖，所以由
> `modules/bootstrap.ts` 在启动时调用 `registerStatusPanelBuilder()`。
> 加新面板时照这个模式，不要在模块体里 import `account-runtime` 的值
> （会命中 `let` 的 TDZ）。

---

## 6. 官方航线助手：解耦，而不是协作

游戏自带「航线助手」。它的**决策跑在浏览器里**（React effect + react-query 缓存 +
`window.setTimeout`），没人开着游戏页面时它什么都不做；但它的**开关存在服务端**，
所以「开着」这件事一直成立。详细机制见 `docs/PROTOCOL.md` §4.1 / §4.5。

**本项目的立场：功能全部自己做，和助手零接触。**

- 助手有的功能：本项目自己实现（换图、换饵、签到、围猎参战、经验 Buff、
  **奥秘献祭**、**公会区域增益**）—— 都用游戏自己的端点，不依赖助手权益。
- 助手没有的功能：本来就只有本项目有（保底切图、定时配装、定时挂机、卖装备、日报…）。
- 因此代码里**没有任何**助手相关调用：不读它的开关、不接管、不代它执行、不提示。
  历史实现见 git log —— 「硬冲突拒绝启动」「临时接管开关」「代驱动换图」「只读提示」
  都做过，最后按「功能自己全包」这个方向逐个删掉了。

> 也就是说：**`/api/convenience` 现在没有任何调用方**。唯一的动作在于用户 ——
> 在游戏里把助手的「自动换图」关掉（否则你哪天打开游戏页面，助手会和本项目抢图）。

覆盖对照（谁实现了什么）：

| 助手功能 | 本项目对应模块 | 端点 |
| --- | --- | --- |
| 自动换图 | `auto-travel` / `auto-pity` | `PUT /api/player/current-biome` |
| 场景鱼饵 | `auto-bait` | `/api/baits/{id}/purchase` + `/equip`（同样 5 个场景：个人赛/公会赛/金风/涌流/平时） |
| 自动签到 | `daily-checkin` | `/api/daily-check-in/claim` |
| 围猎自动报名 | `auto-world-boss` | `/api/events/world-boss/selection` |
| 经验 Buff 自动化 | `auto-xp-buff` | `/api/shop/purchases`（还多买两种属性 Buff） |
| **奥秘献祭** | `auto-sacrifice` | `/api/events/arcane-sacrifice/contributions` |
| **公会区域增益** | `auto-guild-boost` | `/api/guilds/me/boosts/{biomeId}` |
| 地图专精献祭（助手没有） | `auto-mastery` | `/api/mastery/{biomeId}/contribute-all` |

---

## 7. 扩展游戏客户端

`game/client.ts` 里加便捷方法即可（签名、超时、代理、错误分类都已处理好）：

```ts
myEndpoint(arg: string) {
  return this.request("/api/my/endpoint", {
    method: "POST",
    body: { arg },
    idempotent: true,        // 写操作建议开启：重试会复用同一 Idempotency-Key
  });
}
```

排查「游戏更新后失效」：对照 `docs/PROTOCOL.md` 检查端点与签名算法，
通常只需要改这个文件。

---

## 8. 频率自律

- 游戏客户端的天然节奏是 **6 秒/杆**，`fishing:sync` 就是这个节奏
- 任何挂在 `fishing:sync` 上的逻辑**必须节流**（各模块用 1~5 分钟不等）
- 定时轮询间隔不要低于 60 秒
- 写操作（卖装备、买 Buff、加点）建议默认关闭或有明确上限

---

## 9. 定时启停为什么不在模块里

「定时挂机」这个功能**看起来**是个模块（它在功能列表里、有开关、有配置表单），
但它的执行者不在模块里，而在 `services/account-schedule-service.ts`：

```
account_modules(auto-schedule 行)  ←  用户在功能卡片里填的时间表
        │  每 30 秒读一次（enabled=1 的行）
        ▼
AccountScheduleService.tick()  ──►  RunnerRegistry.start() / stop()
```

原因很简单：**账号被停掉以后，模块的定时器也跟着停了**，靠模块自己永远起不来。
所以调度器必须活在账号运行时之外，并且**直接读数据库**（不能走 `ctx.config`）。

这样做的取舍：

- 好处：配置界面、开关、校验、预览、持久化全部复用模块体系，**前端一行都不用改**，
  也不需要为它加一张表 / 一次迁移。
- 代价：「模块」这个概念在这里只是配置容器，看代码的人容易误会 —— 所以
  `modules/auto-schedule/index.ts` 与 `services/account-schedule-service.ts` 的文件头
  都写明了这一点，模块内的注释也标注了「不要在这里另搞一套启停逻辑」。

三条语义（两边必须一致，改动时一起改）：

1. **到点生效的里程碑**：当前档 = 时间 ≤ 现在的最后一条，今天没到就用昨天的最后一条。
2. **只在跨过新的一档时执行一次**：两档之间不反复对齐状态 ——
   否则用户手动点「停止」会在半分钟内被拉起来，看起来像关不掉。
3. **服务重启后重新对齐一次**：`applied` 是内存态，重启后按当前档执行一次 ——
   否则「该跑的时候一直不跑」。

其它已知交互（不是缺陷，但要知道）：

- 启动失败（凭证过期 / 并发上限）会冷却 5 分钟再试，同一档只警告一次。
- 时间表优先级高于账号的「自动启动」：开机恢复会把 `auto_start` 的账号拉起来，
  之后调度器在「off」那一档再把它停掉（最多几十秒的重合）。
