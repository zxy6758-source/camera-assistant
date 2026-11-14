import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, Stabilizer, mergePeople, personBox, sortByX, smoothBoxes, classifyPosture } from "../logic.js";

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
  set(25, cx - halfW / 2, top + 0.8 * H); set(26, cx + halfW / 2, top + 0.8 * H); // 서 있을 때 무릎
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

const det = (l, t, r, b, score = 0.8) => ({ left: l, top: t, right: r, bottom: b, score });

test("병합: 포즈가 1명만 잡아도 검출기가 찾은 2번째 사람이 포함됨", () => {
  const pose = personBox(person({ top: 0.2, bottom: 0.8, cx: 0.3 }));
  const merged = mergePeople([pose], [det(0.2, 0.15, 0.4, 0.82), det(0.6, 0.25, 0.8, 0.8)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => m.source).sort(), ["both", "det"]);
  const r = evaluate(merged, { mode: "full", bg: "normal" });
  assert.equal(r.metrics.people, 2);
});

test("병합: 검출 박스만 있는 사람의 옆 잘림(오른쪽 끝)도 판정", () => {
  const merged = mergePeople([], [det(0.2, 0.2, 0.4, 0.8), det(0.85, 0.2, 1.0, 0.8)]);
  const r = evaluate(merged, { mode: "full", bg: "normal" });
  assert.ok(r.issues.some((t) => t.includes("오른쪽 끝 사람이 잘려요")), JSON.stringify(r.issues));
});

test("병합: 포즈에서 발이 안 잡혀도 검출 박스가 화면 안이면 '발' 경고 없음", () => {
  const p = person({ top: 0.15, bottom: 0.82 });
  for (const i of [27, 28, 29, 30, 31, 32]) p[i].visibility = 0.1;
  const merged = mergePeople([personBox(p)], [det(0.4, 0.12, 0.6, 0.85)]);
  const r = evaluate(merged, { mode: "full", bg: "normal" });
  assert.ok(!r.issues.some((t) => t.includes("발")), JSON.stringify(r.issues));
});

test("병합: 검출 박스가 아래 끝에 닿으면 발 잘림", () => {
  const merged = mergePeople([], [det(0.4, 0.3, 0.6, 1.0)]);
  const r = evaluate(merged, { mode: "full", bg: "normal" });
  assert.ok(r.issues.some((t) => t.includes("발")));
});

test("정렬/평활: 같은 인원이면 평활, 다르면 새 값", () => {
  const a = sortByX([det(0.6, 0.2, 0.8, 0.8), det(0.1, 0.2, 0.3, 0.8)]);
  assert.ok(a[0].left < a[1].left);
  const s = smoothBoxes(a, a.map((x) => ({ ...x, top: x.top + 0.1 })));
  assert.ok(s[0].top > a[0].top && s[0].top < a[0].top + 0.1);
  assert.equal(smoothBoxes(a, [a[0]]).length, 1);
});

test("병합: keepUnmatchedPose=false면 매칭 안 된 포즈는 버림(오래된 포즈로 인한 중복 방지)", () => {
  const pose = personBox(person({ top: 0.2, bottom: 0.8, cx: 0.3 }));
  const m = mergePeople([pose], [det(0.6, 0.25, 0.8, 0.8)], { keepUnmatchedPose: false });
  assert.equal(m.length, 1);
  assert.equal(mergePeople([pose], [det(0.6, 0.25, 0.8, 0.8)]).length, 2);
});

// 앉은 사람: 무릎을 골반(0.55H) 바로 아래로 올려 허벅지가 카메라를 향한 모습
function sitting(o) {
  const lm = person(o), H = o.bottom - o.top;
  lm[25] = { ...lm[25], y: o.top + 0.60 * H }; lm[26] = { ...lm[26], y: o.top + 0.60 * H };
  return lm;
}

test("자세 판별: 서있음/앉음/불명", () => {
  assert.equal(classifyPosture(personBox(person({ top: 0.1, bottom: 0.9 })).kneeRatio), "standing");
  assert.equal(classifyPosture(personBox(sitting({ top: 0.1, bottom: 0.9 })).kneeRatio), "sitting");
  const p = person({ top: 0.1, bottom: 0.9 }); p[25].visibility = p[26].visibility = 0.1;
  assert.equal(classifyPosture(personBox(p).kneeRatio), "unknown");
});

test("앉은 사람(높이 약 0.5)은 서 있는 기준으로는 '작아요', 앉은 기준으로는 OK", () => {
  const sit = sitting({ top: 0.3, bottom: 0.8 }); // 추정 높이 약 0.47 (서있는 normal 최소 0.5 미만)
  const standingRef = run(person({ top: 0.3, bottom: 0.8 }));
  assert.ok(standingRef.issues.some((x) => x.includes("너무 작아요")), JSON.stringify(standingRef.issues));
  const r = run(sit);
  assert.equal(r.metrics.allSitting, true);
  assert.ok(!r.issues.some((x) => x.includes("너무 작아요")), JSON.stringify(r.issues));
});

test("앉은 사람은 발이 안 보여도 '발' 경고 없음 / 서 있으면 경고", () => {
  const sit = sitting({ top: 0.25, bottom: 0.85 });
  for (const i of [27, 28, 29, 30, 31, 32]) sit[i].visibility = 0.1;
  assert.ok(!run(sit).issues.some((x) => x.includes("발")));
  const stand = person({ top: 0.1, bottom: 0.9 });
  for (const i of [27, 28, 29, 30, 31, 32]) stand[i].visibility = 0.1;
  assert.ok(run(stand).issues.some((x) => x.includes("발")));
});

test("자세 수동 고정(posture: sit)", () => {
  const r = run(person({ top: 0.3, bottom: 0.8 }), { posture: "sit" });
  assert.equal(r.metrics.allSitting, true);
});

test("혼합(서 있는 사람 + 앉은 사람)은 서 있는 기준 유지", () => {
  const r = evaluate([person({ top: 0.15, bottom: 0.82, cx: 0.3 }), sitting({ top: 0.35, bottom: 0.82, cx: 0.7 })], { mode: "full", bg: "normal" });
  assert.equal(r.metrics.allSitting, false);
  assert.deepEqual([r.metrics.postures.standing, r.metrics.postures.sitting], [1, 1]);
});
