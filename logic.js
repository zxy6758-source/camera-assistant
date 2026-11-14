// 구도 판정 로직 (DOM/카메라 의존 없음 → Node에서 단위 테스트 가능)
// 좌표는 모두 0~1 정규화(영상 가로·세로 기준), y는 아래로 증가.

export const VIS = 0.35; // 랜드마크를 "보인다"고 인정하는 최소 visibility

// 배경 비중 프리셋: 인물 높이가 화면 높이에서 차지하는 비율의 목표 범위
// (이 수치는 일반적으로 쓰는 경험적 기준이며 사용자가 취향에 맞게 조정 가능)
export const BG_PRESETS = {
  wide:   { label: "배경 넓게", min: 0.35, max: 0.55 },
  normal: { label: "보통",     min: 0.50, max: 0.75 },
  tight:  { label: "인물 중심", min: 0.70, max: 0.90 },
};

// 한 사람의 포즈 랜드마크(33개) → 경계 상자.
// MediaPipe Pose 인덱스: 0 코, 1~6 눈, 7·8 귀, 9·10 입, 11·12 어깨,
// 23·24 엉덩이, 27·28 발목, 29~32 발뒤꿈치/발끝
export function personBox(lm) {
  const ok = (i) => lm[i] && (lm[i].visibility ?? 1) >= VIS;
  const pts = lm.filter((p) => (p.visibility ?? 1) >= VIS);
  if (pts.length < 5) return null;

  let top = Math.min(...pts.map((p) => p.y));
  // 머리 꼭대기 추정: 눈~코 거리의 1.7배를 눈 위로 (얼굴 비율에 따른 근사치)
  if (ok(2) && ok(5) && ok(0)) {
    const eyeY = (lm[2].y + lm[5].y) / 2;
    const d = lm[0].y - eyeY;
    if (d > 0) top = Math.min(top, eyeY - 1.7 * d);
  }
  const bottom = Math.max(...pts.map((p) => p.y));
  const left = Math.min(...pts.map((p) => p.x));
  const right = Math.max(...pts.map((p) => p.x));

  const feetVisible = [27, 28, 29, 30, 31, 32].some(ok);
  const lowest = Math.max(...[27, 28, 29, 30, 31, 32].filter(ok).map((i) => lm[i].y), -Infinity);
  const hipsVisible = ok(23) || ok(24);
  return { top, bottom, left, right, feetVisible, feetY: lowest, hipsVisible };
}

export function unionBox(boxes) {
  return boxes.reduce((a, b) => ({
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    feetVisible: a.feetVisible && b.feetVisible,
    feetY: Math.max(a.feetY, b.feetY),
    hipsVisible: a.hipsVisible && b.hipsVisible,
  }));
}

/**
 * @param {Array} people   사람별 랜드마크 배열
 * @param {{mode:'full'|'half', bg:'wide'|'normal'|'tight', luma?:{inside:number,outside:number}}} opt
 * @returns {{ok:boolean, level:'none'|'warn'|'ok', issues:string[], speak:string|null, metrics:object|null, box:object|null}}
 *   issues는 우선순위 순. speak는 음성으로 읽을 가장 중요한 한 문장.
 *   방향 표현은 "화면 기준"(= 카메라가 찍은 영상 기준, 거울처럼 뒤집지 않음).
 */
export function evaluate(people, opt) {
  const mode = opt.mode ?? "full";
  const preset = BG_PRESETS[opt.bg ?? "normal"];
  const boxes = (people || []).map(personBox).filter(Boolean);
  if (boxes.length === 0) {
    return { ok: false, level: "none", issues: ["사람이 보이지 않아요"], speak: "사람이 보이지 않아요", metrics: null, box: null };
  }
  const b = unionBox(boxes);
  const h = b.bottom - b.top;
  const w = b.right - b.left;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  const clip = (v) => Math.max(0, Math.min(1, v));
  const areaRatio = clip(b.right - b.left) * clip(h); // 근사: 경계 상자 면적
  const metrics = {
    people: boxes.length,
    heightRatio: h,
    personArea: Math.min(1, areaRatio),
    backgroundArea: Math.max(0, 1 - areaRatio),
    cx, cy,
    headroom: b.top,
    footroom: 1 - (b.feetVisible ? b.feetY : b.bottom),
  };

  const issues = []; // {text, speak}
  const add = (text, speak = text) => issues.push({ text, speak });

  // 1) 잘림
  if (b.top < 0.03) add("머리 위 여백이 없어요", "머리가 잘려요. 뒤로 물러나세요");
  if (b.left < 0.02 || b.right > 0.98) add("몸이 옆으로 잘려요", "몸이 옆으로 잘려요. 화면 안쪽으로 모이세요");
  if (mode === "full") {
    if (!b.feetVisible || b.feetY > 0.985) add("발이 잘리거나 안 보여요", "발이 잘려요. 뒤로 물러나세요");
  } else if (!b.hipsVisible) {
    add("허리 아래까지 안 보여요", "상체가 너무 가까워요. 조금 뒤로 물러나세요");
  }

  // 2) 크기(= 배경 비중)
  const bodyH = h; // 보이는 부분(머리~가장 낮은 보이는 지점)의 높이 기준
  if (bodyH > preset.max) {
    add(`인물이 너무 커요 (${pct(bodyH)} / 목표 ${pct(preset.min)}~${pct(preset.max)})`, "조금 뒤로 물러나세요");
  } else if (bodyH < preset.min) {
    add(`인물이 너무 작아요 (${pct(bodyH)} / 목표 ${pct(preset.min)}~${pct(preset.max)})`, "조금 앞으로 오세요");
  }

  // 3) 좌우 위치 (화면 기준)
  const dx = cx - 0.5;
  if (Math.abs(dx) > 0.12) {
    const dir = dx < 0 ? "오른쪽" : "왼쪽";
    add(`화면 ${dx < 0 ? "왼쪽" : "오른쪽"}으로 치우침`, `화면 기준 ${dir}으로 이동하세요`);
  }

  // 4) 상하 균형: 머리 위 여백이 너무 크면(인물이 아래로 쏠림)
  if (b.top > 0.30 && bodyH <= preset.max) {
    add("인물이 화면 아래로 쏠려 있어요", "위쪽 여백이 커요. 카메라를 아래로 기울이세요");
  }

  // 5) 역광 (인물 영역 평균 밝기 / 바깥 평균 밝기)
  if (opt.luma && opt.luma.outside > 0.35) {
    const r = opt.luma.inside / opt.luma.outside;
    if (r < 0.6) add("역광이에요. 얼굴이 어두워요", "역광이에요. 빛을 등지지 마세요");
  }

  const ok = issues.length === 0;
  return {
    ok,
    level: ok ? "ok" : "warn",
    issues: ok ? ["구도 좋아요"] : issues.map((i) => i.text),
    speak: ok ? "좋아요. 구도 완성" : issues[0].speak,
    metrics,
    box: b,
  };
}

function pct(v) {
  return Math.round(v * 100) + "%";
}
