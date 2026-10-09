// 保持在线：自动开始并持续维持在线钓鱼循环
//
// 工作原理（详见 docs/PROTOCOL.md）：
//  - 在线模式由客户端驱动：POST /api/fishing/start 开启一轮（默认 200 杆 × cycleDurationMs）
//  - 服务端在每个 nextCastAt 结算一杆；客户端在其后带 X-Fishing-Run-Snapshot-Key 调 /api/fishing/sync 领取
//    settlement.mode === "online" 才是在线渔获
//  - 次数耗尽 → refill → 重新 start
//  - 凭证失效由 GameClient 内部续期/重登；这里只做节拍循环与异常退避
//
// ★ 循环本体不在这个文件里：它在 game/account-runtime.ts 的 tickLoop()。
//   原因：「保持在线」是唯一的时间驱动源，其他模块都挂在它产生的事件上。
//   如果把循环放在模块里，就会出现「模块被停掉但循环还在跑」或者
//   「两个模块各自 sync 抢结算」这类问题。模块只声明配置与开关语义。
import { type ModuleDefinition } from "../types.ts";

const definition: ModuleDefinition = {
  id: "keep-online",
  name: "保持在线",
  version: "2.0.0",
  description:
    "自动开始并持续维持在线钓鱼：按服务器节拍同步渔获，次数耗尽自动补杆，掉线自动重连/重登。这是「在线模式挂机」的核心，关闭后不会产生任何渔获（但仍会运行其他已启用功能）。",
  defaultEnabled: true,
  defaultConfig: {
    autoRefill: true,
    syncJitterMs: 600,
    retrySec: 30,
  },
  configSchema: [
    {
      key: "autoRefill",
      type: "boolean",
      label: "次数耗尽自动补杆",
      hint: "钓鱼次数用完后自动补满并继续（会消耗金币）",
      default: true,
    },
    {
      key: "syncJitterMs",
      type: "number",
      label: "同步抖动（毫秒）",
      hint: "在服务器节拍基础上叠加随机延迟（0.5~1.5 倍），模拟真人节奏。设为 0 则严格按节拍同步。",
      default: 600,
      min: 0,
      max: 3000,
      step: 100,
    },
    {
      key: "retrySec",
      type: "number",
      label: "异常重试间隔（秒）",
      hint: "网络异常或服务端报错后的最大退避间隔，实际按 5→10→20→45→60 秒逐步退避",
      default: 30,
      min: 5,
      max: 300,
      step: 5,
    },
  ],

  async onStart() {
    // 由 AccountRuntime 统一驱动节拍循环
  },

  async onStop() {
    // 由 AccountRuntime 统一停止
  },
};

/**
 * 状态面板的注册不在这里做。
 *
 * 原因：模块图里 account-runtime → modules/registry → keep-online/index → account-runtime 成环，
 * 如果在模块体里调用 account-runtime 导出的注册函数，会命中 `let` 的 TDZ
 * （import 求值发生在模块体之前）。因此注册由 modules/bootstrap.ts 在启动时显式调用。
 */

export default definition;

