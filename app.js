import { PoseLandmarker, ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { evaluate, Stabilizer, personBox, mergePeople, sortByX, smoothBoxes } from "./logic.js?v=10";
const stab = new Stabilizer();

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");
const banner = $("banner"), issuesEl = $("issues"), metricsEl = $("metrics"), logEl = $("log");

const state = { running: false, landmarker: null, lastSpoken: "", lastSpeakAt: 0, candidate: "", candidateSince: 0,
  speakingUntil: 0, recorder: null, chunks: [], lastTrigger: 0, wake: null };

// ---------- 설정 저장 (실패해도 동작) ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
for (const id of ["mode", "bg", "posture"]) { $(id).value = store.get(id, $(id).value); $(id).onchange = () => store.set(id, $(id).value); }
for (const id of ["tts", "voice"]) { $(id).checked = store.get(id, "1") === "1"; $(id).onchange = () => { store.set(id, $(id).checked ? "1" : "0"); if (id === "voice") syncRecognition(); }; }

const log = (t) => (logEl.textContent = t);
window.addEventListener("error", (e) => log("오류: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("오류: " + (e.reason?.message || e.reason)));

// ---------- 음성 안내 (TTS) ----------
// 주의: 안내 문장에 명령어("촬영","스마일","김치","찰칵")를 넣지 않는다 → 자기 목소리로 셔터가 눌리는 것을 방지.
let koVoice = null; const keepAlive = [];
function pickVoice() {
  const vs = speechSynthesis.getVoices?.() || [];
  koVoice = vs.find((v) => /^ko[-_]KR$/i.test(v.lang)) || vs.find((v) => v.lang?.toLowerCase().startsWith("ko")) || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text) {
  const said = $("said");
  if (!("speechSynthesis" in window)) { said.textContent = "이 브라우저는 음성 안내를 지원하지 않아요 (화면 문구만 표시)"; return; }
  if (!$("tts").checked) return;
  const go = () => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR"; if (koVoice) u.voice = koVoice; u.rate = 1.05; u.volume = 1;
    keepAlive.push(u); if (keepAlive.length > 5) keepAlive.shift(); // 일부 브라우저에서 GC되면 onend/소리가 사라지는 문제 방지
    state.speakingUntil = Date.now() + 6000;
    pauseRecognition(); // 안드로이드는 음성 인식 중에 안내 소리가 안 나올 수 있어, 말하는 동안 인식을 멈춘다
    const done = () => { state.speakingUntil = Date.now() + 800; setTimeout(resumeRecognition, 400); };
    u.onend = done;
    u.onerror = (e) => { done(); said.textContent = "🔇 음성 오류: " + (e.error || "알 수 없음"); };
    speechSynthesis.resume();
    speechSynthesis.speak(u);
    said.textContent = "🔊 " + text + (koVoice ? "" : "  (한국어 음성 없음 → 기본 음성)");
  };
  // cancel 직후 바로 speak하면 소리가 사라지는 경우가 있어 잠깐 띄운다
  if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(go, 100); } else go();
}

function beep(freq = 880, ms = 120) {
  try {
    const ac = (beep.ac ??= new AudioContext());
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; g.gain.value = 0.2; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + ms / 1000);
  } catch {}
}

// 같은 안내가 0.8초 이상 유지될 때만, 마지막 안내로부터 3.5초 이상 지났을 때 말한다.
function maybeSpeak(text, now) {
  if (text !== state.candidate) { state.candidate = text; state.candidateSince = now; return; }
  if (now - state.candidateSince < 800) return;
  if (text === state.lastSpoken && now - state.lastSpeakAt < 12000) return; // 같은 말 반복은 12초 간격
  if (now - state.lastSpeakAt < 3500) return;
  state.lastSpoken = text; state.lastSpeakAt = now;
  speak(text);
}

// ---------- 카메라 ----------
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } },
    audio: false, // 음성 인식과 마이크 충돌을 피하기 위해 영상만 사용
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : (video.onloadedmetadata = r)));
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  try { state.wake = await navigator.wakeLock?.request("screen"); } catch {}
  const track = stream.getVideoTracks()[0];
  // 가능한 기기에서만 적용되는 보조 설정(실패해도 무시): 연속 자동 노출/화이트밸런스/초점
  try { await track.applyConstraints({ advanced: [{ exposureMode: "continuous", whiteBalanceMode: "continuous", focusMode: "continuous" }] }); } catch {}
  try { state.imageCapture = "ImageCapture" in window ? new ImageCapture(track) : null; } catch { state.imageCapture = null; }
  setupZoom(track);
}

