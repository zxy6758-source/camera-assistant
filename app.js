import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { evaluate } from "./logic.js";

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
for (const id of ["mode", "bg"]) { $(id).value = store.get(id, $(id).value); $(id).onchange = () => store.set(id, $(id).value); }
for (const id of ["tts", "voice"]) { $(id).checked = store.get(id, "1") === "1"; $(id).onchange = () => { store.set(id, $(id).checked ? "1" : "0"); if (id === "voice") syncRecognition(); }; }

const log = (t) => (logEl.textContent = t);

// ---------- 음성 안내 (TTS) ----------
// 주의: 안내 문장에 명령어("촬영","스마일","김치","찰칵")를 넣지 않는다 → 자기 목소리로 셔터가 눌리는 것을 방지.
function speak(text) {
  if (!$("tts").checked || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR"; u.rate = 1.05;
  state.speakingUntil = Date.now() + 4000;
  u.onend = () => (state.speakingUntil = Date.now() + 800);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
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
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false, // 음성 인식과 마이크 충돌을 피하기 위해 영상만 사용
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : (video.onloadedmetadata = r)));
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  try { state.wake = await navigator.wakeLock?.request("screen"); } catch {}
  setupZoom(stream.getVideoTracks()[0]);
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
  const apply = async (z, btn) => {
    try {
      await track.applyConstraints({ advanced: [{ zoom: z }] });
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
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate },
    runningMode: "VIDEO", numPoses: 4,
  });
  try { state.landmarker = await make("GPU"); } catch { state.landmarker = await make("CPU"); }
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
  const res = state.landmarker.detectForVideo(video, ts);
  const people = res.landmarks || [];

  let luma = null;
  if (people.length) {
    const first = evaluate(people, { mode: $("mode").value, bg: $("bg").value });
    if (first.box) luma = lumaStats(first.box);
  }
  const r = evaluate(people, { mode: $("mode").value, bg: $("bg").value, luma });
  render(r, people);
  maybeSpeak(r.speak, Date.now());
}

function render(r, people) {
  banner.className = r.level;
  banner.textContent = r.level === "ok" ? "✔ 구도 좋아요" : r.issues[0];
  issuesEl.replaceChildren(...(r.level === "ok" ? [] : r.issues.slice(1, 3).map((t) => Object.assign(document.createElement("li"), { textContent: t }))));
  const m = r.metrics;
  metricsEl.replaceChildren(...(m ? [
    `인물 ${Math.round(m.heightRatio * 100)}%`,
    `배경 ${Math.round(m.backgroundArea * 100)}%`,
    `${m.cx < 0.5 ? "좌" : "우"} ${Math.round(Math.abs(m.cx - 0.5) * 200)}%`,
    `${m.people}명`,
  ].map((t) => Object.assign(document.createElement("span"), { textContent: t })) : []));

  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  if (r.box) {
    ctx.strokeStyle = r.level === "ok" ? "#2ecc71" : "#ff9f1a"; ctx.lineWidth = 6;
    const b = r.box;
    ctx.strokeRect(b.left * W, b.top * H, (b.right - b.left) * W, (b.bottom - b.top) * H);
  }
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
  const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  c.toBlob((blob) => {
    if (!blob) return log("사진 저장 실패");
    beep(1200, 80);
    const name = `photo_${stamp()}.jpg`;
    download(blob, name);
    const img = new Image(); img.src = URL.createObjectURL(blob); $("gallery").prepend(img);
    log(`저장: ${name} (브라우저 다운로드 폴더)`);
  }, "image/jpeg", 0.95);
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

$("gear").onclick = () => $("panel").classList.toggle("open");
$("shot").onclick = takePhoto;
$("vid").onclick = () => (state.recorder ? stopRecording() : startRecording());

// ---------- 음성 명령 (브라우저 음성 인식) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recWanted = false;
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
  rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { recWanted = false; log("마이크 권한이 필요해요"); } };
  rec.onend = () => { if (recWanted) setTimeout(() => { try { rec.start(); } catch {} }, 300); };
  try { rec.start(); } catch {}
}

// ---------- 시작 ----------
$("start").onclick = async () => {
  $("start").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("카메라 API 없음: HTTPS(또는 localhost)로 접속해야 해요");
    await startCamera();
    await loadModel();
    state.running = true;
    $("start").style.display = "none";
    log("준비 완료");
    speak("구도 도우미를 시작합니다");
    syncRecognition();
    requestAnimationFrame(loop);
  } catch (err) {
    log("오류: " + (err?.message || err)); $("start").disabled = false;
  }
};
