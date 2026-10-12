// 跨模块「换图决策权」协作锁
//
// 这是「报名赛事」与「保底切图」之间的协调通道：保底期间不该进比赛图，
// 但报名必须照常（报名有时效）。锁本身是纯内存的，所以重点验证：
// 按账号隔离、幂等、不会因为计数泄漏把某个账号的进图永久锁死。
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTravelLocks,
  holdTravel,
  isTravelHeld,
  releaseTravel,
  travelHeldBy,
  travelHolders,
} from "../src/modules/shared/travel-lock.ts";

const A = "acct-A";
const B = "acct-B";

describe("travel-lock", () => {
  beforeEach(() => clearTravelLocks());

  it("没人占着时为 false，占上之后为 true", () => {
    expect(isTravelHeld(A)).toBe(false);
    expect(travelHeldBy(A)).toBeNull();

    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    expect(isTravelHeld(A)).toBe(true);
    expect(travelHeldBy(A)).toBe("保底切图（守保底中）");
  });

  it("★ 按账号隔离：A 账号守保底不能挡住 B 账号进比赛图", () => {
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    expect(isTravelHeld(A)).toBe(true);
    expect(isTravelHeld(B)).toBe(false);
    expect(travelHeldBy(B)).toBeNull();
  });

  it("release 之后恢复；没持有过也能安全 release", () => {
    holdTravel(A, "tag1");
    releaseTravel(A, "tag1");
    expect(isTravelHeld(A)).toBe(false);
    expect(() => releaseTravel(A, "从没持有过")).not.toThrow();
    expect(() => releaseTravel("从没见过的账号", "tag1")).not.toThrow();
  });

  it("★ 同一 tag 幂等：重复 hold 不会累积，一次 release 就能放开", () => {
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    releaseTravel(A, "auto-pity:A");
    expect(isTravelHeld(A)).toBe(false); // 旧版若用计数器，这里会残留 2 次 → 永远进不了比赛图
  });

  it("多个持有方（tag 不同）要全部释放才算放开，且日志里都列出来", () => {
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    holdTravel(A, "other:A", "别的功能");
    expect(travelHeldBy(A)).toContain("保底切图");
    expect(travelHeldBy(A)).toContain("别的功能");

    releaseTravel(A, "auto-pity:A");
    expect(isTravelHeld(A)).toBe(true);
    expect(travelHeldBy(A)).toBe("别的功能");

    releaseTravel(A, "other:A");
    expect(isTravelHeld(A)).toBe(false);
  });

  it("空 accountId / 空 tag 直接忽略（不让脏数据把锁挂住）", () => {
    holdTravel("", "tag", "x");
    holdTravel(A, "", "x");
    expect(isTravelHeld(A)).toBe(false);
    expect(isTravelHeld("")).toBe(false);
  });

  it("travelHolders 给出明细（谁、从什么时候开始），便于排查锁没放掉", () => {
    const before = Date.now();
    holdTravel(A, "auto-pity:A", "保底切图（守保底中）");
    const holders = travelHolders(A);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.tag).toBe("auto-pity:A");
    expect(holders[0]?.since).toBeGreaterThanOrEqual(before);
  });
});
