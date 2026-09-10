import { describe, expect, it } from "vitest";
import { resolveVisiblePages, type AccessPolicyDocument } from "./service.ts";
import type { Actor } from "./service.ts";

/** 실제 운영 사고 재현: 페이지 카탈로그가 커진 뒤에도 구버전 정책이 새 페이지를 가리면 안 된다. */
const master = { id: "actor-1", role: "hq_master" } as Actor;

const legacyDoc = (actorPages: Record<string, string[]>): AccessPolicyDocument => ({
  id: "access-policy", version: 4, rolePages: {}, actorPages, menuOrder: [],
});

describe("정책 저장 이후 추가된 페이지 해석", () => {
  it("knownPaths 없는 구버전 문서: 문서에 등장한 적 없는 역할 기본 페이지는 자동 노출된다", () => {
    const doc = legacyDoc({ "actor-1": ["/hq/orders", "/hq/stores"] });
    const pages = resolveVisiblePages(master, doc);
    expect(pages).toContain("/hq/design"); // 저장 당시 존재하지 않던 페이지 — 기본값을 따른다
    expect(pages.slice(0, 2)).toEqual(["/hq/orders", "/hq/stores"]); // 저장된 목록·순서는 보존
  });

  it("구버전 문서라도 문서 어딘가에 등장한 페이지는 '알던 페이지' — 이 계정에서 빠져 있으면 꺼진 것으로 존중한다", () => {
    const doc = legacyDoc({
      "actor-1": ["/hq/orders"],
      "actor-2": ["/hq/orders", "/hq/settings"], // 다른 계정 목록에 있으므로 settings는 알던 페이지
    });
    expect(resolveVisiblePages(master, doc)).not.toContain("/hq/settings");
  });

  it("knownPaths가 찍힌 문서: 알던 페이지는 목록대로만, 이후 추가분만 자동 노출된다", () => {
    const doc: AccessPolicyDocument = {
      ...legacyDoc({ "actor-1": ["/hq/orders"] }),
      knownPaths: ["/hq/orders", "/hq/design"], // 디자인워크를 알고도 뺐다 = 의도적 비노출
    };
    const pages = resolveVisiblePages(master, doc);
    expect(pages).not.toContain("/hq/design");
    expect(pages).toContain("/hq/settings"); // knownPaths에 없는 기본 페이지는 자동 노출
  });

  it("정책이 없으면 역할 기본값 그대로", () => {
    expect(resolveVisiblePages(master, undefined)).toContain("/hq/design");
  });
});
