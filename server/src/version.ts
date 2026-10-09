// 版本与更新记录
//
// 这是**面向用户**的更新日志：只写用户能感知的变化（新增了什么、修了什么毛病），
// 不写内部重构、字段改名这类只有维护者关心的事。
// 详细的技术变更仍看 git log 与 docs/。
//
// 约定：
//  · 数组按版本从新到旧排列，第一项必须是当前版本
//  · version 与 package.json 的 version 保持一致（VERSION 常量见本文件）
//  · date 用 ISO 日期（YYYY-MM-DD）
//  · 发版时在数组最前面追加一项

/** 当前版本（与 package.json 的 version 同步维护） */
export const VERSION = "1.0.0";

export type ChangeKind = "feature" | "improve" | "fix";

export type ChangelogEntry = {
  version: string;
  date: string;
  /** 一句话概括这个版本 */
  title: string;
  /** 是否有破坏性变更/需要用户操作的项 */
  notice?: string;
  changes: { kind: ChangeKind; text: string }[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.0",
    date: "2026-10-09",
    title: "首个正式版本",
    changes: [
      { kind: "feature", text: "多用户挂机平台：每个用户管理自己的游戏账号，互相看不到彼此的数据" },
      { kind: "feature", text: "每个账号可绑定独立代理（HTTP / HTTPS / SOCKS5），配置前能先测连通性与出口 IP" },
      {
        kind: "feature",
        text: "内置 12 项功能：保持在线、每日签到、自动加点、自动献祭、自动切图、保底切图、自动换饵、赛事报名、围猎参战、自动卖装备、自动 Buff、收益日报",
      },
      { kind: "feature", text: "保底切图：监控奇异鱼 / 奥秘鱼保底进度，快触发时切到指定地图，出货后切回原图" },
      { kind: "feature", text: "消息推送：Server酱 与微信机器人（可双向，在微信里发「日报」「状态」等命令）" },
      { kind: "feature", text: "收益日报：每天定时汇总净收益、鱼获、掉落、比赛与围猎结果" },
      { kind: "feature", text: "实时状态：地图、天气、经验加成构成、等级与经验进度、转生进度、保底进度" },
      { kind: "feature", text: "后台管理：仪表盘、用户管理、邀请码、在线设置、系统状态、在线更新" },
      { kind: "feature", text: "在线更新：后台点一下即可拉取新版本并重启，更新过程有进度提示" },
      { kind: "improve", text: "注册只需用户名与口令，不再要求邮箱" },
      { kind: "improve", text: "后台设置可在线修改（注册开关、账号额度、并发上限等），改完立即生效，不用重启" },
      { kind: "improve", text: "全站视觉与动效统一，支持亮色 / 暗色主题" },
      { kind: "fix", text: "修复自动换饵会反复购买鱼饵的问题（余量字段读错，导致每次检查都买一批）" },
      { kind: "fix", text: "修复管理员用 admin 登录时被提示「邮箱格式不正确」的问题" },
      { kind: "fix", text: "修复数据库迁移遗漏：已有实例升级后缺少新表，导致启动报错" },
    ],
  },
];

/** 当前版本条目 */
export function currentRelease(): ChangelogEntry {
  const first = CHANGELOG[0];
  if (!first) throw new Error("CHANGELOG 不能为空");
  return first;
}

/** 是否存在比 given 更新的版本（用于给用户显示「有新版本」） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
