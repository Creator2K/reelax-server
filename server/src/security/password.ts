// 口令哈希：scrypt（Node 内置 crypto，零原生依赖）
//
// 为什么不用 argon2id：argon2 的原生模块在 Alpine 上需要构建工具链，
// 而 scrypt 是 Node 内置且在 OWASP 推荐之列。参数 N=2^15, r=8, p=1 → 内存约 32MB，
// 单次约 60~120ms，足以抵抗离线爆破且不会拖垮事件循环（用异步版本）。
//
// 存储格式（自带参数，便于将来调参后平滑升级）：
//   scrypt$N=32768,r=8,p=1$<salt-b64url>$<hash-b64url>
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export type ScryptParams = { N: number; r: number; p: number };

/** 当前默认参数（提升安全强度时改这里，旧哈希仍可校验） */
export const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** maxmem 必须大于 128*N*r，留 2 倍余量 */
const maxmemFor = (p: ScryptParams) => 128 * p.N * p.r * 2;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** 用户名长度范围（登录标识） */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * 校验「登录标识」（用户名或邮箱）。
 *
 * 允许：字母、数字、下划线、连字符、点、@，以及中文字符。
 * 为什么允许中文与 @：
 *   · 这是自建服务，用户想用什么名字就用什么名字
 *   · 历史上已存在的用户是邮箱（someone@example.com），必须继续能登录/注册同名
 * 禁止：空白、控制字符，以及容易造成混淆的 < > / \ ' " ` 空格
 *
 * @returns 错误信息；合法则返回 null
 */
export function validateUsername(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "请填写用户名";
  // 用 [...v] 按「字符」而不是字节算长度，否则中文用户名会被误判为太长
  const len = [...v].length;
  if (len < USERNAME_MIN_LENGTH) return `用户名至少 ${USERNAME_MIN_LENGTH} 个字符`;
  if (len > USERNAME_MAX_LENGTH) return `用户名最多 ${USERNAME_MAX_LENGTH} 个字符`;
  if (/\s/.test(v)) return "用户名不能包含空格";
  // eslint-disable-next-line no-control-regex -- 控制字符正是要挡掉的东西
  if (/[\u0000-\u001f\u007f]/.test(v)) return "用户名包含不可用字符";
  if (/[<>/\\'"`|]/.test(v)) return "用户名不能包含 < > / \\ ' \" ` | 这些字符";
  return null;
}

export function validatePasswordStrength(password: string): { ok: true } | { ok: false; message: string } {
  if (typeof password !== "string") return { ok: false, message: "口令必须是字符串" };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, message: `口令至少 ${PASSWORD_MIN_LENGTH} 个字符` };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, message: `口令不能超过 ${PASSWORD_MAX_LENGTH} 个字符` };
  // 不强制复杂度规则（长度优先，避免逼出 "Password1!" 这类写法），但拒绝纯重复
  if (/^(.)\1+$/.test(password)) return { ok: false, message: "口令不能是所有字符都相同" };
  return { ok: true };
}

function encode(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_BYTES, { ...params, maxmem: maxmemFor(params) });
  return encode(params, salt, hash);
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;
  const params: Partial<ScryptParams> = {};
  for (const kv of (parts[1] ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k === "N") params.N = Number(v);
    if (k === "r") params.r = Number(v);
    if (k === "p") params.p = Number(v);
  }
  if (!params.N || !params.r || !params.p) return null;
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null;
  try {
    return {
      params: params as ScryptParams,
      salt: Buffer.from(parts[2] ?? "", "base64url"),
      hash: Buffer.from(parts[3] ?? "", "base64url"),
    };
  } catch {
    return null;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const { params, salt, hash } = parsed;
  if (hash.length !== KEY_BYTES) return false;
  let candidate: Buffer;
  try {
    candidate = await scrypt(password, salt, hash.length, { ...params, maxmem: maxmemFor(params) });
  } catch {
    return false;
  }
  if (candidate.length !== hash.length) return false;
  return timingSafeEqual(candidate, hash);
}

/** 是否需要重新哈希（参数升级后登录时静默重算） */
export function needsRehash(stored: string, target: ScryptParams = DEFAULT_PARAMS): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.params.N !== target.N || parsed.params.r !== target.r || parsed.params.p !== target.p;
}

/**
 * 固定耗时兜底：用户不存在时也走一次哈希校验，
 * 避免「响应快 = 邮箱不存在」这种枚举信道。
 */
let dummyHash: string | null = null;
export async function burnTimeLikeVerify(): Promise<void> {
  if (!dummyHash) {
    dummyHash = await hashPassword("reelax-dummy-password-for-timing");
  }
  await verifyPassword("reelax-dummy-password-for-timing-wrong", dummyHash);
}
