// 調理シーン用 実音源ローダ
// 既存の audio.ts は Web Audio API による合成音。こちらは MP3/WAV ファイルを
// AudioContext.decodeAudioData で読み込み、低レイテンシで再生する別系統。
// ファイルが存在しなければ「再生しない」のみ。合成音にフォールバックしない。

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();
const failed = new Set<string>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** ユーザー操作の最初のタップで AudioContext を起こす */
export function unlockCookingAudio(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

async function fetchBuffer(url: string): Promise<AudioBuffer | null> {
  const c = getCtx();
  if (!c) return null;
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) {
      failed.add(url);
      return null;
    }
    const arr = await res.arrayBuffer();
    const buf = await c.decodeAudioData(arr.slice(0));
    buffers.set(url, buf);
    return buf;
  } catch {
    failed.add(url);
    return null;
  }
}

/** 事前ロード。失敗しても例外は投げない。 */
export async function preloadCookingAudio(urls: string[]): Promise<void> {
  unlockCookingAudio();
  await Promise.all(
    urls.map(async (u) => {
      if (buffers.has(u) || failed.has(u)) return;
      let p = inflight.get(u);
      if (!p) {
        p = fetchBuffer(u);
        inflight.set(u, p);
      }
      await p;
      inflight.delete(u);
    }),
  );
}

export interface PlayOptions {
  volume?: number;   // 0..1
  rate?: number;     // 再生速度（ピッチも変わる）
  detune?: number;   // 半音 cents
}

/**
 * 実音源を再生。未ロードなら即座にロードを試みて再生（次回以降キャッシュ使用）。
 * ファイル不在時は何もせず（合成音にフォールバックしない）。
 */
export async function playCookingSE(
  url: string,
  opts: PlayOptions = {},
): Promise<void> {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      return;
    }
  }
  let buf = buffers.get(url);
  if (!buf && !failed.has(url)) {
    let p = inflight.get(url);
    if (!p) {
      p = fetchBuffer(url);
      inflight.set(url, p);
    }
    buf = (await p) ?? undefined;
    inflight.delete(url);
  }
  if (!buf) return;

  const src = c.createBufferSource();
  src.buffer = buf;
  if (opts.rate != null) src.playbackRate.value = opts.rate;
  if (opts.detune != null) src.detune.value = opts.detune;
  const gain = c.createGain();
  gain.gain.value = opts.volume ?? 1;
  src.connect(gain).connect(c.destination);
  src.start();
}

/** 何が読み込めて何が落ちたかをデバッグ表示用に返す */
export function getCookingAudioStatus(): {
  loaded: string[];
  failed: string[];
} {
  return {
    loaded: Array.from(buffers.keys()),
    failed: Array.from(failed),
  };
}
