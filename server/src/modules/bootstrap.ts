// 模块启动引导：把「模块 → 运行时」的注入集中在一处
//
// 为什么需要这个文件：模块图里存在环
//   game/account-runtime → modules/registry → modules/keep-online/index → game/account-runtime
// 如果让 keep-online 在**模块体**里调用 registerStatusPanelBuilder，就会命中 `let` 的 TDZ
// （ESM 的 import 求值发生在模块体执行之前）。
//
// 解法：由 index.ts 在装载完成后显式调用 bootstrapModules() 做一次性注入。
// 这样运行时不需要 import 任何模块，模块也不需要 import 运行时的值（只需要它的类型）。
import { registerStatusPanelBuilder } from "../game/account-runtime.ts";
import { buildStatusPanel } from "./keep-online/status-panel.ts";

let done = false;

export function bootstrapModules(): void {
  if (done) return;
  done = true;

  // 状态面板：保持在线负责汇总地图 / 经验加成 / 等级资源 / 保底进度
  registerStatusPanelBuilder((state, rt) =>
    buildStatusPanel({
      state,
      biomesById: rt.biomes,
      me: rt.me,
      reincarnation: rt.reincarnation,
      bait: rt.bait,
      // 保底数据（奇异/奥秘硬保底、奥术宝箱、灯塔神器）
      statistics: rt.statistics,
      chests: rt.chests,
      lighthouse: rt.lighthouse,
      // 同步健康度（近 10 分钟成功率 / 超时次数）：判断「结算变少」是不是链路问题
      sync: rt.syncStats,
      // 经验速率（近 30 分钟每小时经验 + 升级预计时间）：判断「这样挂多久能升级」
      xp: rt.xpRate,
    }) as unknown as Record<string, unknown>,
  );
}
