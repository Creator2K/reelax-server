// 审计记录的「人话」描述（纯函数，便于单测）
//
// 为什么放在服务端：要把 target / detail 里的 id 解析成名字（账号标签、功能名称、用户），
// 这些只有服务端拿得到。前端此前自己维护了一份映射表，但键名与 AUDIT_ACTIONS 对不上
// （写的是 user.register / admin.user.status_changed 之类），于是绝大多数动作直接显示
// 原始码（account.module.updated），看起来像天书。
//
// 约定：
//  · 未收录的动作**原样返回**（宁可显示原始码，也不丢信息）；
//  · target 解析不出来时保留原始 id（追查时仍然有用）。

export type AuditLike = {
  action: string;
  target: string | null;
  detail_json: string | null;
};

export type AuditResolvers = {
  /** 账号 id → 标签 */
  accountLabel?: (id: string) => string | null;
  /** 功能 id → 名称（auto-bait → 自动换饵） */
  moduleName?: (id: string) => string | null;
  /** 用户 id → 显示名/邮箱 */
  userName?: (id: string) => string | null;
};

const quote = (s: string) => `「${s}」`;

/** 解析账号 id → 可读名称（解析不到就退回 id） */
function accountText(id: string, r: AuditResolvers): string {
  return quote(r.accountLabel?.(id) || id);
}

function moduleText(id: string, r: AuditResolvers): string {
  return quote(r.moduleName?.(id) || id);
}

/** 把 detail_json 里的信息压成一句补充说明 */
function detailNote(raw: string | null): string {
  if (!raw) return "";
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "";
  }
  if (!d || typeof d !== "object") return "";
  if (d.reset === true) return "（恢复默认配置）";
  // 手动换图：把目标地图与是否带队说清楚
  if (typeof d.mapName === "string" && d.mapName) {
    return `（切到「${d.mapName}」${d.mode === "party" ? "，带队一起走" : ""}）`;
  }
  const parts: string[] = [];
  if (d.enabled === true) parts.push("启用");
  else if (d.enabled === false) parts.push("关闭");
  if (Array.isArray(d.keys) && d.keys.length) parts.push(`改配置 ${d.keys.length} 项`);
  return parts.length ? `（${parts.join("、")}）` : "";
}

/** 读 detail_json 里的一个布尔/字符串字段（解析失败返回 null） */
function detailJsonFlag(row: AuditLike, key: string): string | null {
  try {
    const d = JSON.parse(String(row?.detail_json ?? "")) as Record<string, unknown>;
    const v = d?.[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** detail_json → 对象（解析失败返回空对象） */
function detailObject(row: AuditLike): Record<string, unknown> {
  try {
    const d = JSON.parse(String(row?.detail_json ?? ""));
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 审计动作 → 一句中文描述 */
export function describeAudit(row: AuditLike, r: AuditResolvers = {}): string {
  const action = String(row?.action ?? "");
  const target = row?.target ?? null;
  const note = detailNote(row?.detail_json ?? null);

  // 账号 + 功能：target 是 "账号 id:功能 id"
  if (action === "account.module.updated") {
    const [accountId = "", moduleId = ""] = String(target ?? "").split(":");
    return `修改账号${accountText(accountId, r)}的功能${moduleText(moduleId, r)}${note}`;
  }

  switch (action) {
    // ---- 认证 / 个人资料 ----
    case "auth.login.ok":
      return "登录成功";
    case "auth.login.fail":
      return "登录失败";
    case "auth.logout":
      return "退出登录";
    case "auth.register":
      return "注册账号";
    case "auth.password.changed":
      return "修改口令（已注销其它会话）";
    case "auth.profile.changed":
      return "修改个人资料";

    // ---- 管理员的用户操作 ----
    case "admin.user.approved":
      return `启用用户${quote(r.userName?.(target ?? "") || target || "")}`;
    case "admin.user.rejected":
      return `拒绝用户${quote(r.userName?.(target ?? "") || target || "")}`;
    case "admin.user.banned":
      return `封禁用户${quote(r.userName?.(target ?? "") || target || "")}`;
    case "admin.user.status":
      return `调整用户${quote(r.userName?.(target ?? "") || target || "")}的状态`;
    case "admin.user.role":
      return `调整用户${quote(r.userName?.(target ?? "") || target || "")}的角色`;
    case "admin.seeded":
      return "创建初始管理员";

    // ---- 邀请码 ----
    case "admin.invite.created":
      return `生成邀请码${target ? quote(target) : ""}`;
    case "admin.invite.deleted":
      return `删除邀请码${target ? quote(target) : ""}`;

    // ---- 账号 ----
    case "account.created":
      return `创建账号${accountText(target ?? "", r)}`;
    case "account.updated":
      return `修改账号${accountText(target ?? "", r)}的设置${note}`;
    case "account.deleted":
      return `删除账号${accountText(target ?? "", r)}`;
    case "account.started":
      return `启动账号${accountText(target ?? "", r)}`;
    case "account.stopped":
      return `停止账号${accountText(target ?? "", r)}`;
    case "account.travel":
      return `手动切换账号${accountText(target ?? "", r)}的所在地图${note}`;
    case "account.party.join":
      return `让账号${accountText(target ?? "", r)}用邀请码加入船队`;
    case "account.party.leave":
      return `让账号${accountText(target ?? "", r)}离开船队`;
    case "account.party.invitation":
      return `让账号${accountText(target ?? "", r)}${detailJsonFlag(row, "action") === "accept" ? "接受" : "拒绝"}组队邀请`;
    case "account.party.member": {
      const act = detailJsonFlag(row, "action") ?? "";
      const who = detailJsonFlag(row, "member") ?? "某成员";
      const text =
        act === "remove" ? "移出成员" : act === "captain" ? "转让船长给" : act === "role:helmsman" ? "任命舵手" : "撤销舵手";
      return `在账号${accountText(target ?? "", r)}的船队里${text} ${who}`;
    }
    case "account.credentials.updated":
      return `更新账号${accountText(target ?? "", r)}的登录凭证`;

    // ---- 以物易物（交换任务） ----
    case "account.barter.task": {
      const d = detailObject(row);
      const from = typeof d.from === "string" && d.from ? d.from : "起点鱼";
      const to = typeof d.to === "string" && d.to ? d.to : "目标鱼";
      const quantity = typeof d.quantity === "number" ? d.quantity : null;
      return d.op === "cancel"
        ? `取消账号${accountText(target ?? "", r)}的以物易物任务「${from} → ${to}」`
        : `给账号${accountText(target ?? "", r)}新增以物易物任务「${from} → ${to}」${quantity ? `，目标 ${quantity} 条` : ""}`;
    }

    // ---- 代理 ----
    case "proxy.created":
      return `添加代理${target ? quote(target) : ""}`;
    case "proxy.updated":
      return `修改代理${target ? quote(target) : ""}`;
    case "proxy.deleted":
      return `删除代理${target ? quote(target) : ""}`;
    case "proxy.tested":
      return `测试代理${target ? quote(target) : ""}的连通性`;

    default:
      // 未收录：原样返回原始码，不丢信息
      return target ? `${action}（${target}）` : action;
  }
}
