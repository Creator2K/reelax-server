// 定时挂机：按时间表自动启动 / 停止这个账号
//
// ★★ 这个模块本身**不执行启停**，它只是配置入口。真正干活的是服务端调度器
//    （services/account-schedule-service.ts，每 30 秒扫一次这张时间表）。
//
//    为什么必须放在服务端：账号一旦被停掉，本模块的定时器也跟着停了 ——
//    靠模块自己永远起不来。所以调度器直接读数据库里的这份配置（
//    account_modules 的 auto-schedule 行），账号停着也照样到点启动。
//
//    对用户的可见差异：这个开关打开、时间表写好之后，**账号是否在跑由时间表决定**，
//    与「自动启动」（账号自身的 auto_start）无关；时间表优先级更高。
//
// 语义（与服务端调度器一致，别在这里另搞一套）：
//   1) 「到点生效」的里程碑：当前档 = 时间 ≤ 现在的最后一条，今天没到就用昨天的最后一条
//   2) **只在跨过新的一档时执行一次**，不在两档之间反复对齐状态 ——
//      这样你手动点了「停止」，它会一直停到下一档，而不是半分钟就被拉起来
//   3) 服务重启后会按当前这一档重新对齐一次（避免该跑的时候一直不跑）
import { type ModuleDefinition } from "../types.ts";
import { parseSchedulePlan, pickSchedulePlanEntry } from "./plan.ts";

const definition: ModuleDefinition = {
  id: "auto-schedule",
  name: "定时挂机",
  version: "1.0.0",
  description:
    "按时间表自动启动 / 停止这个账号（例如 08:00 开、02:00 关）。★ 时间表由服务端读取：账号已经停了也照样到点启动。只在跨过新的一档时执行一次，两档之间你手动启停不会被覆盖。",
  defaultEnabled: false,
  defaultConfig: {
    plan: "",
    dryRun: false,
  },
  configSchema: [
    {
      key: "plan",
      type: "textarea",
      label: "启停时间表",
      hint:
        "每行一条：「HH:MM on」启动账号，「HH:MM off」停止账号。\n" +
        "语义是「到点生效」：当前档取时间 ≤ 现在的最后一条，今天还没到第一条则沿用昨天的最后一条。\n" +
        "空行与以 # 开头的注释行会被忽略。留空 = 不按时间表启停（账号该跑就跑）。",
      default: "",
      placeholder: "08:00 on\n02:00 off",
    },
    {
      key: "dryRun",
      type: "boolean",
      label: "演练模式（只记录，不启停）",
      hint: "第一次用建议先开一天，确认到点该开该关都对得上再关掉。",
      default: false,
    },
  ],

  async onStart(ctx) {
    // 只负责把这份时间表讲清楚：真正的启停由服务端调度器做（见文件头说明）
    const { entries, errors } = parseSchedulePlan(ctx.config.plan);
    for (const err of errors) ctx.log.warn("定时挂机", err);

    if (ctx.config.dryRun === true) {
      ctx.log.info("定时挂机", "演练模式已开启：到点只会记录，不会真的启停账号");
    }
    if (entries.length) {
      const cur = pickSchedulePlanEntry(entries, new Date());
      ctx.log.info(
        "定时挂机",
        `时间表 ${entries.length} 条：${entries.map((e) => `${e.at}→${e.on ? "开" : "关"}`).join("，")}；` +
          `现在该是「${cur ? (cur.on ? "运行中" : "已停止") : "无"}」。` +
          `（启停由服务端执行：账号停着也会到点启动；两档之间手动启停不会被覆盖）`,
      );
    } else {
      ctx.log.info("定时挂机", "时间表为空，本功能不会启停账号");
    }
  },
};

export default definition;
