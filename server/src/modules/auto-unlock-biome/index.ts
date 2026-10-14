// 自动解锁地图：按等级与金币条件，逐张把还没解锁的地图买下来
//
// 协议：
//  - GET  /api/biomes                → { biomes: [{ id, name, isUnlocked, requiredLevel?, unlockCost? }] }
//  - GET  /api/me                    → player.gold / player.level
//  - POST /api/biomes/{id}/unlock    → 扣金币解锁（要求同时满足等级与金币）
//
// ★ 为什么值得做：地图是**永久**资产（转生也保留），而解锁是纯花金币的一次性动作 ——
//   手动一张张点既麻烦又容易忘；挂机期间顺手解锁，越早解锁越早吃到更高的鱼价值倍率。
//
// ★ 安全设计（花出去就退不回来，所以处处留说明与刹车）：
//   · 只解锁**等级已满足**的图（等级不够时游戏也会拒绝，这里先跳过并写清「还差多少级」）；
//   · 每次检查最多解锁 maxPerRun 张（默认 1），检查间隔默认 5 分钟 ——
//     不会一口气把金币花光，每一步都在日志里留痕；
//   · 可选「单个地图花费上限」与「保留金币」两道刹车（默认 0 = 不启用）；
//   · dryRun 干跑：只说会解锁哪张、要花多少，不动金币；
//   · 解锁顺序：先按所需等级、再按花费，从低到高（先便宜的先拿）。
import { type ModuleDefinition } from "../types.ts";
import { biomeUnlockInfo } from "../shared/biomes.ts";

/** 一次检查里最多解锁几张（默认 1，配置可调） */
const DEFAULT_MAX_PER_RUN = 1;

