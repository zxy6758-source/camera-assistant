import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, Stabilizer } from "../logic.js";

// 서 있는 사람 하나를 만든다: 머리 y=top, 발 y=bottom, 가운데 x=cx
function person({ top, bottom, cx = 0.5, halfW = 0.08, vis = 1 }) {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: (top + bottom) / 2, visibility: vis }));
  const H = bottom - top;
  const set = (i, x, y, v = vis) => (lm[i] = { x, y, visibility: v });
  const eyeY = top + 0.12 * H;
  set(0, cx, top + 0.15 * H); // 코
  set(2, cx - 0.01, eyeY); set(5, cx + 0.01, eyeY);
  set(11, cx - halfW, top + 0.25 * H); set(12, cx + halfW, top + 0.25 * H);
  set(23, cx - halfW / 2, top + 0.55 * H); set(24, cx + halfW / 2, top + 0.55 * H);
  for (const i of [27, 28, 29, 30, 31, 32]) set(i, cx, bottom);
  return lm;
}
const run = (p, o = {}) => evaluate([p], { mode: "full", bg: "normal", ...o });

test("사람 없음", () => {
  const r = evaluate([], { mode: "full", bg: "normal" });
  assert.equal(r.level, "none");
});

test("정상 구도(전신, 높이 약 65%, 중앙)", () => {
  const r = run(person({ top: 0.15, bottom: 0.82 }));
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("너무 큼 → 뒤로", () => {
  const r = run(person({ top: 0.04, bottom: 0.97 }));
  assert.ok(r.issues.some((t) => t.includes("너무 커요")));
});

test("너무 작음 → 앞으로", () => {
  const r = run(person({ top: 0.4, bottom: 0.65 }));
  assert.match(r.speak.concat(r.issues.join()), /앞으로|작아요/);
});

test("화면 왼쪽 치우침 → 화면 기준 오른쪽으로 이동", () => {
  const r = run(person({ top: 0.15, bottom: 0.82, cx: 0.25 }));
  assert.ok(r.issues.some((t) => t.includes("왼쪽으로 치우침")));
  const r2 = run(person({ top: 0.15, bottom: 0.82, cx: 0.25 }));
  assert.match(r2.speak, /오른쪽/);
});

test("발 안 보임(visibility 낮음) → 잘림", () => {
  const p = person({ top: 0.15, bottom: 1.1 });
  for (const i of [27, 28, 29, 30, 31, 32]) p[i].visibility = 0.1;
  const r = run(p);
  assert.ok(r.issues.some((t) => t.includes("발")));
});

test("머리 잘림", () => {
  const r = run(person({ top: -0.02, bottom: 0.7 }));
  assert.ok(r.issues.some((t) => t.includes("머리")));
});

test("상반신 모드는 발 없어도 OK(허리가 보이면)", () => {
  const p = person({ top: 0.1, bottom: 1.2 });
  for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) p[i].visibility = 0.1;
  const r = evaluate([p], { mode: "half", bg: "normal" });
  assert.ok(!r.issues.some((t) => t.includes("발")));
});

test("역광 감지", () => {
  const r = run(person({ top: 0.15, bottom: 0.82 }), { luma: { inside: 0.2, outside: 0.8 } });
  assert.ok(r.issues.some((t) => t.includes("역광")));
});

test("여러 명은 합집합 박스", () => {
  const r = evaluate([person({ top: 0.2, bottom: 0.8, cx: 0.3 }), person({ top: 0.2, bottom: 0.8, cx: 0.7 })], { mode: "full", bg: "normal" });
  assert.equal(r.metrics.people, 2);
  assert.ok(Math.abs(r.metrics.cx - 0.5) < 0.02);
});

test("여러 명: 오른쪽 끝 사람이 잘리면 방향을 알려줌", () => {
  const r = evaluate([person({ top: 0.2, bottom: 0.8, cx: 0.3 }), person({ top: 0.2, bottom: 0.8, cx: 0.97, halfW: 0.08 })], { mode: "full", bg: "normal" });
  assert.ok(r.issues.some((t) => t.includes("오른쪽 끝 사람이 잘려요")), JSON.stringify(r.issues));
});

test("여러 명: 뒤 사람의 발이 가려져도(맨 앞 사람 발이 보이면) 발 경고 없음", () => {
  const back = person({ top: 0.25, bottom: 0.7, cx: 0.65 });
  for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) back[i].visibility = 0.1;
  const r = evaluate([person({ top: 0.15, bottom: 0.82, cx: 0.4 }), back], { mode: "full", bg: "normal" });
  assert.ok(!r.issues.some((t) => t.includes("발")), JSON.stringify(r.issues));
});

test("히스테리시스: 경계값에서 margin이 있으면 OK 유지", () => {
  const p = person({ top: 0.08, bottom: 0.907 }); // 추정 인물 높이 약 0.77 > normal.max(0.75)
  assert.equal(run(p).ok, false);
  assert.equal(run(p, { margin: 0.05 }).ok, true);
});

test("Stabilizer: 순간적인 경고는 OK를 깨지 못함", () => {
  const st = new Stabilizer();
  const ok = { level: "ok", speak: "좋아요", issues: ["구도 좋아요"], metrics: {}, box: null };
  const warn = { level: "warn", speak: "조금 뒤로", issues: ["x"], metrics: {}, box: null };
  st.update(ok, 0);
  assert.equal(st.update(warn, 100).level, "ok");   // 0.1초 경고 → 유지
  assert.equal(st.update(ok, 200).level, "ok");
  assert.equal(st.update(warn, 300).level, "ok");
  assert.equal(st.update(warn, 1700).level, "ok");  // 1.4초 지속 < 1.5초
  assert.equal(st.update(warn, 1900).level, "warn"); // 1.6초 지속 → 전환
});

test("Stabilizer: 경고→OK는 1초 이상 계속 좋아야 전환", () => {
  const st = new Stabilizer();
  const ok = { level: "ok", speak: "좋아요", issues: [], metrics: {}, box: null };
  const warn = { level: "warn", speak: "조금 뒤로", issues: ["x"], metrics: {}, box: null };
  st.update(warn, 0);
  assert.equal(st.update(ok, 100).level, "warn");
  assert.equal(st.update(ok, 900).level, "warn");
  assert.equal(st.update(ok, 1200).level, "ok");
});
