import assert from "node:assert/strict";
import test from "node:test";

import { OPENING_TEMPLATE } from "./opening-template.ts";
import { MemoryOpeningStore, addDays, templateFor } from "./openings.ts";

const base = {
  name: "판교점", region: "경기 성남", openDate: "2026-09-01",
  mode: "가맹" as const, storeType: "테이블형" as const,
};

test("템플릿 54항목 중 매장유형에 맞는 항목만 생성한다", async () => {
  assert.equal(OPENING_TEMPLATE.length, 54);
  const table = templateFor("테이블형");
  const takeout = templateFor("포장형");
  assert.equal(table.length, 52, "포장형 전용 2건 제외");
  assert.equal(takeout.length, 52, "테이블형 전용 2건 제외");
  assert.ok(table.some((t) => t.title.includes("[테이블형]")));
  assert.ok(!table.some((t) => t.title.includes("[포장형]")));
});

test("생성 시 단계별 집계와 D-day를 낸다", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create(base);
  assert.equal(opening.total, 52);
  assert.equal(opening.done, 0);
  assert.equal(opening.progressPct, 0);
  assert.equal(opening.stage, "상담중");
  assert.deepEqual(Object.keys(opening.phases), ["D-4주차", "D-3주차", "D-2주차", "D-1주차", "D-DAY"]);
  assert.equal(Object.values(opening.phases).reduce((a, p) => a + p.total, 0), 52);
});

test("데드라인은 오픈일 + 오프셋이며 명시 데드라인을 존중한다", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create(base);
  const license = opening.tasks.find((t) => t.title === "영업신고증 발급")!;
  assert.equal(license.dayOffset, -10, "V1 명시 데드라인 -10일");
  assert.equal(license.deadline, addDays("2026-09-01", -10));
  const first = opening.tasks.find((t) => t.title === "입점위치 확인·상권 파악")!;
  assert.equal(first.deadline, addDays("2026-09-01", -28), "단계 기본 오프셋");
  const dday = opening.tasks.find((t) => t.phase === "D-DAY")!;
  assert.equal(dday.deadline, "2026-09-01");
});

test("지연은 진행 단계에서만 집계한다 (상담중·보류는 미집계)", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create({ ...base, openDate: "2026-08-01" }); /* 이미 지난 오픈일 */
  const consulting = await store.get(opening.id, "2026-08-04");
  assert.equal(consulting?.overdue, 0, "상담중은 지연 미집계");
  await store.setStage(opening.id, "진행");
  const active = await store.get(opening.id, "2026-08-04");
  assert.ok((active?.overdue ?? 0) > 0, "진행으로 옮기면 지연이 드러난다");
  await store.setStage(opening.id, "보류");
  assert.equal((await store.get(opening.id, "2026-08-04"))?.overdue, 0);
});

test("오픈일 변경 시 모든 데드라인이 자동 재계산된다", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create(base);
  const before = opening.tasks.find((t) => t.title === "영업신고증 발급")!.deadline;
  await store.reschedule(opening.id, "2026-09-15");
  const after = (await store.get(opening.id))!.tasks.find((t) => t.title === "영업신고증 발급")!.deadline;
  assert.equal(before, "2026-08-22");
  assert.equal(after, "2026-09-05", "오픈일 +14일 이동만큼 데드라인도 이동");
});

test("항목 완료·해제와 진행률 반영", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create(base);
  const target = opening.tasks[0]!;
  assert.equal(await store.toggleTask(target.id, true, "user-1", "확인 완료"), true);
  const done = await store.get(opening.id);
  const task = done!.tasks.find((t) => t.id === target.id)!;
  assert.equal(task.done, true);
  assert.ok(task.doneAt);
  assert.equal(task.memo, "확인 완료");
  assert.equal(done!.done, 1);
  assert.equal(done!.progressPct, 2);
  await store.toggleTask(target.id, false, null);
  assert.equal((await store.get(opening.id))!.done, 0);
  assert.equal(await store.toggleTask("없는-id", true, null), false);
});

test("커스텀 항목 추가와 오픈 확정(매장 승격)", async () => {
  const store = new MemoryOpeningStore();
  const opening = await store.create(base);
  const added = await store.addTask(opening.id, {
    phase: "D-2주차", group: "현장 점검", title: "간판 조명 야간 확인", owner: "hq", dayOffset: -12 });
  assert.equal(added?.custom, true);
  assert.equal(added?.deadline, addDays("2026-09-01", -12));
  const detail = await store.get(opening.id);
  assert.equal(detail?.total, 53);
  const confirmed = await store.confirmOpen(opening.id, "store-pangyo");
  assert.equal(confirmed?.storeId, "store-pangyo");
  assert.equal(confirmed?.stage, "완료", "확정하면 완료 단계로 이동");
  assert.equal(await store.confirmOpen("없는-id", "store-x"), null);
});

test("목록은 오픈일 순으로 정렬한다", async () => {
  const store = new MemoryOpeningStore();
  await store.create({ ...base, name: "늦은점", openDate: "2026-10-01" });
  await store.create({ ...base, name: "빠른점", openDate: "2026-09-01" });
  assert.deepEqual((await store.list()).map((o) => o.name), ["빠른점", "늦은점"]);
});
