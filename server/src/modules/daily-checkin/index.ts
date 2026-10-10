// 每日签到：每天领取签到奖励
//
// 游戏日为北京时间；重复领只会返回 409 ALREADY_CLAIMED，所以整体是幂等操作。
//
// 与官方航线助手：本项目**自己签到**（助手那套要开着游戏页面才会执行，而且它做的
// 也是同一个 /api/daily-check-in/claim —— 没有额外能力），因此不看它的开关。
import { type ModuleDefinition } from "../types.ts";

const definition: ModuleDefinition = {
  id: "daily-checkin",
  name: "每日签到",
  version: "2.0.0",
  description:
    "每天自动领取签到奖励，不会漏签。",
  defaultEnabled: false,
  defaultConfig: {
    checkEveryMin: 10,
  },
  configSchema: [
    {
      key: "checkEveryMin",
      type: "number",
      label: "兜底检查间隔（分钟）",
      hint: "额外隔多久检查一次是否已签到，长时间没渔获也不会漏签。",
      default: 10,
      min: 5,
      max: 120,
      step: 5,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      lastClaimedDay: string | null;
      lastCheckAt: number;
      busy: boolean;
    };
    S.lastClaimedDay = null;
    S.lastCheckAt = 0;
    S.busy = false;

    /** 北京时间的本地日（游戏日按北京时间算） */
    const beijingDay = (): string => {
      const now = new Date();
      // 用 UTC+8 偏移算出北京日
      const t = new Date(now.getTime() + 8 * 3_600_000);
      return t.toISOString().slice(0, 10);
    };

    const check = async (trigger: string, minIntervalMs = 0) => {
      const now = Date.now();
      // 「钓鱼同步」这个触发源每 6 秒就来一次，必须节流，否则会疯狂请求签到接口
      if (minIntervalMs > 0 && now - S.lastCheckAt < minIntervalMs) return;
      if (S.busy) return;
      S.lastCheckAt = now;
      S.busy = true;
      try {
        const day = beijingDay();
        if (S.lastClaimedDay === day) return; // 今天本进程已领过

        const status = await ctx.api.dailyCheckInStatus();
        if (status?.checkedInToday) {
          S.lastClaimedDay = day;
          return; // 已经签过了（可能是官方助手签的），不重复请求
        }

        const r = await ctx.api.dailyCheckInClaim();
        S.lastClaimedDay = day;
        const streak = r?.currentStreak ?? status?.currentStreak;
        ctx.log.info("每日签到", `${trigger}：签到成功${streak ? `（连续 ${streak} 天）` : ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 409 / ALREADY_CLAIMED 属于正常情况（零点边界或官方助手抢先），不算错误
        if (/ALREADY_CLAIMED/i.test(msg) || /已领取|已签到/.test(msg)) {
          S.lastClaimedDay = beijingDay();
          return;
        }
        ctx.log.warn("每日签到", `${trigger} 失败：${msg}`);
      } finally {
        S.busy = false;
      }
    };

    const everyMin = Math.max(5, Number(ctx.config.checkEveryMin) || 10);

    // 启动后稍等再检查（避免和登录/首轮钓鱼抢请求）
    ctx.schedule(60_000, () => check("启动检查"));

    // 兜底轮询
    ctx.every(everyMin * 60_000, () => check("定时检查"));

    // 每次钓鱼结算后顺便看一眼是否跨天（节流 5 分钟，避免每 6 秒请求一次）
    ctx.on("fishing:sync", () => {
      void check("钓鱼同步", 5 * 60_000);
    });
  },
};

export default definition;
