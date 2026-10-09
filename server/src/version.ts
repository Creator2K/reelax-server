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
export const VERSION = "1.1.0";

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
    version: "1.1.0",
    date: "2026-10-10",
    title: "日报可自定义、微信绑定更安全、支持手机",
    notice: "微信推送通道改用「验证码确认」绑定：如果你之前已绑定，需要重新用微信给机器人发一条消息并按提示回发验证码。",
    changes: [
      {
        kind: "feature",
        text: "日报改为模板驱动：给一份默认模板，想改哪项就改，34 个变量点一下就插到光标处（净收益、收入、鱼饵消耗、各档鱼获、掉落、经验、等级、转生缺口、比赛名次、围猎战果、保底进度…）",
      },
      { kind: "feature", text: "日报模板实时预览：改完立刻看到推送出来长什么样，写错的变量会当场提示" },
      { kind: "improve", text: "日报某一行里的变量当天没数据（例如没打比赛）时，整行自动消失，不用手写条件" },
      { kind: "improve", text: "日报区分「看量级」与「看准确值」的数字：金币用万/亿，等级与条数用精确值" },
      {
        kind: "feature",
        text: "微信绑定加验证码：给机器人发消息后会收到 6 位验证码，把验证码发回去才算绑定成功，防止别人误绑定",
      },
      { kind: "feature", text: "支持手机浏览器访问：侧边栏改为抽屉式，页面与按钮针对触屏做了适配" },
      { kind: "feature", text: "后台改版为四个页签（概览 / 用户 / 邀请码 / 设置），系统信息与在线更新并入概览与设置，不再零散" },
      { kind: "feature", text: "用户管理可编辑：改显示名、给某人单独设置账号额度（留空则跟随全局默认）" },
      {
        kind: "fix",
        text: "修复微信推送重启后再也连不上的问题（重启后不会自动重新登录，界面显示已绑定但发消息报未登录）",
      },
      { kind: "fix", text: "修复微信连接卡死：登录无超时时会永久停在「正在连接」，现在会超时重试并在失败时说明原因" },
      { kind: "improve", text: "推送设置里新增「重新连接」，可以在不重新扫码的情况下恢复连接" },
      { kind: "improve", text: "发送失败时显示真实原因，不再是笼统的「未登录」" },
    ],
  },
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
