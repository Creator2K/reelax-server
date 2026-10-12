// 审计记录的人话描述
//
// 背景：前端原来自己维护映射表，键名与 AUDIT_ACTIONS 对不上，界面上大多显示原始码
// （account.module.updated）——用户看不懂。现在由服务端生成描述（账号/功能名只有它有）。
import { describe, expect, it } from "vitest";
import { describeAudit } from "../src/lib/audit-text.ts";

const r = {
  accountLabel: (id: string) => (id === "acc-1" ? "大号" : null),
  moduleName: (id: string) => (id === "auto-bait" ? "自动换饵" : null),
  userName: (id: string) => (id === "u-1" ? "2K" : null),
};

describe("describeAudit", () => {
  it("★ 账号 + 功能：解析出账号标签与功能名", () => {
    const text = describeAudit({ action: "account.module.updated", target: "acc-1:auto-bait", detail_json: null }, r);
    expect(text).toBe("修改账号「大号」的功能「自动换饵」");
  });

  it("★ 功能配置的补充说明（启用 / 关闭 / 恢复默认 / 改配置 N 项）", () => {
    expect(
      describeAudit({ action: "account.module.updated", target: "acc-1:auto-bait", detail_json: '{"enabled":true}' }, r),
    ).toContain("（启用）");
    expect(
      describeAudit({ action: "account.module.updated", target: "acc-1:auto-bait", detail_json: '{"enabled":false}' }, r),
    ).toContain("（关闭）");
    expect(
      describeAudit({ action: "account.module.updated", target: "acc-1:auto-bait", detail_json: '{"reset":true}' }, r),
    ).toContain("恢复默认配置");
    expect(
      describeAudit(
        { action: "account.module.updated", target: "acc-1:auto-bait", detail_json: '{"keys":["a","b"]}' },
        r,
      ),
    ).toContain("改配置 2 项");
    expect(
      describeAudit({ action: "account.module.updated", target: "acc-1:auto-bait", detail_json: "{坏 JSON" }, r),
    ).toBe("修改账号「大号」的功能「自动换饵」");
  });

  it("账号 / 用户 / 邀请码 / 代理都能读", () => {
    expect(describeAudit({ action: "account.created", target: "acc-1", detail_json: null }, r)).toBe("创建账号「大号」");
    expect(describeAudit({ action: "account.deleted", target: "acc-1", detail_json: null }, r)).toBe("删除账号「大号」");
    expect(describeAudit({ action: "admin.user.approved", target: "u-1", detail_json: null }, r)).toBe("启用用户「2K」");
    expect(describeAudit({ action: "admin.invite.created", target: "ABC123", detail_json: null }, r)).toBe(
      "生成邀请码「ABC123」",
    );
    expect(describeAudit({ action: "proxy.created", target: "香港", detail_json: null }, r)).toBe("添加代理「香港」");
    expect(describeAudit({ action: "auth.login.fail", target: null, detail_json: null }, r)).toBe("登录失败");
  });

  it("★ 解析不到名字时保留原始 id（追查时仍有用），未收录的动作保留原始码", () => {
    expect(describeAudit({ action: "account.created", target: "acc-unknown", detail_json: null }, r)).toBe(
      "创建账号「acc-unknown」",
    );
    expect(describeAudit({ action: "some.future.action", target: "x", detail_json: null }, {})).toBe(
      "some.future.action（x）",
    );
    expect(describeAudit({ action: "some.future.action", target: null, detail_json: null }, {})).toBe("some.future.action");
  });
});