const definition: ModuleDefinition = {
  id: "auto-unlock-biome",
  name: "自动解锁地图",
  version: "1.0.0",
  description:
    "按等级与金币条件自动解锁还没买的地图（解锁会直接扣金币、不可退回，且地图永久保留、转生也不丢）。每次检查默认只解锁一张，按所需等级从低到高来。建议先开「干跑」看一轮它会解锁哪张、花多少钱。",
  defaultEnabled: false,
  defaultConfig: {
    maxPerRun: DEFAULT_MAX_PER_RUN,
    maxCostPerBiome: 0,
    goldReserve: 0,
    checkEveryMin: 5,
    dryRun: false,
  },
  configSchema: [
    {
      key: "maxPerRun",
      type: "number",
      label: "每次检查最多解锁几张",
      hint: "默认 1 张：一步一步来，不会一口气把金币花光（每张都会写进日志）。",
      default: DEFAULT_MAX_PER_RUN,
      min: 1,
      max: 15,
      step: 1,
    },
    {
      key: "maxCostPerBiome",
      type: "number",
      label: "单个地图花费上限（0 = 不限制）",
      hint: "想留点金币周转就设一个上限：超过这个价格的地图会被跳过（等以后手动买或调高上限）。",
      default: 0,
      min: 0,
      max: 100_000_000,
      step: 100_000,
    },
    {
      key: "goldReserve",
      type: "number",
      label: "保留金币不下手（0 = 不保留）",
      hint: "解锁后余额不能低于这个数：例如填 100 万，就不会把最后一点家底花在开图上。",
      default: 0,
      min: 0,
      max: 100_000_000,
      step: 100_000,
    },
    {
      key: "checkEveryMin",
      type: "number",
      label: "检查间隔（分钟）",
      default: 5,
      min: 1,
      max: 360,
      step: 1,
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "只报告不动作（干跑）",
      hint: "打开后只在日志里写「本该解锁哪张、要花多少金币」，不动金币。",
      default: false,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as { running: boolean; lastIdle: string };
    S.running = false;
    S.lastIdle = "";

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("解锁地图", msg);
    };
    /** 同一句「这次没解锁」的说明只记一次：变化时用 info，长期一样时降级为 debug */
    const noted = new Set<string>();
    const idleOnce = (key: string, msg: string) => {
      if (noted.has(key)) {
        idle(msg);
        return;
      }
      noted.add(key);
      S.lastIdle = msg;
      ctx.log.info("解锁地图", msg);
    };

    const n = (v: unknown) => {
      const num = Number(v);
      return Number.isFinite(num) ? num : 0;
    };

    const run = async (trigger: string) => {
      if (S.running) return;
      S.running = true;
      try {
        const [biomesData, me] = await Promise.all([ctx.api.biomes(), ctx.api.me()]);
        const biomes: any[] = (biomesData?.biomes ?? []).filter(Boolean);
        if (!biomes.length) {
          idle(`${trigger}：地图数据尚未就绪`);
          return;
        }

        const gold = n(me?.player?.gold);
        const level = n(me?.player?.level);
        const maxCost = Math.max(0, n(ctx.config.maxCostPerBiome));
        const reserve = Math.max(0, n(ctx.config.goldReserve));
        const maxPerRun = Math.max(1, Math.floor(n(ctx.config.maxPerRun) || DEFAULT_MAX_PER_RUN));
        const dryRun = ctx.config.dryRun === true;

        /** 还没解锁的图（带上等级/花费/名字） */
        const locked = biomes
          .filter((b) => b.isUnlocked === false)
          .map((b) => {
            const info = biomeUnlockInfo(b);
            return { id: String(b.id ?? ""), name: String(b.name ?? b.id ?? "未知"), ...info };
          })
          .filter((b) => b.id);

        if (!locked.length) {
          noted.clear();
          idleOnce("all-unlocked", `${trigger}：所有地图都已解锁（共 ${biomes.length} 张）`);
          return;
        }

        // 先按所需等级、再按花费，从低到高：先便宜的先拿
        locked.sort((a, b) => a.requiredLevel - b.requiredLevel || a.unlockCost - b.unlockCost);

        const buyable: typeof locked = [];
        const skipped: string[] = [];
        for (const b of locked) {
          if (level < b.requiredLevel) {
            skipped.push(`${b.name}（需 Lv ${b.requiredLevel}，当前 Lv ${Math.floor(level)}）`);
            continue;
          }
          if (maxCost > 0 && b.unlockCost > maxCost) {
            skipped.push(`${b.name}（${fmt(b.unlockCost)} 超过单价上限 ${fmt(maxCost)}）`);
            continue;
          }
          if (gold - b.unlockCost < reserve) {
            skipped.push(`${b.name}（需 ${fmt(b.unlockCost)}，余额 ${fmt(gold)}${reserve ? `，要留 ${fmt(reserve)}` : ""}）`);
            continue;
          }
          buyable.push(b);
        }

        if (!buyable.length) {
          idleOnce(
            `none:${locked.length}:${Math.floor(level)}:${Math.floor(gold / 100_000)}`,
            `${trigger}：暂时没有可解锁的地图（金币 ${fmt(gold)}，Lv ${Math.floor(level)}）｜` +
              skipped.slice(0, 3).join("；") +
              (skipped.length > 3 ? ` 等 ${skipped.length} 张` : ""),
          );
          return;
        }

        const plan = buyable.slice(0, maxPerRun);
        if (dryRun) {
          ctx.log.info(
            "解锁地图",
            `[干跑] 本该解锁 ${plan.length} 张：` +
              plan.map((b) => `${b.name}（${fmt(b.unlockCost)}）`).join("、") +
              `；余额 ${fmt(gold)}，当前 Lv ${Math.floor(level)}` +
              (buyable.length > plan.length ? `；另有 ${buyable.length - plan.length} 张条件也满足` : ""),
          );
          return;
        }

        /* ---------- 真正解锁 ---------- */
        let spent = 0;
        let done = 0;
        for (const b of plan) {
          try {
            await ctx.api.biomeUnlock(b.id);
            spent += b.unlockCost;
            done += 1;
            S.lastIdle = "";
            ctx.log.info(
              "解锁地图",
              `🔓 已解锁「${b.name}」（花费 ${fmt(b.unlockCost)} 金币，约剩 ${fmt(Math.max(0, gold - spent))}）` +
                `｜还需 Lv ${b.requiredLevel}`,
            );
          } catch (err) {
            // 金币/等级被服务端拒绝、或网络错误：如实写下来，下一轮再看
            ctx.log.warn(
              "解锁地图",
              `解锁「${b.name}」失败：${err instanceof Error ? err.message : String(err)}`,
            );
            // 同一轮里继续试下一张没有意义（多半是余额/等级这类共性问题），直接结束本轮
            break;
          }
        }

        if (done && buyable.length > done) {
          ctx.log.info(
            "解锁地图",
            `本轮解锁 ${done} 张，还有 ${buyable.length - done} 张条件满足（下次检查继续）`,
          );
        }
      } catch (err) {
        ctx.log.warn("解锁地图", `${trigger} 失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        S.running = false;
      }
    };

    const everyMin = Math.max(1, Number(ctx.config.checkEveryMin) || 5);
    ctx.every(everyMin * 60_000, () => void run("定时检查"));
    // 启动后先看一眼（错开别的模块：不抢首轮登录）
    ctx.schedule(40_000, () => run("启动检查"));

    ctx.log.info(
      "解锁地图",
      `已启动：每 ${everyMin} 分钟检查一次，每次最多解锁 ${Math.max(1, Math.floor(n(ctx.config.maxPerRun) || DEFAULT_MAX_PER_RUN))} 张` +
        (ctx.config.dryRun === true ? "（干跑：只报告不动金币）" : ""),
    );
  },
};

/** 金币数值：三位一逗号（日志里好读） */
function fmt(v: number): string {
  return Math.round(v).toLocaleString("zh-CN");
}

export default definition;