// ---------- 줌 ----------
// 브라우저가 track capabilities의 zoom을 제공하는 기기에서만 동작(미지원 기기는 버튼 숨김).
function setupZoom(track) {
  const box = $("zoom"); box.replaceChildren();
  const cap = track.getCapabilities?.().zoom;
  if (!cap || !(cap.max > cap.min)) {
    box.appendChild(Object.assign(document.createElement("span"), { id: "zoomnote", textContent: "이 기기·브라우저는 줌 조절 미지원 (거리로 조절)" }));
    return;
  }
  const levels = [...new Set([cap.min, 0.5, 1, 2, 3, 5].filter((z) => z >= cap.min - 1e-6 && z <= cap.max + 1e-6).map((z) => +z.toFixed(1)))].sort((a, b) => a - b);
  state.zoom = { track, min: cap.min, max: cap.max, cur: track.getSettings?.().zoom ?? 1 };
  const apply = async (z, btn) => {
    try {
      await track.applyConstraints({ advanced: [{ zoom: z }] });
      state.zoom.cur = z;
      box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    } catch (e) { log("줌 적용 실패: " + (e?.message || e)); }
  };
  for (const z of levels) {
    const b = Object.assign(document.createElement("button"), { textContent: z + "x" });
    b.onclick = () => apply(z, b);
    box.appendChild(b);
  }
  const cur = track.getSettings?.().zoom ?? 1;
  const nearest = [...box.children].reduce((a, b) => (Math.abs(parseFloat(b.textContent) - cur) < Math.abs(parseFloat(a.textContent) - cur) ? b : a));
  nearest.classList.add("on");
}

