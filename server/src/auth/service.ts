// 认证服务：注册（首个用户成管理员 / 邀请码 / 待审批）、登录、注销、改口令
import { randomBytes } from "node:crypto";
import type { Env } from "../env.ts";
import type { Repos } from "../db/repositories/index.ts";
import { AUDIT_ACTIONS } from "../db/repositories/audit.ts";
import type { UserRow, UserRole, UserStatus } from "../db/repositories/users.ts";
import { hashToken } from "../db/repositories/auth-sessions.ts";
import { burnTimeLikeVerify, hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from "../security/password.ts";
import { HttpError, badRequest, conflict, forbidden, unauthorized } from "../api/server.ts";
import type { Logger } from "../lib/logger.ts";

export type ApiUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  /** 账号配额（用于前端提前提示，而不是等提交才报错） */
  accountCount?: number;
  accountLimit?: number;
};

export type SessionToken = { token: string; sessionId: string; expiresAt: number };

/** 只依赖用到的几个限流器，便于测试注入假实现 */
export type AuthLimiterLike = {
  hit: (key: string) => { allowed: boolean; retryAfterMs: number };
  reset: (key: string) => void;
};

export type AuthDeps = {
  repos: Repos;
  env: Pick<Env, "sessionTtlDays" | "maxAccountsPerUser" | "allowRegistration">;
  limiter: {
    login: AuthLimiterLike;
    loginByIp: AuthLimiterLike;
    register: AuthLimiterLike;
    inviteGuess: AuthLimiterLike;
    passwordChange: AuthLimiterLike;
  };
  logger: Logger;
};

export class AuthService {
  private repos: Repos;
  private ttlMs: number;
  private maxAccounts: number;
  private allowRegistration: boolean;
  private limiter: AuthDeps["limiter"];
  private log: Logger;

  constructor(deps: AuthDeps) {
    this.repos = deps.repos;
    this.ttlMs = deps.env.sessionTtlDays * 86_400_000;
    this.maxAccounts = deps.env.maxAccountsPerUser;
    this.allowRegistration = deps.env.allowRegistration;
    this.limiter = deps.limiter;
    this.log = deps.logger;
  }

  /* ---------- 序列化 ---------- */

