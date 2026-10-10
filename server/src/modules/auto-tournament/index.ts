// 自动报名赛事：个人赛 + 公会赛报名，并在开赛前进入比赛地图
//
// 协议：
//  - GET  /api/tournaments/overview        → { current, upcoming: [{ id, sequence, status,
//                                              startAt, canRegister, isRegistered, assignedBiomeId }] }
//  - POST /api/tournaments/{id}/register
//  - GET  /api/guild-tournaments/overview  → 同理，但条目用 entryStatus / canRegister
//  - POST /api/guild-tournaments/{id}/register
//  - GET  /api/guilds/me                   → { membership: { role } }（公会赛只有干部能报名）
//  - PUT  /api/player/current-biome { biomeId }   进比赛地图（免费）
//
// 职责边界：本模块只做「报名 + 比赛进图」。**日常选图交给「自动切图」** ——
// 两边都换图必然互相拽，所以这里不做「没比赛时切到收益最高的地图」。
//
// 与官方航线助手：不看它的开关、不让位（本项目自己负责换图）。
import { type ModuleDefinition } from "../types.ts";
import { sleep } from "../../lib/util.ts";

/** 有资格报名公会赛的公会职位 */
const OFFICER_ROLES = ["officer", "co_leader", "leader"];

const definition: ModuleDefinition = {
  id: "auto-tournament",
  name: "自动报名赛事",
  version: "2.0.0",
  description:
    "自动报名可参加的个人赛与公会赛（公会赛默认关闭，需要干部权限），并在开赛前 / 进行中前往比赛地图。日常选图请交给「自动切图」，两者不要同时负责选图。",
  defaultEnabled: false,
  defaultConfig: {
    registerPersonal: true,
    registerGuild: false,
    travelToBiome: true,
    travelLeadSec: 180,
    checkEveryMin: 3,
  },
  configSchema: [
    { key: "registerPersonal", type: "boolean", label: "自动报名个人赛", default: true },
    {
      key: "registerGuild",
      type: "boolean",
      label: "自动报名公会赛（需干部）",
      hint: "只有公会干部（officer / co_leader / leader）能报名公会赛。默认关闭。",
      default: false,
    },
    {
      key: "travelToBiome",
      type: "boolean",
      label: "自动前往比赛地图",
      hint: "已报名的比赛在开赛前自动进图。官方航线助手开着「自动换图」时此项自动让位。",
      default: true,
    },
    {
      key: "travelLeadSec",
      type: "number",
      label: "开赛前多少秒进入地图",
      default: 180,
      min: 30,
      max: 1800,
      step: 30,
    },
    {
      key: "checkEveryMin",
      type: "number",
      label: "检查间隔（分钟）",
      default: 3,
      min: 1,
      max: 60,
      step: 1,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state as {
      registeredIds: Set<string>;
      lastIdle: string;
      guildRole: string | null;
      guildRoleCheckedAt: number;
      warnedGuildRole: boolean;
    };
    S.registeredIds = new Set<string>();
    S.lastIdle = "";
    S.guildRole = null;
    S.guildRoleCheckedAt = 0;
    S.warnedGuildRole = false;

    const idle = (msg: string) => {
      if (S.lastIdle === msg) return;
      S.lastIdle = msg;
      ctx.log.debug("报名赛事", msg);
    };

    /** 查公会职位（缓存 10 分钟） */
    const getGuildRole = async (): Promise<string | null> => {
      const now = Date.now();
      if (now - S.guildRoleCheckedAt < 10 * 60_000) return S.guildRole;
      S.guildRoleCheckedAt = now;
      try {
        const g = await ctx.api.guildsMe();
        S.guildRole = g?.membership?.role ?? null;
      } catch {
        S.guildRole = null; // 未加入公会或接口异常
      }
      return S.guildRole;
    };

    const run = async (trigger: string) => {
      const leadMs = Math.max(30, Number(ctx.config.travelLeadSec) || 180) * 1000;
      const now = Date.now();

      /* ---------- 个人赛 ---------- */
      let personal: any = null;
      try {
        personal = await ctx.api.tournamentsOverview();
      } catch (err) {
        ctx.log.warn("报名赛事", `读取个人赛失败：${err instanceof Error ? err.message : String(err)}`);
      }

      const personalTargets: any[] = [];
      if (ctx.config.registerPersonal !== false && personal) {
        const all = [personal.current, ...(personal.upcoming ?? [])].filter(Boolean);
        for (const t of all) {
          if (t.canRegister && !t.isRegistered && (t.status === "scheduled" || t.status === "active")) {
            if (!S.registeredIds.has(t.id)) personalTargets.push(t);
          }
        }
      }

      for (const t of personalTargets) {
        try {
          await ctx.api.tournamentRegister(t.id);
          S.registeredIds.add(t.id);
          ctx.log.info("报名赛事", `✅ 已报名个人赛 #${t.sequence}（${t.status === "active" ? "进行中" : "待开赛"}）`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 已经报过 / 无法报名 属于正常情况，标记掉避免反复请求
          if (/ALREADY|已报名|CANNOT|无法/.test(msg)) {
            S.registeredIds.add(t.id);
          }
          ctx.log.warn("报名赛事", `个人赛 #${t.sequence} 报名失败：${msg}`);
        }
      }

      /* ---------- 公会赛（需要干部权限） ---------- */
      let guild: any = null;
      if (ctx.config.registerGuild === true) {
        try {
          guild = await ctx.api.guildTournamentsOverview();
        } catch (err) {
          ctx.log.warn("报名赛事", `读取公会赛失败：${err instanceof Error ? err.message : String(err)}`);
        }

        if (guild) {
          const role = await getGuildRole();
          const isOfficer = role != null && OFFICER_ROLES.includes(String(role));
          if (!isOfficer) {
            if (!S.warnedGuildRole) {
              S.warnedGuildRole = true;
              ctx.log.warn(
                "报名赛事",
                role == null
                  ? "未加入公会（或读不到公会信息），跳过公会赛报名"
                  : `你的公会职位是「${role}」，只有干部（${OFFICER_ROLES.join(" / ")}）能报名公会赛，已跳过`,
              );
            }
          } else {
            const all = [guild.current, ...(guild.upcoming ?? [])].filter(Boolean);
            for (const t of all) {
              if (!t.canRegister || t.entryStatus) continue;
              if (t.status !== "scheduled" && t.status !== "active") continue;
              if (S.registeredIds.has(t.id)) continue;
              try {
                await ctx.api.guildTournamentRegister(t.id);
                S.registeredIds.add(t.id);
                ctx.log.info("报名赛事", `✅ 已报名公会赛 #${t.sequence}（职位 ${role}）`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/ALREADY|已报名|CANNOT|无法|权限/.test(msg)) S.registeredIds.add(t.id);
                ctx.log.warn("报名赛事", `公会赛 #${t.sequence} 报名失败：${msg}`);
              }
            }
          }
        }
      }

      /* ---------- 进比赛地图 ---------- */
      if (ctx.config.travelToBiome === false) return;

      /** 该不该进这张图 */
      const shouldEnter = (t: any, registeredFlag: unknown): boolean => {
        if (!registeredFlag) return false;
        const biomeId = t.assignedBiomeId ?? t.biomeId;
        if (!biomeId) return false;
        if (t.status === "active") return true; // 进行中就进去
        if (t.status === "scheduled" && t.startAt) {
          const at = Date.parse(String(t.startAt));
          return Number.isFinite(at) && at - now <= leadMs;
        }
        return false;
      };

      const candidates: { t: any; kind: string }[] = [];
      if (personal?.current && shouldEnter(personal.current, personal.current.isRegistered)) {
        candidates.push({ t: personal.current, kind: "个人赛" });
      }
      for (const t of personal?.upcoming ?? []) {
        if (shouldEnter(t, t.isRegistered)) candidates.push({ t, kind: "个人赛" });
      }
      if (guild?.current && shouldEnter(guild.current, guild.current.entryStatus)) {
        candidates.push({ t: guild.current, kind: "公会赛" });
      }
      for (const t of guild?.upcoming ?? []) {
        if (shouldEnter(t, t.entryStatus)) candidates.push({ t, kind: "公会赛" });
      }

      if (!candidates.length) {
        idle(`${trigger}：没有需要进图的比赛`);
        return;
      }

      // 只看当前是否已在该地图，避免重复请求
      const biomesData = await ctx.api.biomes();
      const biomes: any[] = biomesData?.biomes ?? [];
      const currentBiomeId = biomes.find((b) => b.isCurrent)?.id ?? null;

      for (const { t, kind } of candidates) {
        const biomeId = t.assignedBiomeId ?? t.biomeId;
        if (biomeId === currentBiomeId) continue;
        try {
          await ctx.api.biomeTravel(biomeId);
          const name = biomes.find((b) => b.id === biomeId)?.name ?? biomeId;
          ctx.log.info(
            "报名赛事",
            `⛵ 已进入${kind} #${t.sequence} 的比赛地图：${name}` +
              (t.status === "active" ? "（比赛进行中）" : "（开赛前）"),
          );
        } catch (err) {
          ctx.log.warn("报名赛事", `进入比赛地图失败：${err instanceof Error ? err.message : String(err)}`);
        }
        // 两场比赛的地图可能不同，稍作间隔
        await sleep(1200);
      }
    };

    const everyMin = Math.max(1, Number(ctx.config.checkEveryMin) || 3);
    ctx.every(everyMin * 60_000, () => run("定时检查"));
    ctx.schedule(25_000, () => run("启动检查"));
  },
};

export default definition;