async function loadModel() {
  log("모델 불러오는 중… (처음 한 번, 네트워크 필요)");
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const url = (size) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${size}/float16/1/pose_landmarker_${size}.task`;
  const make = (size, delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: url(size), delegate },
    runningMode: "VIDEO", numPoses: 6,
    // 기본값(0.5)보다 낮춰 멀리 있거나 일부 가려진 사람도 놓치지 않게 함
    minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
  });
  // 정확도가 더 높은 full 모델 우선, 실패 시 GPU→CPU, 그래도 안 되면 lite
  for (const [size, delegate] of [["full", "GPU"], ["full", "CPU"], ["lite", "CPU"]]) {
    try { state.landmarker = await make(size, delegate); state.modelInfo = `포즈 ${size}/${delegate}`; break; } catch {}
  }
  if (!state.landmarker) throw new Error("포즈 모델을 불러오지 못했어요");

  // 사람 전용 검출기: 여러 명/작은 사람을 포즈보다 잘 찾음. 실패해도 포즈만으로 동작.
  const durl = (n) => `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite${n}/float16/1/efficientdet_lite${n}.tflite`;
  for (const [n, delegate] of [[2, "GPU"], [2, "CPU"], [0, "CPU"]]) {
    try {
      state.detector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: durl(n), delegate },
        runningMode: "VIDEO", scoreThreshold: 0.35, maxResults: 10, categoryAllowlist: ["person"],
      });
      state.modelInfo += ` + 검출 lite${n}/${delegate}`; return;
    } catch {}
  }
  state.modelInfo += " (사람 검출기 로드 실패 → 포즈만 사용)";
}

// ---------- 안정화: 프레임 간 평활 + 순간 미검출 무시 ----------
let prevEntries = [], lastSeen = 0;
function stabilizeEntries(entries, now) {
  if (!entries.length) {
    if (prevEntries.length && now - lastSeen < 800) return prevEntries; // 0.8초 이내 끊김은 유지
    prevEntries = []; return [];
  }
  lastSeen = now;
  prevEntries = smoothBoxes(prevEntries, entries, 0.3);
  return prevEntries;
}

// ---------- 밝기(역광) ----------
const lc = document.createElement("canvas"); lc.width = 64; lc.height = 48;
const lctx = lc.getContext("2d", { willReadFrequently: true });
function lumaStats(box) {
  lctx.drawImage(video, 0, 0, lc.width, lc.height);
  const d = lctx.getImageData(0, 0, lc.width, lc.height).data;
  let si = 0, ni = 0, so = 0, no = 0;
  const x0 = box.left * lc.width, x1 = box.right * lc.width, y0 = box.top * lc.height, y1 = box.bottom * lc.height;
  for (let y = 0; y < lc.height; y++) for (let x = 0; x < lc.width; x++) {
    const i = (y * lc.width + x) * 4;
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) { si += l; ni++; } else { so += l; no++; }
  }
  return ni && no ? { inside: si / ni, outside: so / no } : null;
}

// ---------- 메인 루프 (약 8~10fps로 제한) ----------
let lastRun = 0, lastTs = -1;
function loop() {
  if (!state.running) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  if (now - lastRun < 110 || video.readyState < 2) return;
  lastRun = now;
  const ts = Math.max(now, lastTs + 1); lastTs = ts;
  const t0 = performance.now();
  state.tick = (state.tick || 0) + 1;
  // 느린 기기에서는 무거운 포즈 모델을 매 프레임 돌리지 않고 N프레임마다 갱신(검출기는 매 프레임)
  const freshPose = !state.lastPoses || state.tick % (state.poseEvery || 1) === 0;
  if (freshPose) state.lastPoses = state.landmarker.detectForVideo(video, ts).landmarks || [];
  const res = { landmarks: state.lastPoses };
  const poseBoxes = res.landmarks.map(personBox).filter(Boolean);
  let dets = [];
  if (state.detector) {
    try {
      const W = video.videoWidth, H = video.videoHeight;
      dets = state.detector.detectForVideo(video, ts).detections
        .filter((d) => d.categories?.[0]?.categoryName === "person" && d.boundingBox)
        .map((d) => { const b = d.boundingBox; return { left: b.originX / W, top: b.originY / H, right: (b.originX + b.width) / W, bottom: (b.originY + b.height) / H, score: d.categories[0].score }; });
    } catch {}
  }
  const people = stabilizeEntries(sortByX(mergePeople(poseBoxes, dets, { keepUnmatchedPose: freshPose || !state.detector })), now);

  const ms = performance.now() - t0;
  state.ms = state.ms ? 0.8 * state.ms + 0.2 * ms : ms;
  state.poseEvery = state.ms < 150 ? 1 : state.ms < 300 ? 2 : 3;
  state.fps = Math.round(1000 / Math.max(110, state.ms + 10));
  const margin = stab.isOk ? 0.05 : 0; // 좋아요 상태에서는 기준을 5%p 넓혀 경계에서 깜빡이지 않게
  const opts = { mode: $("mode").value, bg: $("bg").value, posture: $("posture").value, margin };
  let luma = null;
  if (people.length) {
    const first = evaluate(people, opts);
    if (first.box) luma = lumaStats(first.box);
  }
  const r = stab.update(evaluate(people, { ...opts, luma }), Date.now());
  render(r, people, res.landmarks || []);
  maybeSpeak(r.speak, Date.now());
}

function postureLabel(m) {
  const { standing: st, sitting: si, unknown: un } = m.postures;
  const parts = [];
  if (st) parts.push(`서 ${st}`);
  if (si) parts.push(`앉 ${si}`);
  if (un) parts.push(`자세? ${un}`);
  return parts.join("·");
}
const q5 = (v) => Math.round((v * 100) / 5) * 5; // 표시용: 5% 단위로 반올림해 숫자가 덜 흔들리게
function render(r, people, poses) {
  banner.className = r.level;
  banner.textContent = r.level === "ok" ? "✔ 구도 좋아요" : r.issues[0];
  issuesEl.replaceChildren(...(r.level === "ok" ? [] : r.issues.slice(1, 3).map((t) => Object.assign(document.createElement("li"), { textContent: t }))));
  const m = r.metrics;
  metricsEl.replaceChildren(...[...(m ? [
    `인물 ${q5(m.heightRatio)}%`,
    `배경 ${q5(m.backgroundArea)}%`,
    `${m.cx < 0.5 ? "좌" : "우"} ${q5(Math.abs(m.cx - 0.5) * 2)}%`,
    `${m.people}명`,
    postureLabel(m),
  ] : []), `${state.fps ?? "-"}fps`].map((t) => Object.assign(document.createElement("span"), { textContent: t })));

  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.fillStyle = "rgba(0,200,255,.9)";
  for (const p of poses) for (const pt of p) if ((pt.visibility ?? 1) >= 0.35) { ctx.beginPath(); ctx.arc(pt.x * W, pt.y * H, 5, 0, 6.283); ctx.fill(); }
  // 인식된 사람마다 얇은 박스 (몇 명이 잡혔는지 눈으로 확인용)
  ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 2;
  for (const p of people) ctx.strokeRect(p.left * W, p.top * H, (p.right - p.left) * W, (p.bottom - p.top) * H);
  if (r.box) {
    ctx.strokeStyle = r.level === "ok" ? "#2ecc71" : "#ff9f1a"; ctx.lineWidth = 6;
    const b = r.box;
    ctx.strokeRect(b.left * W, b.top * H, (b.right - b.left) * W, (b.bottom - b.top) * H);
  }
}

// ---------- 핀치 줌 (두 손가락) ----------
{
  const pts = new Map(); let d0 = 0, z0 = 1, busy = false;
  const stage = $("stage");
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, #panel")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && state.zoom) { d0 = dist(); z0 = state.zoom.cur; }
  });
  stage.addEventListener("pointermove", async (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size !== 2 || !state.zoom || busy || !d0) return;
    const z = Math.min(state.zoom.max, Math.max(state.zoom.min, z0 * (dist() / d0)));
    busy = true;
    try { await state.zoom.track.applyConstraints({ advanced: [{ zoom: z }] }); state.zoom.cur = z; $("zoom").querySelectorAll("button").forEach((b) => b.classList.remove("on")); } catch {}
    busy = false;
  });
  const up = (e) => { pts.delete(e.pointerId); d0 = 0; };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
}

// ---------- 촬영 ----------
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }

async function countdown(sec) {
  const el = $("countdown"); el.style.display = "flex";
  for (let s = sec; s > 0; s--) { el.textContent = s; beep(660, 100); await new Promise((r) => setTimeout(r, 1000)); }
  el.style.display = "none";
}

async function takePhoto() {
  if (!state.running) return;
  await countdown(2);
  let blob = null, how = "화면 캡처";
  // 정지 사진 모드(takePhoto)는 영상 프레임 캡처보다 보통 화질이 좋고 노이즈가 적다(기기 지원 시)
  if (state.imageCapture) {
    try { blob = await state.imageCapture.takePhoto(); how = "정지 사진 모드"; } catch { blob = null; }
  }
  if (!blob) {
    const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
  }
  if (!blob) return log("사진 저장 실패");
  beep(1200, 80);
  const ext = blob.type.includes("png") ? "png" : "jpg";
  const name = `photo_${stamp()}.${ext}`;
  download(blob, name);
  const img = new Image(); img.src = URL.createObjectURL(blob); $("gallery").prepend(img);
  log(`저장: ${name} (${how}, 브라우저 다운로드 폴더)`);
}

function startRecording() {
  if (state.recorder || !state.running) return;
  const type = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported?.(t));
  state.chunks = [];
  state.recorder = new MediaRecorder(video.srcObject, type ? { mimeType: type } : undefined);
  state.recorder.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
  state.recorder.onstop = () => {
    const mime = state.recorder.mimeType || "video/webm";
    const blob = new Blob(state.chunks, { type: mime });
    const name = `video_${stamp()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
    download(blob, name); log(`저장: ${name} (소리 없음)`);
    state.recorder = null; $("rec").style.display = "none"; $("vid").textContent = "동영상";
  };
  state.recorder.start(); beep(900, 150);
  $("rec").style.display = "block"; $("vid").textContent = "정지";
}
const stopRecording = () => state.recorder && state.recorder.state !== "inactive" && (beep(500, 150), state.recorder.stop());

