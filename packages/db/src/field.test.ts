import assert from "node:assert/strict";
import test from "node:test";

import { coolingGate, kstToday, LEAD_STAGES, MemoryFieldStore } from "./field.ts";

test("숙려기간은 자문 여부에 따라 7일·14일이며 KST 경계에서 딱 그날 열린다", () => {
  /* 가맹사업법 제7조③ — 제공일 다음 14일(자문 시 7일) 경과 전 계약 금지 */
  assert.deepEqual(coolingGate({ docDate: null, advisor: false }), { has: false }, "제공일이 없으면 게이트 자체가 없다");

  const plain = coolingGate({ docDate: "2026-08-01", advisor: false }, "2026-08-14");
  assert.deepEqual(plain, { has: true, days: 14, gate: "2026-08-15", ok: false }, "14일째는 아직 미경과");
  assert.equal(coolingGate({ docDate: "2026-08-01", advisor: false }, "2026-08-15").ok, true, "15일째 개방");

  const advised = coolingGate({ docDate: "2026-08-01", advisor: true }, "2026-08-07");
  assert.deepEqual(advised, { has: true, days: 7, gate: "2026-08-08", ok: false }, "자문 시 7일");
  assert.equal(coolingGate({ docDate: "2026-08-01", advisor: true }, "2026-08-08").ok, true);

  /* 월말·연말 넘김 */
  assert.equal(coolingGate({ docDate: "2026-02-20", advisor: false }).gate, "2026-03-06", "2월은 28일로 계산");
  assert.equal(coolingGate({ docDate: "2026-12-25", advisor: false }).gate, "2027-01-08", "연말 넘김");
  assert.match(kstToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test("리드 단계는 6단계이고 저장·수정·삭제가 왕복한다", async () => {
  assert.deepEqual([...LEAD_STAGES], ["리드", "상담", "정보공개서 제공", "가맹계약", "실사·공사", "오픈완료"]);
  const store = new MemoryFieldStore();
  const lead = await store.createLead({ name: "김가맹", phone: "010-1234-5678", area: "수원 영통", storeName: "영통점" });
  assert.equal(lead.stage, 0);
  assert.equal(lead.flag, false);
  assert.equal(lead.storeId, null);

  const updated = await store.updateLead(lead.id, { memo: "상가 계약 예정", docDate: "2026-08-01", advisor: true });
  assert.equal(updated?.memo, "상가 계약 예정");
  assert.equal(updated?.docDate, "2026-08-01");
  assert.equal(updated?.advisor, true);
  assert.equal(updated?.name, "김가맹", "미지정 필드는 보존된다");

  const staged = await store.setLeadStage(lead.id, 3, true);
  assert.equal(staged?.stage, 3);
  assert.equal(staged?.flag, true, "숙려 미준수 사후기록 플래그");

  const opened = await store.setLeadStage(lead.id, 5, true, "store-yeongtong");
  assert.equal(opened?.storeId, "store-yeongtong");

  assert.equal((await store.listLeads()).length, 1);
  assert.equal(await store.removeLead(lead.id), true);
  assert.equal(await store.removeLead(lead.id), false, "삭제는 멱등하게 false");
  assert.deepEqual(await store.listLeads(), []);
  assert.equal(await store.getLead(lead.id), null);
  assert.equal(await store.updateLead("없음", { memo: "x" }), null);
});

test("공지는 고정이 먼저 오고 설정은 키 단위로 덮어쓴다", async () => {
  const store = new MemoryFieldStore();
  await store.createNotice({ title: "8월 배송 일정", body: "광복절 휴무" });
  const pinned = await store.createNotice({ title: "폐기 등록 필수", pinned: true });
  const notices = await store.listNotices();
  assert.equal(notices[0]?.id, pinned.id, "고정 공지 우선");
  assert.equal(notices.length, 2);
  assert.match(notices[0]!.date, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(await store.removeNotice(pinned.id), true);
  assert.equal((await store.listNotices()).length, 1);

  assert.equal(await store.getSetting("navermap.keyId"), null);
  await store.putSetting("navermap.keyId", "key-1");
  await store.putSetting("navermap.keyId", "key-2");
  assert.equal(await store.getSetting("navermap.keyId"), "key-2");
  await store.close();
});

test("메모리 구현은 읽기마다 복제를 돌려줘 호출부가 저장소를 우회 변경하지 못한다", async () => {
  /* Postgres 구현은 매번 새 행을 매핑하므로, 메모리 구현도 같은 계약이어야 한다.
   * 이 계약이 깨지면 호출부가 들고 있던 '변경 전' 값이 이후 변경으로 덮여, 감사 기록이 조용히 사라진다. */
  const store = new MemoryFieldStore();
  const created = await store.createLead({ name: "이가맹" });
  created.name = "위조";
  assert.equal((await store.getLead(created.id))?.name, "이가맹", "생성 반환값 변조가 저장소에 새지 않는다");

  const before = (await store.getLead(created.id))!;
  await store.setLeadStage(created.id, 3, true);
  assert.equal(before.flag, false, "이전에 읽은 스냅샷은 이후 변경에 오염되지 않는다");
  assert.equal(before.stage, 0);
  assert.equal((await store.getLead(created.id))?.flag, true);

  const listed = await store.listLeads();
  listed[0]!.stage = 99;
  assert.equal((await store.getLead(created.id))?.stage, 3);
});
