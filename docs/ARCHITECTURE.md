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
modules/        11 个内置功能 + 模块定义契约
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

对应测试在 `server/test/modules.test.ts`。

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

## 6. 官方航线助手冲突处理

游戏自带「航线助手」。如果它也开着相同功能，两边会互相抢操作。分级处理：

| 本模块 | 冲突开关 | 处理 |
| --- | --- | --- |
| `auto-travel` | `isAutoTravelEnabled` | **硬冲突**：`onStart` 拒绝启动 + 运行中每 8 分钟复查后停手 |
| `auto-bait` | `isAutoBaitEnabled` | 软冲突：只提示不停手 |
| `auto-world-boss` | `isAutoWorldBossRegistrationEnabled` | 软冲突：只提示（`selection` 幂等） |
| `daily-checkin` | `isAutoCheckInEnabled` | 软冲突：只提示（签到幂等） |
| `auto-tournament` | `isAutoTravelEnabled` | 只让出「进图」，报名照常 |
| `auto-mastery` | — | 不冲突（助手做的是「奥秘献祭」，端点不同） |

写在 `modules/shared/conflicts.ts`：

```ts
// 硬冲突：拒绝启动
await assertNoAssistantConflict(ctx.api, "isAutoTravelEnabled", "自动切图");

// 软冲突：只提示一次
if (await assistantTakesOver(ctx.api, "isAutoCheckInEnabled")) {
  ctx.log.info("我的功能", "官方助手也开着，但两者幂等，继续工作");
}
```

读不到助手状态时 **fail-open**（抛带 `softWarning` 的错误，只记日志继续启动）：
网络抖动不该导致挂机起不来。

**为什么软冲突不让位**：官方助手要游戏页面打开、由前端触发；本服务直连 API，
24 小时挂机也会执行。如果软冲突也拒绝启动，用户一开助手就永远启动失败。

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
