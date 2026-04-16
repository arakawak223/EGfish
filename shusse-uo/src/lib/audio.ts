// Web Audio API サウンドマネージャー
// BGM + 効果音生成

let audioCtx: AudioContext | null = null;
let bgmElement: HTMLAudioElement | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

// --- BGM ---
export function playBGM() {
  if (typeof window === "undefined") return;
  if (!bgmElement) {
    bgmElement = new Audio("/assets/bgm.mp3");
    bgmElement.loop = true;
    bgmElement.volume = 0.3;
  }
  bgmElement.play().catch(() => {});
}

export function stopBGM() {
  if (bgmElement) {
    bgmElement.pause();
    bgmElement.currentTime = 0;
  }
}

// --- 効果音 ---

// 魚がかかった瞬間: 重厚な「ガツン！」+ 水しぶき感
export function playSEHit() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  // 低音インパクト
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(150, t);
  osc1.frequency.exponentialRampToValueAtTime(50, t + 0.2);
  gain1.gain.setValueAtTime(0.6, t);
  gain1.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(t);
  osc1.stop(t + 0.25);

  // 中音アタック
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(400, t);
  osc2.frequency.exponentialRampToValueAtTime(120, t + 0.1);
  gain2.gain.setValueAtTime(0.3, t);
  gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(t);
  osc2.stop(t + 0.15);

  // 水しぶきノイズ
  const bufferSize = ctx.sampleRate * 0.15;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize) * 0.3;
  }
  const noise = ctx.createBufferSource();
  const noiseFilter = ctx.createBiquadFilter();
  const noiseGain = ctx.createGain();
  noise.buffer = buffer;
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = 2000;
  noiseGain.gain.setValueAtTime(0.25, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
  noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
  noise.start(t);
}

// タイミングリング成功: 心地よい「ポン♪」
export function playSEReel() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.setValueAtTime(880, t + 0.05);
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

// 釣り上げ成功: 華やかなファンファーレ「テレレレ♪」
export function playSECatch() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const notes = [523, 659, 784, 1047, 1319]; // C5, E5, G5, C6, E6
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + i * 0.1;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
    gain.gain.setValueAtTime(0.2, start + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.01, start + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.35);

    // ハーモニクス（倍音で厚みを出す）
    if (i >= 2) {
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "triangle";
      osc2.frequency.value = freq * 1.5;
      gain2.gain.setValueAtTime(0, start);
      gain2.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain2.gain.exponentialRampToValueAtTime(0.01, start + 0.25);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(start);
      osc2.stop(start + 0.25);
    }
  });
}

// バラシ/逃亡: 下降音「ブゥーン↓」
export function playSEMiss() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.3);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.35);
}

// 包丁1回切り: 「スッ」（軽いスライス音）
export function playSESlice() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  // ホワイトノイズでスライス感
  const bufferSize = ctx.sampleRate * 0.1;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const env = i < bufferSize * 0.1 ? i / (bufferSize * 0.1) : 1 - (i - bufferSize * 0.1) / (bufferSize * 0.9);
    data[i] = (Math.random() * 2 - 1) * env * 0.4;
  }
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.value = 2500;
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(t);

  // トーンでピッチ感を追加
  const osc = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1800, t);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.06);
  gain2.gain.setValueAtTime(0.06, t);
  gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.06);
  osc.connect(gain2).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.07);
}

// さばき完了: 達成感のある「トン♪テテン♪」
export function playSEPrepDone() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  // まな板を叩く「トン」
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(250, t);
  osc1.frequency.exponentialRampToValueAtTime(100, t + 0.08);
  gain1.gain.setValueAtTime(0.3, t);
  gain1.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(t);
  osc1.stop(t + 0.12);

  // 完成音「テテン♪」
  [784, 988, 1175].forEach((freq, i) => { // G5, B5, D6
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + 0.15 + i * 0.08;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.01, start + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.25);
  });
}

// 売上音: レジの「チャリーン♪」（高音キラキラ）
export function playSESell() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  // コインの金属音
  [2093, 2637, 3136, 3520].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + i * 0.04;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.5);
  });

  // キラキラの倍音
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(5000, t + 0.05);
  osc.frequency.exponentialRampToValueAtTime(3000, t + 0.3);
  gain.gain.setValueAtTime(0.04, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t + 0.05);
  osc.stop(t + 0.35);
}

// ─── 調理用SE ───

// 包丁が身に入る「トクッ」
export function playSEKnifeEntry() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  // 木を叩くような短いアタック
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(280, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.06);
  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

// 骨に沿うスムーズな「スルスル」
export function playSESmoothSlide() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const bufferSize = ctx.sampleRate * 0.06;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.08 * (1 - i / bufferSize);
  }
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.value = 4000;
  gain.gain.setValueAtTime(0.08, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.06);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(t);
}

// 骨に引っかかる「ガリッ」
export function playSEBoneResist() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(400, t);
  osc.frequency.setValueAtTime(250, t + 0.03);
  osc.frequency.setValueAtTime(450, t + 0.06);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

// シャリを掴む「サクッ」
export function playSERiceGrab() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const bufferSize = ctx.sampleRate * 0.08;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const env = i < bufferSize * 0.2 ? i / (bufferSize * 0.2) : 1 - (i - bufferSize * 0.2) / (bufferSize * 0.8);
    data[i] = (Math.random() * 2 - 1) * env * 0.25;
  }
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 3000;
  gain.gain.setValueAtTime(0.15, t);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(t);
}

// ネタを合わせる「ペタッ」
export function playSENetaCombine() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(500, t);
  osc.frequency.exponentialRampToValueAtTime(200, t + 0.05);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.07);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.08);
}

// 握り完成の完璧な「フワッ」
export function playSENigiriPerfect() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  // 柔らかいベル音 + エアリーなパッド
  [523, 659, 784].forEach((freq, i) => { // C5, E5, G5
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + i * 0.05;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, start + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.3);
  });
}

// 握りの失敗「ブスッ」
export function playSENigiriFail() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.15);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

// 糸切れ: 「パンッ」
export function playSESnap() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.06);
  gain.gain.setValueAtTime(0.35, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);

  // 切れた糸のびよーん
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(600, t + 0.05);
  osc2.frequency.exponentialRampToValueAtTime(50, t + 0.3);
  gain2.gain.setValueAtTime(0.08, t + 0.05);
  gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(t + 0.05);
  osc2.stop(t + 0.3);
}