$("ttsTest").onclick = () => speak("음성 안내 테스트입니다. 이 소리가 들리면 정상입니다");
$("gear").onclick = () => $("panel").classList.toggle("open");
$("shot").onclick = takePhoto;
$("vid").onclick = () => (state.recorder ? stopRecording() : startRecording());

// ---------- 음성 명령 (브라우저 음성 인식) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recWanted = false, recPaused = false;
function pauseRecognition() { recPaused = true; try { rec?.abort(); } catch {} }
function resumeRecognition() { recPaused = false; if (recWanted && rec) { try { rec.start(); } catch {} } }
function syncRecognition() {
  recWanted = state.running && $("voice").checked;
  if (!recWanted) { try { rec?.stop(); } catch {} return; }
  if (!SR) return log("이 브라우저는 음성 인식을 지원하지 않아요 (Android Chrome 권장). 화면 버튼을 사용하세요.");
  if (rec) return;
  rec = new SR(); rec.lang = "ko-KR"; rec.continuous = true; rec.interimResults = true;
  rec.onresult = (e) => {
    const now = Date.now();
    if (now < state.speakingUntil) return;        // 안내 음성 중/직후 입력 무시
    if (now - state.lastTrigger < 4000) return;   // 연속 트리거 방지
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.replace(/\s+/g, "");
      if (/동영상촬영|녹화/.test(t)) { state.lastTrigger = now; startRecording(); return; }
      if (/정지|중지|그만/.test(t)) { state.lastTrigger = now; stopRecording(); return; }
      if (/스마일|김치|촬영|찰칵/.test(t)) { state.lastTrigger = now; takePhoto(); return; }
    }
  };
  rec.onerror = (e) => {
    const msgs = {
      "not-allowed": MIC_HELP, "service-not-allowed": MIC_HELP,
      "audio-capture": "마이크 장치를 찾지 못했어요",
      "network": "음성 인식은 인터넷이 필요해요(연결 확인)",
    };
    if (msgs[e.error]) {
      micNote(msgs[e.error]);
      if (e.error !== "network") { recWanted = false; $("voice").checked = false; }
    }
  };
  rec.onend = () => { if (recWanted && !recPaused) setTimeout(() => { try { rec.start(); } catch {} }, 300); };
  try { rec.start(); } catch {}
}