  toApi(row: UserRow): ApiUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      createdAt: Number(row.created_at),
      lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
      accountCount: this.repos.accounts.countForUser(row.id),
      accountLimit: this.maxAccounts,
    };
  }

  /** 公开的注册状态（登录页/注册页用，不需要鉴权） */
  publicSystemInfo(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      allowRegistration: this.allowRegistration,
      maxAccountsPerUser: this.maxAccounts,
      hasUsers: this.repos.users.countAll() > 0,
      ...extra,
    };
  }

  /* ---------- 注册 ---------- */

  /** 注册：首个用户直接成为已审批管理员；其余凭邀请码注册并等待审批 */
  async registerAsync(input: {
    email: string;
    password: string;
    displayName: string;
    inviteCode?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ user: ApiUser; becameAdmin: boolean; token: SessionToken }> {
    const email = input.email.trim();
    const displayName = input.displayName.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    }
    if (!displayName) throw badRequest("请填写显示名", "INVALID_DISPLAY_NAME");
    if (displayName.length > 40) throw badRequest("显示名最多 40 个字符", "INVALID_DISPLAY_NAME");

    const strength = validatePasswordStrength(input.password);
    if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");

    const rl = this.limiter.register.hit(input.ip ?? "unknown");
    if (!rl.allowed) {
      throw new HttpError(429, "RATE_LIMITED", `注册过于频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试。`);
    }

    if (this.repos.users.existsEmail(email)) {
      throw conflict("该邮箱已注册", "EMAIL_TAKEN");
    }

    const isFirstUser = this.repos.users.countAll() === 0;
    let consumedInvite: string | null = null;

    if (!isFirstUser) {
      if (!this.allowRegistration) {
        throw forbidden("本服务已关闭自助注册，请联系管理员创建账号。", "REGISTRATION_DISABLED");
      }
      // ★ 邀请码是唯一的注册门槛：用对了就能直接使用，不需要管理员审批。
      //   （审批环节已移除，避免「注册完还要等人点一下」这种体验）
      const code = input.inviteCode?.trim();
      if (!code) throw badRequest("需要邀请码才能注册", "INVITE_REQUIRED");

      const guess = this.limiter.inviteGuess.hit(input.ip ?? "unknown");
      if (!guess.allowed) throw new HttpError(429, "RATE_LIMITED", "邀请码尝试过于频繁，请稍后再试。");

      const invite = this.repos.invites.findByCode(code);
      if (!invite) throw badRequest("邀请码无效", "INVITE_INVALID");
      const usable = this.repos.invites.isUsable(invite);
      if (!usable.ok) throw badRequest(usable.reason, "INVITE_UNUSABLE");

      if (!this.repos.invites.consume(code)) {
        throw badRequest("邀请码已用尽或已过期", "INVITE_UNUSABLE");
      }
      consumedInvite = code;
    }

    const passwordHash = await hashPassword(input.password);

    let row: UserRow;
    try {
      row = this.repos.users.create({
        email,
        passwordHash,
        displayName,
        // 首个注册者是管理员；其余为普通用户。
        // ★ 两者都是 approved —— 注册即可用（邀请码已是门槛），
        //   管理员只保留「封禁 / 解封」能力，不再需要逐个审批。
        role: isFirstUser ? "admin" : "user",
        status: "approved",
        approvedBy: null,
      });
    } catch (err) {
      // 创建失败时把邀请码还回去（不要让用户白丢一个码）
      if (consumedInvite) this.refundInvite(consumedInvite);
      if (String(err).includes("UNIQUE")) throw conflict("该邮箱已注册", "EMAIL_TAKEN");
      throw err;
    }

    this.repos.audit.record({
      userId: row.id,
      action: AUDIT_ACTIONS.REGISTER,
      target: row.id,
      detail: { email: row.email, becameAdmin: isFirstUser, viaInvite: Boolean(consumedInvite) },
      ip: input.ip ?? null,
    });

    this.log.info(
      "认证",
      isFirstUser ? `首位用户注册成为管理员：${email}` : `新用户注册（凭邀请码，直接可用）：${email}`,
      { userId: row.id },
    );

    // 直接签发会话，注册完就是登录态
    const token = this.createSession(row, input.userAgent ?? null, input.ip ?? null);
    return { user: this.toApi(row), becameAdmin: isFirstUser, token };
  }

  /** 邀请码回滚（创建用户失败时，不让用户白丢一个码） */
  private refundInvite(code: string): void {
    try {
      this.repos.invites.refund(code);
    } catch {
      /* 回滚失败只影响一个邀请码余量，不阻断注册错误上报 */
    }
  }

  /* ---------- 登录 ---------- */

  async login(input: {
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ user: ApiUser; token: SessionToken }> {
    const email = input.email.trim();
    const ip = input.ip ?? "unknown";
    const byUser = `login:${ip}:${email.toLowerCase()}`;
    const byIp = `login-ip:${ip}`;

    const userRl = this.limiter.login.hit(byUser);
    if (!userRl.allowed) {
      throw new HttpError(
        429,
        "RATE_LIMITED",
        `登录失败次数过多，请 ${Math.ceil(userRl.retryAfterMs / 60000)} 分钟后再试。`,
      );
    }
    const ipRl = this.limiter.loginByIp.hit(byIp);
    if (!ipRl.allowed) {
      throw new HttpError(429, "RATE_LIMITED", "该 IP 登录尝试过多，请稍后再试。");
    }

    const row = this.repos.users.findByEmail(email);

    // 用户不存在时也走一次哈希，抹平「响应快 = 邮箱不存在」信道
    if (!row) {
      await burnTimeLikeVerify();
      this.auditLoginFail(null, email, ip);
      throw unauthorized("邮箱或口令不正确", "BAD_CREDENTIALS");
    }

    const ok = await verifyPassword(input.password, row.password_hash);
    if (!ok) {
      this.auditLoginFail(row.id, email, ip);
      throw unauthorized("邮箱或口令不正确", "BAD_CREDENTIALS");
    }

    if (row.status === "banned") {
      this.auditLoginFail(row.id, email, ip, "banned");
      throw forbidden("该账号已被封禁，请联系管理员。", "ACCOUNT_BANNED");
    }

    // 登录成功：清掉失败计数，不惩罚正常用户
    this.limiter.login.reset(byUser);
    this.limiter.loginByIp.reset(byIp);

    // 口令哈希参数升级时静默重算
    if (needsRehash(row.password_hash)) {
      try {
        const fresh = await hashPassword(input.password);
        this.repos.users.updatePasswordHash(row.id, fresh);
        this.log.info("认证", `已升级口令哈希参数：${email}`, { userId: row.id });
      } catch {
        /* 升级失败不影响登录 */
      }
    }

    this.repos.users.touchLastLogin(row.id);
    const token = this.createSession(row, input.userAgent ?? null, ip);

    this.repos.audit.record({
      userId: row.id,
      action: AUDIT_ACTIONS.LOGIN_OK,
      target: row.id,
      ip,
    });

    const fresh = this.repos.users.findById(row.id) ?? row;
    return { user: this.toApi(fresh), token };
  }

  private auditLoginFail(userId: string | null, email: string, ip: string, reason = "bad_credentials"): void {
    this.repos.audit.record({
      userId,
      action: AUDIT_ACTIONS.LOGIN_FAIL,
      target: email,
      detail: { reason },
      ip,
    });
  }

  /* ---------- 会话 ---------- */

  createSession(user: UserRow, userAgent: string | null, ip: string | null): SessionToken {
    const token = randomBytes(32).toString("base64url");
    const row = this.repos.sessions.create({
      userId: user.id,
      tokenHash: hashToken(token),
      ttlMs: this.ttlMs,
      userAgent,
      ip,
    });
    return { token, sessionId: row.id, expiresAt: Number(row.expires_at) };
  }

  /** 校验 cookie 里的 token → 用户；无效返回 null */
  resolveSession(token: string | null | undefined): { user: UserRow; sessionId: string; expiresAt: number } | null {
    if (!token) return null;
    const row = this.repos.sessions.findValidByTokenHash(hashToken(token));
    if (!row) return null;
    const user = this.repos.users.findById(row.user_id);
    if (!user) {
      // 用户已被删除，清掉悬挂会话
      this.repos.sessions.deleteById(row.id);
      return null;
    }
    if (user.status === "banned") return null;
    return { user, sessionId: row.id, expiresAt: Number(row.expires_at) };
  }

  /** 滑动续期：剩余不足一半时往后推，避免每请求都写库 */
  maybeExtend(sessionId: string, expiresAt: number): void {
    const remain = expiresAt - Date.now();
    if (remain > this.ttlMs / 2) return;
    this.repos.sessions.extend(sessionId, this.ttlMs);
  }

  logout(token: string | null | undefined, userId?: string, ip?: string): void {
    if (!token) return;
    this.repos.sessions.deleteByTokenHash(hashToken(token));
    if (userId) {
      this.repos.audit.record({ userId, action: AUDIT_ACTIONS.LOGOUT, target: userId, ip: ip ?? null });
    }
  }

  logoutAll(userId: string): number {
    return this.repos.sessions.deleteForUser(userId);
  }

  /* ---------- 自助 ---------- */

  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    ip?: string;
  }): Promise<void> {
    const rl = this.limiter.passwordChange.hit(`pw:${input.userId}`);
    if (!rl.allowed) throw new HttpError(429, "RATE_LIMITED", "改口令过于频繁，请稍后再试。");

    const user = this.repos.users.findById(input.userId);
    if (!user) throw unauthorized();

    const ok = await verifyPassword(input.currentPassword, user.password_hash);
    if (!ok) throw badRequest("当前口令不正确", "BAD_CURRENT_PASSWORD");

    const strength = validatePasswordStrength(input.newPassword);
    if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");

    const hash = await hashPassword(input.newPassword);
    this.repos.users.updatePasswordHash(user.id, hash);
    // 改口令后踢掉所有其他会话（当前会话也失效，前端会跳登录页）
    this.repos.sessions.deleteForUser(user.id);
    this.repos.audit.record({
      userId: user.id,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      target: user.id,
      ip: input.ip ?? null,
    });
    this.log.info("认证", `用户 ${user.email} 修改了口令，已注销全部会话`, { userId: user.id });
  }

  updateProfile(userId: string, displayName: string, ip?: string): ApiUser {
    const name = displayName.trim();
    if (!name) throw badRequest("显示名不能为空", "INVALID_DISPLAY_NAME");
    if (name.length > 40) throw badRequest("显示名最多 40 个字符", "INVALID_DISPLAY_NAME");
    const user = this.repos.users.findById(userId);
    if (!user) throw unauthorized();
    this.repos.users.updateDisplayName(userId, name);
    this.repos.audit.record({
      userId,
      action: AUDIT_ACTIONS.PROFILE_CHANGED,
      target: userId,
      detail: { displayName: name },
      ip: ip ?? null,
    });
    const fresh = this.repos.users.findById(userId) ?? user;
    return this.toApi(fresh);
  }

  /* ---------- 管理员：用户 ---------- */

  listUsers(opts: { status?: UserStatus; limit?: number; offset?: number } = {}): ApiUser[] {
    return this.repos.users.list(opts).map((u) => this.toApi(u));
  }

  approve(userId: string, adminId: string, ip?: string): ApiUser {
    const target = this.repos.users.findById(userId);
    if (!target) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    if (target.status === "approved") return this.toApi(target);

    this.repos.users.setStatus(userId, "approved", adminId);
    // 审批时清掉该用户此前失败的会话，让它重新登录拿到新状态
    this.repos.sessions.deleteForUser(userId);
    this.repos.audit.record({
      userId: adminId,
      action: AUDIT_ACTIONS.USER_APPROVED,
      target: userId,
      detail: { email: target.email },
      ip: ip ?? null,
    });
    this.log.info("管理", `已批准用户 ${target.email}`, { userId: adminId });
    const fresh = this.repos.users.findById(userId);
    if (!fresh) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    return this.toApi(fresh);
  }

  reject(userId: string, adminId: string, ip?: string): ApiUser {
    const target = this.repos.users.findById(userId);
    if (!target) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    if (target.role === "admin" && this.repos.users.countAdmins() <= 1) {
      throw badRequest("不能拒绝最后一个管理员", "LAST_ADMIN");
    }
    this.repos.users.setStatus(userId, "banned", adminId);
    this.repos.sessions.deleteForUser(userId);
    this.repos.audit.record({
      userId: adminId,
      action: AUDIT_ACTIONS.USER_REJECTED,
      target: userId,
      detail: { email: target.email },
      ip: ip ?? null,
    });
    const fresh = this.repos.users.findById(userId);
    if (!fresh) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    return this.toApi(fresh);
  }

  setUserStatus(userId: string, status: UserStatus, adminId: string, ip?: string): ApiUser {
    const target = this.repos.users.findById(userId);
    if (!target) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    if (target.id === adminId && status !== "approved") {
      throw badRequest("不能修改自己的状态", "SELF_STATUS");
    }
    if (status === "banned" && target.role === "admin" && this.repos.users.countAdmins() <= 1) {
      throw badRequest("不能封禁最后一个管理员", "LAST_ADMIN");
    }

    this.repos.users.setStatus(userId, status, status === "approved" ? adminId : null);
    if (status !== "approved") this.repos.sessions.deleteForUser(userId);

    this.repos.audit.record({
      userId: adminId,
      action: status === "banned" ? AUDIT_ACTIONS.USER_BANNED : AUDIT_ACTIONS.USER_STATUS_CHANGED,
      target: userId,
      detail: { status, email: target.email },
      ip: ip ?? null,
    });
    const fresh = this.repos.users.findById(userId);
    if (!fresh) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    return this.toApi(fresh);
  }

  setUserRole(userId: string, role: UserRole, adminId: string, ip?: string): ApiUser {
    const target = this.repos.users.findById(userId);
    if (!target) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    if (target.id === adminId) throw badRequest("不能修改自己的角色", "SELF_ROLE");
    if (role === "user" && target.role === "admin" && this.repos.users.countAdmins() <= 1) {
      throw badRequest("不能降级最后一个管理员", "LAST_ADMIN");
    }

    this.repos.users.setRole(userId, role);
    this.repos.audit.record({
      userId: adminId,
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      target: userId,
      detail: { role, email: target.email },
      ip: ip ?? null,
    });
    const fresh = this.repos.users.findById(userId);
    if (!fresh) throw new HttpError(404, "USER_NOT_FOUND", "用户不存在");
    return this.toApi(fresh);
  }

  /** 生成一个随机初始口令（管理员建号用），返回明文仅此一次 */
  /**
   * 确保存在一个管理员账号（部署时自动创建）。
   *
   * 为什么要在启动时建而不是「第一个注册的人自动成管理员」：
   *  · 服务器部署时，先访问站点的人未必是机主；把首注册变管理员等于把后台送给先来的人
   *  · 机主需要一个**已知用户名 + 部署时随机生成的强口令**的入口
   *
   * 行为：
   *  · 账号不存在 → 创建（role=admin, status=approved）
   *  · 账号已存在 → 不改口令（除非显式传 password），只确保它是 admin 且未被封禁
   *
   * @returns 创建/复用情况 + 生成的口令（仅新建时返回，调用方负责展示一次）
   */
  async ensureAdminAccount(input: {
    /** 登录名（默认 admin）。允许不是邮箱 —— 登录时按同一字段匹配 */
    username: string;
    /** 指定口令；不传则随机生成 */
    password?: string;
  }): Promise<{ created: boolean; username: string; password: string | null; note: string | null }> {
    const username = input.username.trim() || "admin";

    const existing = this.repos.users.findByEmail(username);
    if (existing) {
      // 已存在：只纠正角色/状态，不碰口令（避免每次重启把管理员自己改的口令冲掉）
      const fixes: string[] = [];
      if (existing.role !== "admin") {
        this.repos.users.setRole(existing.id, "admin");
        fixes.push("角色修正为管理员");
      }
      if (existing.status !== "approved") {
        this.repos.users.setStatus(existing.id, "approved", null);
        fixes.push("状态修正为已启用");
      }
      if (input.password) {
        const strength = validatePasswordStrength(input.password);
        if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");
        this.repos.users.updatePasswordHash(existing.id, await hashPassword(input.password));
        fixes.push("口令已按配置重置");
      }
      return {
        created: false,
        username,
        password: null,
        note: fixes.length ? `已存在，${fixes.join("；")}` : null,
      };
    }

    // 生成一个足够强的随机口令：12 字节 base64url = 16 个字符，含大小写与数字
    const generated = input.password ?? randomBytes(12).toString("base64url");
    const strength = validatePasswordStrength(generated);
    if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");

    this.repos.users.create({
      email: username,
      passwordHash: await hashPassword(generated),
      displayName: "管理员",
      role: "admin",
      status: "approved",
      approvedBy: null,
    });

    this.repos.audit.record({
      userId: null,
      action: "admin.seeded",
      target: username,
      detail: { source: input.password ? "env" : "generated" },
      ip: null,
    });

    return {
      created: true,
      username,
      // 只有随机生成时才回报口令；用户自己指定的口令不在这里回显
      password: input.password ? null : generated,
      note: null,
    };
  }

  /** 管理员重置任意用户的口令（含自己）。返回是否成功 */
  async resetUserPassword(targetUserId: string, newPassword: string): Promise<void> {
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");
    const row = this.repos.users.findById(targetUserId);
    if (!row) throw badRequest("用户不存在", "USER_NOT_FOUND");

    this.repos.users.updatePasswordHash(targetUserId, await hashPassword(newPassword));
    // 改口令后强制所有会话失效：否则旧会话（可能已被泄漏）仍然有效
    this.repos.sessions.deleteForUser(targetUserId);
  }

  async createUserByAdmin(input: {
    email: string;
    displayName: string;
    password?: string;
    role?: UserRole;
    adminId: string;
    ip?: string;
  }): Promise<{ user: ApiUser; initialPassword: string | null }> {
    const email = input.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    }
    if (this.repos.users.existsEmail(email)) throw conflict("该邮箱已注册", "EMAIL_TAKEN");

    const generated = input.password ? null : randomBytes(9).toString("base64url");
    const password = input.password ?? (generated as string);
    const strength = validatePasswordStrength(password);
    if (!strength.ok) throw badRequest(strength.message, "WEAK_PASSWORD");

    const passwordHash = await hashPassword(password);
    const row = this.repos.users.create({
      email,
      passwordHash,
      displayName: input.displayName.trim() || email.split("@")[0] || email,
      role: input.role ?? "user",
      status: "approved",
      approvedBy: input.adminId,
    });

    this.repos.audit.record({
      userId: input.adminId,
      action: AUDIT_ACTIONS.REGISTER,
      target: row.id,
      detail: { email, byAdmin: true, generated: Boolean(generated) },
      ip: input.ip ?? null,
    });

    return { user: this.toApi(row), initialPassword: generated };
  }
}
