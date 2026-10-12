// 日志脱敏（管理员后台看别人的日志时用）
//
// 两边都要钉住：
//  · 机密必须遮掉（密码 / token / cookie / 签名 / 邮箱 / 长随机串）
//  · **但不能过度脱敏** —— 管理员点进日志页是为了排查，IP、host:port、模块与地图 id、
//    错误原文必须原样保留，否则这个页面没有意义。
import { describe, expect, it } from "vitest";
import { redactLogRow, redactLogText } from "../src/lib/log-redact.ts";

describe("redactLogText：该遮的遮掉", () => {
  it("Authorization 头（Bearer / Basic）", () => {
    expect(redactLogText("Authorization: Basic YWRtaW46c2VjcmV0MTIz")).not.toContain("YWRtaW46c2VjcmV0MTIz");
    expect(redactLogText("authorization: bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  it("key=value / key: value 形式的机密字段", () => {
    expect(redactLogText("password=hunter2xyz")).toContain("password=***");
    expect(redactLogText("token: abcdef123456")).toContain("token: ***");
    expect(redactLogText("sendKey=SCT1234567890abcdef")).not.toContain("SCT1234567890abcdef");
    expect(redactLogText("api_key = sk-live-abcdefghijkl")).not.toContain("sk-live-abcdefghijkl");
    expect(redactLogText("proof=Zm9vYmFyYmF6cXV4MTIzNA")).toContain("proof=***");
  });

  it("会话 cookie 键值对", () => {
    const out = redactLogText("Cookie: reelax_session=abc123def456ghi789; other=1");
    expect(out).not.toContain("abc123def456ghi789");
    // 值一定被遮；键名可能被上一条规则一起吃掉（"Cookie: ***"），两种都算对
    expect(out).toMatch(/reelax_session=\*\*\*|Cookie: \*\*\*/);
  });

  it("带前缀的第三方 token", () => {
    for (const t of ["SCTabcdefghijklmn", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "sk-abcdefghijklmnopqrst"]) {
      expect(redactLogText(`推送失败：${t}`)).not.toContain(t);
    }
  });

  it("邮箱只留首字母与域名", () => {
    expect(redactLogText("登录账号 creator2k@example.com 失败")).toContain("c***@example.com");
    expect(redactLogText("登录账号 creator2k@example.com 失败")).not.toContain("creator2k@example.com");
  });

  it("裸的长随机串（≥32 位）保留前 4 位并标注长度", () => {
    const key = "aaaa" + "b".repeat(40);
    const out = redactLogText(`写入失败，键 ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("aaaa***");
  });

  it("带 key 名标签的长串直接整体打码", () => {
    const key = "aaaa" + "b".repeat(40);
    const out = redactLogText(`Idempotency-Key: ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("Idempotency-Key: ***");
  });
});

describe("redactLogText：不该动的别动（否则没法排查）", () => {
  it("出口 IP 与 host:port 保留", () => {
    expect(redactLogText("使用账号代理 103.85.24.7:10800")).toBe("使用账号代理 103.85.24.7:10800");
    expect(redactLogText("网络错误：Connect Timeout Error (attempted addresses: 198.18.0.4:443)")).toContain("198.18.0.4:443");
  });

  it("模块 / 地图 / 鱼饵 id 与中文说明保留", () => {
    const line = "自动切图 ⛵ 月落溪谷 → 星渊圣海（距保底还差 20 杆，切到保底地图）";
    expect(redactLogText(line)).toBe(line);
    expect(redactLogText("给 b_015 买增益：unitCost=500")).toContain("b_015");
  });

  it("普通数字与短 id 保留（金额、条数、序号）", () => {
    expect(redactLogText("公会金库不足：本次需要 500（1 份 × 500），现有 120")).toBe(
      "公会金库不足：本次需要 500（1 份 × 500），现有 120",
    );
    expect(redactLogText("已报名个人赛 #8（待开赛）")).toBe("已报名个人赛 #8（待开赛）");
  });

  it("空值 / null 不炸", () => {
    expect(redactLogText(null)).toBe("");
    expect(redactLogText(undefined)).toBe("");
    expect(redactLogText("")).toBe("");
  });
});

describe("redactLogRow", () => {
  it("把仓储行转成脱敏后的条目（时间戳转数字）", () => {
    const row = {
      created_at: "1791822796259",
      level: "warn",
      user_id: "u1",
      account_id: "a1",
      module_id: "auto-bait",
      tag: "自动换饵",
      msg: "购买失败 email=x@y.com password=secret123",
    };
    const e = redactLogRow(row);
    expect(e.t).toBe(1791822796259);
    expect(e.level).toBe("warn");
    expect(e.userId).toBe("u1");
    expect(e.tag).toBe("自动换饵");
    expect(e.msg).toContain("x***@y.com");
    expect(e.msg).not.toContain("secret123");
  });
});