// ---------- 시작 ----------
// ---------- 마이크 권한 ----------
const micNote = (t) => { $("said").textContent = "🎤 " + t; log("🎤 " + t); }; // 안내 음성 문구에 덮이지 않게 로그에도 남김
const MIC_HELP = "마이크가 차단돼 있어요. Chrome 주소창 왼쪽 아이콘 → 권한(또는 사이트 설정) → 마이크 → 허용 후 새로고침. 그래도 안 되면 폰 설정 → 앱 → Chrome → 권한 → 마이크 허용. (음성 명령 없이 버튼으로는 계속 쓸 수 있어요)";
async function requestMic() {
  let st = "unknown";
  try { st = (await navigator.permissions.query({ name: "microphone" })).state; } catch {}
  if (st === "denied") return { ok: false, msg: MIC_HELP };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, msg: "이 브라우저는 마이크 접근을 지원하지 않아요" };
  try {
    // 권한 프롬프트를 띄우기 위해 잠깐 열었다 닫는다 (녹음하지 않음)
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (e) {
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") return { ok: false, msg: MIC_HELP };
    if (e?.name === "NotFoundError") return { ok: false, msg: "마이크 장치를 찾지 못했어요" };
    return { ok: false, msg: "마이크 오류: " + (e?.name || e) };
  }
}
async function enableVoice() {
  const r = await requestMic();
  if (r.ok) { $("voice").checked = true; store.set("voice", "1"); syncRecognition(); micNote("음성 명령 켜짐"); }
  else { $("voice").checked = false; syncRecognition(); micNote(r.msg); }
  return r.ok;
}
$("micRetry").onclick = enableVoice;

$("start").onclick = async () => {
  $("start").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("카메라 API 없음: HTTPS(또는 localhost)로 접속해야 해요");
    // 마이크 권한은 클릭 직후(사용자 동작이 유효할 때) 먼저 요청한다. 거부돼도 카메라/음성 안내는 계속 진행.
    const mic = $("voice").checked ? await requestMic() : { ok: false, msg: "" };
    if (!mic.ok) { $("voice").checked = false; if (mic.msg) micNote(mic.msg); }
    await startCamera();
    await loadModel();
    state.running = true;
    $("start").style.display = "none";
    if (!logEl.textContent.startsWith("🎤")) log("준비 완료 (모델: " + state.modelInfo + ")");
    const said0 = $("said").textContent;
    speak("구도 도우미를 시작합니다");
    if (said0.startsWith("🎤")) setTimeout(() => ($("said").textContent = said0), 300); // 마이크 안내가 덮이지 않게
    syncRecognition();
    requestAnimationFrame(loop);
  } catch (err) {
    log("오류: " + (err?.message || err)); $("start").disabled = false;
  }
};
