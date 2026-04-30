"use client";

// Step 3 リズム握り (1拍×2貫版)
// - 左手: 手のひら + 親指/中指/薬指/小指でシャリの下と左右を包む (静的シルエット)
// - 右手: 人差し指+中指の2本指のみ伸びた拳 (他は折り畳み)
//   ネタを2本指の腹に乗せて運び、シャリ上で着地・押さえ込み
// - 1タップ = 1貫の握り完了アクション (右手降下→ネタ着地→2本指押し込み→離脱)
// - 2貫連続で握る → 評価 (タップ間隔 + 総時間で ★1〜3)
// - SE: nigiri.mp3 (押し込み) + landing.mp3 (置き) + clap.mp3 (締め)
// - シャリ・ネタは SVG path で動的変形 (2本指の幅で凹み)

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  playCookingSE,
  preloadCookingAudio,
  unlockCookingAudio,
} from "@/lib/cooking-audio";
import { vibrate } from "@/lib/haptics";

type Species = "buri" | "suzuki" | "maiwashi" | "sawara" | "konoshiro";

const SPECIES_LIST: Species[] = [
  "buri",
  "suzuki",
  "maiwashi",
  "sawara",
  "konoshiro",
];
const SPECIES_LABEL: Record<Species, string> = {
  buri: "ブリ",
  suzuki: "スズキ",
  maiwashi: "マイワシ",
  sawara: "サワラ",
  konoshiro: "コノシロ",
};
const NETA_FRAC_LEFT: Record<Species, number> = {
  buri: 0.45,
  suzuki: 0.42,
  maiwashi: 0.4,
  sawara: 0.5,
  konoshiro: 0.4,
};
const NETA_FRAC_W = 1 / 7;
const FISH_IMG = (s: Species) => `/assets/cooking/fish/${s}.png`;

const SE_NIGIRI = "/audio/cooking/nigiri.mp3";
const SE_LANDING = "/audio/cooking/landing.mp3";
const SE_CLAP = "/audio/cooking/clap.mp3";
const ALL_SE = [SE_NIGIRI, SE_LANDING, SE_CLAP];

const STAGE_W = 380;
const STAGE_H = 620;

// 2貫を横並びに配置するため小ぶりに
const RICE_W = 132;
const RICE_H = 52;
const NETA_W = 146;
const NETA_H = 32;

const NIGIRI_POSITIONS = [
  { cx: STAGE_W * 0.32, cy: STAGE_H * 0.62 },
  { cx: STAGE_W * 0.68, cy: STAGE_H * 0.62 },
];

const TARGET_TAPS = 2;
const IDEAL_INTERVAL_MS = 550;
const TIME_BUDGET_MS = 1800;

// 物理 (semi-implicit Euler)
const HAND_K = 360;
const HAND_C = 24;
const HAND_X_K = 280;
const HAND_X_C = 22;
const PRESS_K = 480;
const PRESS_C = 17;
const HAND_REST_Y = -160; // シャリ cy からの上方向相対 (待機位置)
const HAND_PRESS_Y = -2; // 押し付け位置

// 1貫のフェーズ (ms)
const PHASE_DOWN = 130;
const PHASE_LAND = 70;
const PHASE_UP = 240;
const PHASE_TOTAL = PHASE_DOWN + PHASE_LAND + PHASE_UP;
const NETA_PLACE_AT = PHASE_DOWN * 0.85;

const SHAKE_PER_TAP = 4;
const SHAKE_DECAY = 110;

// 右手の人差し指+中指 (シャリ中心からの相対 X、px)
const FINGER_OFFSET_X = [-9, 9];
const FINGER_W_HALF = 5.5;
const FINGER_SIGMA_FRAC = 0.07; // ネタ凹みの広がり

type Phase = "ready" | "active" | "done" | "missed";

interface Tap {
  t: number;
}
interface NigiriItem {
  cx: number;
  cy: number;
  status: "pending" | "active" | "placed";
  startedAt: number;
  netaOnRice: boolean;
}
interface Spring1D {
  x: number;
  v: number;
}
interface NigiriView {
  press: number;
  netaOnRice: boolean;
  status: "pending" | "active" | "placed";
  contact: number; // 現在 active のときの右手2本指接触強度
}

interface ViewState {
  shakeX: number;
  shakeY: number;
  nigiri: NigiriView[];
  rightHandX: number;
  rightHandY: number;
  rightHandTilt: number;
  rightCarrying: boolean;
  rightContact: number;
  squeezesDone: number;
  remainingMs: number;
  visible: boolean; // 全部終わったら右手を非表示
}

const INITIAL_VIEW: ViewState = {
  shakeX: 0,
  shakeY: 0,
  nigiri: [
    { press: 0, netaOnRice: false, status: "pending", contact: 0 },
    { press: 0, netaOnRice: false, status: "pending", contact: 0 },
  ],
  rightHandX: NIGIRI_POSITIONS[0].cx,
  rightHandY: HAND_REST_Y,
  rightHandTilt: 0,
  rightCarrying: true,
  rightContact: 0,
  squeezesDone: 0,
  remainingMs: TIME_BUDGET_MS,
  visible: true,
};

interface Score {
  stars: 1 | 2 | 3;
  totalMs: number;
  intervalMs: number;
}

function clamp(n: number, lo: number, hi: number) {
  return n < lo ? lo : n > hi ? hi : n;
}

function spring(s: Spring1D, target: number, k: number, c: number, dt: number) {
  const a = (target - s.x) * k - s.v * c;
  s.v += a * dt;
  s.x += s.v * dt;
}

export default function RhythmNigiri() {
  const [phase, setPhase] = useState<Phase>("ready");
  const [species, setSpecies] = useState<Species>("buri");
  const [imgErr, setImgErr] = useState<Record<Species, boolean>>({
    buri: false,
    suzuki: false,
    maiwashi: false,
    sawara: false,
    konoshiro: false,
  });
  const [audioStatus, setAudioStatus] = useState<{ ok: number; total: number }>(
    { ok: 0, total: ALL_SE.length },
  );
  const [score, setScore] = useState<Score | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  const phaseRef = useRef<Phase>("ready");
  const tapsRef = useRef<Tap[]>([]);
  const nigiriListRef = useRef<NigiriItem[]>([
    {
      cx: NIGIRI_POSITIONS[0].cx,
      cy: NIGIRI_POSITIONS[0].cy,
      status: "pending",
      startedAt: 0,
      netaOnRice: false,
    },
    {
      cx: NIGIRI_POSITIONS[1].cx,
      cy: NIGIRI_POSITIONS[1].cy,
      status: "pending",
      startedAt: 0,
      netaOnRice: false,
    },
  ]);
  const startedAtRef = useRef<number>(0);
  const shakeAmpRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const finalizedRef = useRef<boolean>(false);

  const handXSpring = useRef<Spring1D>({ x: NIGIRI_POSITIONS[0].cx, v: 0 });
  const handYSpring = useRef<Spring1D>({ x: HAND_REST_Y, v: 0 });
  const pressSprings = useRef<Spring1D[]>([
    { x: 0, v: 0 },
    { x: 0, v: 0 },
  ]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const checks = await Promise.all(
        ALL_SE.map(async (u) => {
          try {
            const r = await fetch(u, { method: "HEAD" });
            return r.ok;
          } catch {
            return false;
          }
        }),
      );
      if (cancelled) return;
      const ok = checks.filter(Boolean).length;
      setAudioStatus({ ok, total: ALL_SE.length });
      const present = ALL_SE.filter((_, i) => checks[i]);
      preloadCookingAudio(present);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = useCallback(() => {
    tapsRef.current = [];
    nigiriListRef.current = [
      {
        cx: NIGIRI_POSITIONS[0].cx,
        cy: NIGIRI_POSITIONS[0].cy,
        status: "pending",
        startedAt: 0,
        netaOnRice: false,
      },
      {
        cx: NIGIRI_POSITIONS[1].cx,
        cy: NIGIRI_POSITIONS[1].cy,
        status: "pending",
        startedAt: 0,
        netaOnRice: false,
      },
    ];
    startedAtRef.current = 0;
    shakeAmpRef.current = 0;
    finalizedRef.current = false;
    handXSpring.current = { x: NIGIRI_POSITIONS[0].cx, v: 0 };
    handYSpring.current = { x: HAND_REST_Y, v: 0 };
    pressSprings.current = [
      { x: 0, v: 0 },
      { x: 0, v: 0 },
    ];
    setScore(null);
    phaseRef.current = "ready";
    setPhase("ready");
  }, []);

  const finalize = useCallback(() => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const taps = tapsRef.current;
    const intervalMs = taps.length >= 2 ? taps[1].t - taps[0].t : 0;
    const totalMs =
      taps.length >= 1 && startedAtRef.current
        ? taps[taps.length - 1].t - taps[0].t
        : 0;
    let stars: 1 | 2 | 3 = 1;
    if (intervalMs > 280 && intervalMs < 720 && intervalMs > 0) stars = 3;
    else if (intervalMs > 180 && intervalMs < 950) stars = 2;
    setScore({ stars, totalMs, intervalMs });

    playCookingSE(SE_LANDING, { volume: 0.7 });
    playCookingSE(SE_CLAP, { volume: 0.6 });
    vibrate([22, 14, 32]);
    phaseRef.current = "done";
    setPhase("done");
  }, []);

  const onSqueezeTap = useCallback(() => {
    unlockCookingAudio();
    const now = performance.now();
    const ph = phaseRef.current;
    if (ph === "ready") {
      tapsRef.current = [];
      nigiriListRef.current.forEach((n) => {
        n.status = "pending";
        n.startedAt = 0;
        n.netaOnRice = false;
      });
      finalizedRef.current = false;
      startedAtRef.current = now;
      phaseRef.current = "active";
      setPhase("active");
    } else if (ph !== "active") {
      reset();
      return;
    }

    const list = nigiriListRef.current;
    const targetIdx = list.findIndex((n) => n.status === "pending");
    if (targetIdx < 0) return;

    tapsRef.current.push({ t: now });
    list[targetIdx].status = "active";
    list[targetIdx].startedAt = now;
    shakeAmpRef.current = SHAKE_PER_TAP;

    const isLast = targetIdx + 1 === TARGET_TAPS;
    if (isLast) {
      playCookingSE(SE_NIGIRI, { volume: 1.0, rate: 0.92 });
      vibrate([26, 12, 36]);
    } else {
      playCookingSE(SE_NIGIRI, { volume: 0.85, rate: 1.0 });
      vibrate([20]);
    }
  }, [reset]);

  // RAF
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const prev = lastFrameRef.current || now;
      const dt = Math.min((now - prev) / 1000, 0.033);
      lastFrameRef.current = now;

      let remainingMs = TIME_BUDGET_MS;
      if (phaseRef.current === "active") {
        const elapsed = now - startedAtRef.current;
        remainingMs = Math.max(0, TIME_BUDGET_MS - elapsed);
        if (
          remainingMs <= 0 &&
          nigiriListRef.current.some((n) => n.status !== "placed") &&
          !finalizedRef.current
        ) {
          phaseRef.current = "missed";
          setPhase("missed");
          vibrate([10, 40, 10]);
        }
      }

      // shake decay
      if (shakeAmpRef.current > 0) {
        shakeAmpRef.current = Math.max(
          0,
          shakeAmpRef.current - SHAKE_DECAY * dt,
        );
      }
      const amp = shakeAmpRef.current;
      const shakeX = amp > 0 ? (Math.random() - 0.5) * amp * 1.4 : 0;
      const shakeY = amp > 0 ? (Math.random() - 0.5) * amp * 0.5 : 0;

      const list = nigiriListRef.current;

      // 各ニギリの press target
      const contacts = [0, 0];
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        let pressTarget = 0;
        if (n.status === "active") {
          const age = now - n.startedAt;
          if (age < PHASE_DOWN) {
            pressTarget =
              clamp(
                (age - NETA_PLACE_AT) / (PHASE_DOWN - NETA_PLACE_AT),
                0,
                1,
              ) * 0.55;
            if (age >= NETA_PLACE_AT) n.netaOnRice = true;
            contacts[i] = clamp(
              (age - PHASE_DOWN * 0.5) / (PHASE_DOWN * 0.5),
              0,
              1,
            );
          } else if (age < PHASE_DOWN + PHASE_LAND) {
            pressTarget = 1.0;
            n.netaOnRice = true;
            contacts[i] = 1;
          } else if (age < PHASE_TOTAL) {
            const t = (age - PHASE_DOWN - PHASE_LAND) / PHASE_UP;
            pressTarget = 0;
            contacts[i] = Math.max(0, 1 - t * 1.6);
          } else {
            n.status = "placed";
            n.netaOnRice = true;
            pressTarget = 0;
            contacts[i] = 0;
          }
        }
        spring(pressSprings.current[i], pressTarget, PRESS_K, PRESS_C, dt);
      }

      if (
        phaseRef.current === "active" &&
        tapsRef.current.length === TARGET_TAPS &&
        list.every((n) => n.status === "placed") &&
        !finalizedRef.current
      ) {
        finalize();
      }

      // 右手 target
      const activeIdx = list.findIndex((n) => n.status === "active");
      const pendingIdx = list.findIndex((n) => n.status === "pending");
      let handXTarget = NIGIRI_POSITIONS[0].cx;
      let handYTarget = HAND_REST_Y;
      let handTilt = 0;
      let carrying = true;
      let contact = 0;
      let visible = true;

      if (activeIdx >= 0) {
        const n = list[activeIdx];
        const age = now - n.startedAt;
        handXTarget = n.cx;
        if (age < PHASE_DOWN) {
          handYTarget = HAND_PRESS_Y;
          carrying = age < NETA_PLACE_AT;
          contact = contacts[activeIdx];
        } else if (age < PHASE_DOWN + PHASE_LAND) {
          handYTarget = HAND_PRESS_Y;
          carrying = false;
          contact = 1;
        } else if (age < PHASE_TOTAL) {
          const t = (age - PHASE_DOWN - PHASE_LAND) / PHASE_UP;
          handYTarget = HAND_PRESS_Y + (HAND_REST_Y - HAND_PRESS_Y) * t;
          carrying = false;
          contact = Math.max(0, 1 - t * 1.6);
          handTilt = Math.sin(t * Math.PI) * 4;
        }
      } else if (pendingIdx >= 0) {
        handXTarget = list[pendingIdx].cx;
        handYTarget = HAND_REST_Y;
        carrying = true;
      } else {
        // 全部完了: 右手は画面右上に退場
        handXTarget = STAGE_W * 0.92;
        handYTarget = HAND_REST_Y - 60;
        carrying = false;
        visible = phaseRef.current !== "done";
      }

      spring(handXSpring.current, handXTarget, HAND_X_K, HAND_X_C, dt);
      spring(handYSpring.current, handYTarget, HAND_K, HAND_C, dt);

      const squeezesDone = list.filter((n) => n.status === "placed").length;

      setView({
        shakeX,
        shakeY,
        nigiri: list.map((n, i) => ({
          press: pressSprings.current[i].x,
          netaOnRice: n.netaOnRice,
          status: n.status,
          contact: contacts[i],
        })),
        rightHandX: handXSpring.current.x,
        rightHandY: handYSpring.current.x,
        rightHandTilt: handTilt,
        rightCarrying: carrying,
        rightContact: contact,
        squeezesDone,
        remainingMs,
        visible,
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [finalize]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      onSqueezeTap();
    },
    [onSqueezeTap],
  );

  const showImg = !imgErr[species];
  const fillPct =
    phase === "active"
      ? Math.min(1, (TIME_BUDGET_MS - view.remainingMs) / TIME_BUDGET_MS)
      : 0;

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <header className="w-full flex items-center justify-between max-w-md px-2">
        <Link
          href="/"
          className="text-xs bg-slate-700 text-white px-3 py-1.5 rounded-full active:scale-95"
        >
          ← 戻る
        </Link>
        <span className="text-xs font-bold text-slate-700">
          Step3: 二貫握り (Prototype)
        </span>
        <span className="text-[10px] text-slate-500 w-12 text-right">
          {phase}
        </span>
      </header>

      <div className="flex gap-1 flex-wrap justify-center max-w-md">
        {SPECIES_LIST.map((s) => (
          <button
            key={s}
            onClick={() => {
              setSpecies(s);
              setImgErr((prev) => ({ ...prev, [s]: false }));
              if (phase !== "active") reset();
            }}
            className={`text-xs px-3 py-1 rounded-full active:scale-95 ${
              s === species
                ? "bg-amber-500 text-white font-bold"
                : "bg-slate-200 text-slate-700"
            }`}
          >
            {SPECIES_LABEL[s]}
          </button>
        ))}
      </div>

      <div
        className="relative overflow-hidden rounded-xl shadow-lg"
        style={{
          width: "min(calc(100vw - 16px), 480px)",
          aspectRatio: `${STAGE_W} / ${STAGE_H}`,
          background:
            "linear-gradient(180deg, #221c2a 0%, #2f2538 55%, #3c2a1f 100%)",
          touchAction: "none",
        }}
      >
        <div
          onPointerDown={onPointerDown}
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate(${view.shakeX}px, ${view.shakeY}px)`,
          }}
        >
          <NigiriSvgStage
            view={view}
            species={species}
            showImg={showImg}
            onImgError={() =>
              setImgErr((p) => ({ ...p, [species]: true }))
            }
          />
        </div>

        <Hud
          phase={phase}
          fillPct={fillPct}
          squeezesDone={view.squeezesDone}
        />

        {phase === "ready" && (
          <Hint text="タップで握る (1拍 = 1貫 / 計2貫)" />
        )}
        {phase === "missed" && (
          <Hint text="(時間切れ) タップでやり直し" tone="warn" />
        )}
        {phase === "done" && score && <ScoreOverlay score={score} />}
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5 max-w-md w-full px-2">
        <div>
          ネタ画像: {imgErr[species] ? "❌ 未配置" : "✅"} (/assets/cooking/fish/
          {species}.png から 1/7 切り出し)
        </div>
        <div>
          SE: {audioStatus.ok}/{audioStatus.total} 読み込み済 (nigiri / landing /
          clap.mp3)
        </div>
        <div className="text-slate-400">
          目安: 2タップ間隔 ~{IDEAL_INTERVAL_MS}ms。{TIME_BUDGET_MS}ms 以内
        </div>
      </div>
    </div>
  );
}

// ─────────────────── SVG ステージ ───────────────────
function NigiriSvgStage({
  view,
  species,
  showImg,
  onImgError,
}: {
  view: ViewState;
  species: Species;
  showImg: boolean;
  onImgError: () => void;
}) {
  const innerW = NETA_W / NETA_FRAC_W;
  const innerOffsetX = -(NETA_FRAC_LEFT[species] * innerW);

  // 各ニギリのネタ shape
  const netaShapes = view.nigiri.map((n) =>
    makeNetaShape(clamp(n.press, 0, 1.4), n.contact),
  );

  return (
    <svg
      viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, display: "block" }}
    >
      <defs>
        <radialGradient id="rn-top-light" cx="50%" cy="28%" r="70%">
          <stop offset="0" stopColor="rgba(255,236,200,0.26)" />
          <stop offset="1" stopColor="rgba(255,236,200,0)" />
        </radialGradient>
        <linearGradient id="rn-counter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3a2a1c" />
          <stop offset="60%" stopColor="#271a10" />
          <stop offset="100%" stopColor="#170d05" />
        </linearGradient>
        <radialGradient id="rn-rice" cx="50%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#fffef5" />
          <stop offset="55%" stopColor="#f3ecd1" />
          <stop offset="100%" stopColor="#c9bf99" />
        </radialGradient>
        <linearGradient id="rn-hand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0d3ad" />
          <stop offset="55%" stopColor="#cfa37b" />
          <stop offset="100%" stopColor="#724b30" />
        </linearGradient>
        <linearGradient id="rn-hand-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bb9573" />
          <stop offset="100%" stopColor="#5d3a22" />
        </linearGradient>
        <linearGradient id="rn-finger-tip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#dbb088" />
          <stop offset="100%" stopColor="#8a5e3e" />
        </linearGradient>
        <filter id="rn-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        {view.nigiri.map((_, i) => (
          <clipPath id={`rn-neta-clip-${i}`} key={i}>
            <path d={netaShapes[i].fill} />
          </clipPath>
        ))}
      </defs>

      {/* ライト */}
      <rect
        x={0}
        y={0}
        width={STAGE_W}
        height={STAGE_H}
        fill="url(#rn-top-light)"
        pointerEvents="none"
      />
      {/* カウンター */}
      <rect
        x={0}
        y={STAGE_H * 0.66}
        width={STAGE_W}
        height={STAGE_H * 0.34}
        fill="url(#rn-counter)"
      />
      <rect
        x={0}
        y={STAGE_H * 0.66}
        width={STAGE_W}
        height={1.5}
        fill="rgba(255,255,255,0.06)"
      />

      {/* 各ニギリ (左手 + シャリ + ネタ) */}
      {view.nigiri.map((n, i) => (
        <NigiriUnit
          key={i}
          cx={NIGIRI_POSITIONS[i].cx}
          cy={NIGIRI_POSITIONS[i].cy}
          press={clamp(n.press, 0, 1.4)}
          netaOnRice={n.netaOnRice}
          status={n.status}
          species={species}
          showImg={showImg}
          onImgError={onImgError}
          netaShape={netaShapes[i]}
          clipId={`rn-neta-clip-${i}`}
          innerW={innerW}
          innerOffsetX={innerOffsetX}
        />
      ))}

      {/* 右手 (1個、現在のターゲットに移動) */}
      {view.visible && (
        <RightHandSvg
          cx={view.rightHandX}
          cy={NIGIRI_POSITIONS[0].cy + view.rightHandY}
          tilt={view.rightHandTilt}
          carrying={view.rightCarrying}
          species={species}
          showImg={showImg}
          innerW={innerW}
          innerOffsetX={innerOffsetX}
          onImgError={onImgError}
        />
      )}
    </svg>
  );
}

// ─────────────────── ニギリ単体 ───────────────────
function NigiriUnit({
  cx,
  cy,
  press,
  netaOnRice,
  status,
  species,
  showImg,
  onImgError,
  netaShape,
  clipId,
  innerW,
  innerOffsetX,
}: {
  cx: number;
  cy: number;
  press: number;
  netaOnRice: boolean;
  status: "pending" | "active" | "placed";
  species: Species;
  showImg: boolean;
  onImgError: () => void;
  netaShape: { fill: string; outline: string; bottomShadow: string };
  clipId: string;
  innerW: number;
  innerOffsetX: number;
}) {
  const ricePath = makeRicePath(press);

  const dim = status === "pending" ? 0.85 : 1;

  return (
    <g opacity={dim}>
      {/* 影 */}
      <ellipse
        cx={cx}
        cy={cy + RICE_H + 6}
        rx={RICE_W / 2 + 12 + Math.max(0, press) * 8}
        ry={7 + Math.max(0, press) * 1.5}
        fill="rgba(0,0,0,0.5)"
        filter="url(#rn-shadow)"
      />

      {/* 左手の包み: シャリの「下」と「左右」を抱える */}
      <LeftHandWrap cx={cx} cy={cy} press={press} faded={status === "placed"} />

      {/* シャリ */}
      <g transform={`translate(${cx - RICE_W / 2} ${cy})`}>
        <path
          d={ricePath}
          fill="url(#rn-rice)"
          stroke="rgba(80,60,30,0.18)"
          strokeWidth={0.5}
        />
        <RiceGrains press={press} />
        <path
          d={ricePath}
          fill="none"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={0.9}
          opacity={0.5}
          style={{ mixBlendMode: "screen" }}
        />
      </g>

      {/* ネタ (シャリに乗っているとき) */}
      {netaOnRice && (
        <g
          transform={`translate(${cx - NETA_W / 2} ${cy - NETA_H * 0.5 + Math.max(0, press) * 3})`}
        >
          <path d={netaShape.bottomShadow} fill="rgba(0,0,0,0.32)" />
          <g clipPath={`url(#${clipId})`}>
            {showImg ? (
              <foreignObject x={0} y={0} width={NETA_W} height={NETA_H}>
                <NetaImageHtml
                  species={species}
                  innerW={innerW}
                  offsetX={innerOffsetX}
                  onError={onImgError}
                />
              </foreignObject>
            ) : (
              <NetaPlaceholder species={species} />
            )}
          </g>
          <path
            d={netaShape.outline}
            fill="none"
            stroke="rgba(40,15,10,0.42)"
            strokeWidth={1}
          />
          <path
            d={netaShape.outline}
            fill="none"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={0.7}
            opacity={0.45}
            transform="translate(0 -1)"
            style={{ mixBlendMode: "screen" }}
          />
        </g>
      )}
    </g>
  );
}

// ─── 左手 (シャリの下と左右を包むシルエット) ───
function LeftHandWrap({
  cx,
  cy,
  press,
  faded,
}: {
  cx: number;
  cy: number;
  press: number;
  faded: boolean;
}) {
  const w = RICE_W;
  const h = RICE_H;
  const widen = press * 5;
  const opacity = faded ? 0.55 : 1;

  // 手のひらは画面の手前 (下) からシャリを包み込む
  // 左親指: シャリの左前面に張り出す
  // 中/薬/小指: シャリの右側面に並んで見える
  const palmTopY = cy + h * 0.85; // シャリの下端から少し下
  const palmBotY = cy + h + 60;

  return (
    <g pointerEvents="none" opacity={opacity}>
      {/* 手のひら本体 (シャリの下、両側に広がる) */}
      <path
        d={[
          `M ${cx - w / 2 - 18 - widen} ${palmTopY}`,
          `Q ${cx - w / 2 - 22 - widen} ${(palmTopY + palmBotY) / 2} ${cx - w / 2 + 4} ${palmBotY}`,
          `L ${cx + w / 2 - 4} ${palmBotY}`,
          `Q ${cx + w / 2 + 22 + widen} ${(palmTopY + palmBotY) / 2} ${cx + w / 2 + 18 + widen} ${palmTopY}`,
          `Q ${cx} ${palmTopY + 22} ${cx - w / 2 - 18 - widen} ${palmTopY}`,
          "Z",
        ].join(" ")}
        fill="url(#rn-hand-shade)"
        stroke="rgba(40,20,10,0.5)"
        strokeWidth={0.8}
      />

      {/* 親指 (シャリの左前面に張り出す: 太く湾曲) */}
      <path
        d={[
          `M ${cx - w / 2 - 14 - widen} ${cy + h * 0.45}`,
          `Q ${cx - w / 2 - 22 - widen} ${cy + h * 0.65} ${cx - w / 2 - 16 - widen} ${cy + h * 0.95}`,
          `Q ${cx - w / 2 - 6 - widen} ${cy + h + 4} ${cx - w / 2 + 6} ${cy + h * 0.95}`,
          `Q ${cx - w / 2 + 4} ${cy + h * 0.6} ${cx - w / 2 - 6} ${cy + h * 0.4}`,
          "Z",
        ].join(" ")}
        fill="url(#rn-hand)"
        stroke="rgba(40,20,10,0.5)"
        strokeWidth={0.8}
      />
      {/* 親指の爪/関節 */}
      <ellipse
        cx={cx - w / 2 - 12 - widen * 0.7}
        cy={cy + h * 0.55}
        rx={4}
        ry={3}
        fill="rgba(255,255,255,0.25)"
        style={{ mixBlendMode: "screen" }}
      />

      {/* 右側に中指/薬指/小指 (寿司の右側面を包む 3本) */}
      {[
        { yFrac: 0.32, len: 26, w: 7.5 },
        { yFrac: 0.55, len: 28, w: 7.8 },
        { yFrac: 0.78, len: 24, w: 7.2 },
      ].map((f, i) => {
        const fy = cy + h * f.yFrac;
        const fxBase = cx + w / 2 + 8 + widen;
        const fxTip = fxBase + f.len;
        return (
          <g key={i}>
            <path
              d={[
                `M ${fxBase} ${fy - f.w}`,
                `L ${fxTip - f.w} ${fy - f.w * 0.8}`,
                `Q ${fxTip + 3} ${fy} ${fxTip - f.w} ${fy + f.w * 0.8}`,
                `L ${fxBase} ${fy + f.w}`,
                "Z",
              ].join(" ")}
              fill="url(#rn-hand)"
              stroke="rgba(40,20,10,0.4)"
              strokeWidth={0.6}
            />
            {/* 関節 */}
            <ellipse
              cx={fxBase + f.len * 0.5}
              cy={fy}
              rx={2.2}
              ry={1.2}
              fill="rgba(40,20,10,0.22)"
            />
          </g>
        );
      })}

      {/* 手のひらの陰影ライン */}
      <path
        d={`M ${cx - w / 2 + 4} ${palmBotY - 14} Q ${cx} ${palmBotY - 8} ${cx + w / 2 - 4} ${palmBotY - 14}`}
        fill="none"
        stroke="rgba(40,20,10,0.3)"
        strokeWidth={1}
      />
    </g>
  );
}

// ─── 右手 (人差し指+中指のみ伸ばした拳) ───
function RightHandSvg({
  cx,
  cy,
  tilt,
  carrying,
  species,
  showImg,
  innerW,
  innerOffsetX,
  onImgError,
}: {
  cx: number;
  cy: number;
  tilt: number;
  carrying: boolean;
  species: Species;
  showImg: boolean;
  innerW: number;
  innerOffsetX: number;
  onImgError: () => void;
}) {
  const fistW = 90;
  const fistH = 80;
  const fingerLen = 50;
  const fingerW = FINGER_W_HALF * 2;

  // 拳の中心は cx, cy - fistH/2 の上方
  const fistCx = cx;
  const fistCy = cy - fistH * 0.55 - fingerLen * 0.6;

  // 人差し指 (左) と 中指 (右) の指先 = (cx + offsetX, cy)
  const idxX = cx + FINGER_OFFSET_X[0];
  const midX = cx + FINGER_OFFSET_X[1];
  const tipY = cy;
  const baseY = fistCy + fistH * 0.4;

  return (
    <g
      transform={`rotate(${tilt} ${cx} ${cy})`}
      pointerEvents="none"
      style={{ filter: "drop-shadow(0 8px 10px rgba(0,0,0,0.55))" }}
    >
      {/* 拳本体 */}
      <ellipse
        cx={fistCx}
        cy={fistCy}
        rx={fistW / 2}
        ry={fistH / 2}
        fill="url(#rn-hand)"
        stroke="rgba(40,20,10,0.5)"
        strokeWidth={0.9}
      />
      {/* 拳の関節ライン (折りたたんだ薬指/小指のシワ) */}
      <path
        d={`M ${fistCx - fistW * 0.35} ${fistCy + fistH * 0.05} Q ${fistCx} ${fistCy + fistH * 0.15} ${fistCx + fistW * 0.35} ${fistCy + fistH * 0.05}`}
        fill="none"
        stroke="rgba(40,20,10,0.4)"
        strokeWidth={1.1}
      />
      <path
        d={`M ${fistCx - fistW * 0.3} ${fistCy + fistH * 0.22} Q ${fistCx} ${fistCy + fistH * 0.3} ${fistCx + fistW * 0.3} ${fistCy + fistH * 0.22}`}
        fill="none"
        stroke="rgba(40,20,10,0.3)"
        strokeWidth={0.9}
      />
      {/* 親指 (折り畳まれて拳の右側に張り出す) */}
      <ellipse
        cx={fistCx + fistW * 0.45}
        cy={fistCy + fistH * 0.1}
        rx={11}
        ry={16}
        fill="url(#rn-hand)"
        stroke="rgba(40,20,10,0.5)"
        strokeWidth={0.7}
        transform={`rotate(28 ${fistCx + fistW * 0.45} ${fistCy + fistH * 0.1})`}
      />

      {/* 人差し指 (左) */}
      <Finger2
        baseX={idxX}
        baseY={baseY}
        tipX={idxX}
        tipY={tipY}
        w={fingerW}
      />
      {/* 中指 (右、少し長め) */}
      <Finger2
        baseX={midX}
        baseY={baseY}
        tipX={midX}
        tipY={tipY + 1.5}
        w={fingerW}
      />

      {/* ネタ (carrying なら指先に乗っている) */}
      {carrying && (
        <g
          transform={`translate(${cx - NETA_W / 2} ${tipY - NETA_H * 0.55})`}
          style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.55))" }}
        >
          {showImg ? (
            <foreignObject x={0} y={0} width={NETA_W} height={NETA_H}>
              <NetaImageHtml
                species={species}
                innerW={innerW}
                offsetX={innerOffsetX}
                onError={onImgError}
              />
            </foreignObject>
          ) : (
            <NetaPlaceholder species={species} />
          )}
          {/* 上端の軽い陰影 */}
          <rect
            x={0}
            y={0}
            width={NETA_W}
            height={NETA_H}
            fill="none"
            stroke="rgba(40,15,10,0.4)"
            strokeWidth={0.8}
            rx={3}
          />
        </g>
      )}
    </g>
  );
}

function Finger2({
  baseX,
  baseY,
  tipX,
  tipY,
  w,
}: {
  baseX: number;
  baseY: number;
  tipX: number;
  tipY: number;
  w: number;
}) {
  const halfW = w / 2;
  return (
    <g>
      <path
        d={[
          `M ${baseX - halfW} ${baseY}`,
          `L ${tipX - halfW} ${tipY - halfW * 0.6}`,
          `Q ${tipX - halfW} ${tipY + halfW * 0.9} ${tipX} ${tipY + halfW * 1.1}`,
          `Q ${tipX + halfW} ${tipY + halfW * 0.9} ${tipX + halfW} ${tipY - halfW * 0.6}`,
          `L ${baseX + halfW} ${baseY}`,
          "Z",
        ].join(" ")}
        fill="url(#rn-hand)"
        stroke="rgba(40,20,10,0.5)"
        strokeWidth={0.7}
      />
      {/* 指先 highlight */}
      <ellipse
        cx={tipX}
        cy={tipY + halfW * 0.4}
        rx={halfW * 0.85}
        ry={halfW * 0.7}
        fill="url(#rn-finger-tip)"
        opacity={0.85}
      />
      {/* 第二関節 */}
      <path
        d={`M ${(baseX + tipX) / 2 - halfW * 0.7} ${(baseY + tipY) / 2} Q ${(baseX + tipX) / 2} ${(baseY + tipY) / 2 + 1.5} ${(baseX + tipX) / 2 + halfW * 0.7} ${(baseY + tipY) / 2}`}
        fill="none"
        stroke="rgba(40,20,10,0.32)"
        strokeWidth={0.6}
      />
    </g>
  );
}

// ─────────────────── path 生成 ───────────────────
function makeRicePath(press: number): string {
  const dent = Math.max(0, press) * 7; // 中央の凹みは控えめ (2本指で)
  const widen = Math.max(0, press) * 6;
  const w = RICE_W;
  const bot = RICE_H;
  const lx = -widen;
  const rx = w + widen;
  const topY = 0;

  // 上面に2本指の凹みを反映 (Gaussian)
  const sigma = w * FINGER_SIGMA_FRAC;
  const fingerCx = [w * 0.5 + FINGER_OFFSET_X[0], w * 0.5 + FINGER_OFFSET_X[1]];
  const topAt = (x: number) => {
    let d = 0;
    for (const fx of fingerCx) {
      const k = Math.exp(-(((x - fx) / sigma) ** 2));
      d += k;
    }
    // 全体のなめらかな盛り上がり (中央が高く両端低い) - dent
    const baseUp = -Math.cos((x / w) * Math.PI) * 1.5; // 中央はわずかに高く見える
    return topY + 2 + baseUp + dent * d - 3;
  };

  const samples = 22;
  const topPts: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * w;
    topPts.push([x, topAt(x)]);
  }

  return [
    `M ${lx.toFixed(2)} ${bot}`,
    `C ${(lx - 3).toFixed(2)} ${(bot * 0.55).toFixed(2)} ${(-widen * 0.4).toFixed(2)} ${(topY + 4).toFixed(2)} ${topPts[0][0].toFixed(2)} ${topPts[0][1].toFixed(2)}`,
    ...topPts
      .slice(1)
      .map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`),
    `C ${(w + widen * 0.4).toFixed(2)} ${(topY + 4).toFixed(2)} ${(rx + 3).toFixed(2)} ${(bot * 0.55).toFixed(2)} ${rx.toFixed(2)} ${bot}`,
    `Q ${(w * 0.5).toFixed(2)} ${(bot + 4).toFixed(2)} ${lx.toFixed(2)} ${bot}`,
    "Z",
  ].join(" ");
}

function makeNetaShape(
  press: number,
  contact: number,
): { fill: string; outline: string; bottomShadow: string } {
  const w = NETA_W;
  const h = NETA_H;
  const fingerDepth = Math.max(0, press) * 4 * (0.5 + contact * 0.5);
  const sideDrop = Math.max(0, press) * 1.6;
  const sigma = w * FINGER_SIGMA_FRAC;
  const fingerCx = [w * 0.5 + FINGER_OFFSET_X[0], w * 0.5 + FINGER_OFFSET_X[1]];

  const topY = (x: number) => {
    let d = 0;
    for (const fx of fingerCx) {
      const k = Math.exp(-(((x - fx) / sigma) ** 2));
      d += k;
    }
    const edge = Math.pow(Math.abs(x / w - 0.5) * 2, 4) * sideDrop;
    return Math.min(h * 0.55, fingerDepth * d + edge);
  };

  const samples = 22;
  const topPts: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * w;
    topPts.push([x, topY(x)]);
  }
  const topD = topPts
    .map(([x, y], i) =>
      i === 0
        ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
        : `L ${x.toFixed(2)} ${y.toFixed(2)}`,
    )
    .join(" ");
  const fill = `${topD} L ${w} ${h} L 0 ${h} Z`;
  const outline = topD;
  const bottomShadow = topPts
    .map(([x, y], i) => {
      const yy = y + h * 0.78 + Math.max(0, press) * 1.2;
      return i === 0
        ? `M ${x.toFixed(2)} ${yy.toFixed(2)}`
        : `L ${x.toFixed(2)} ${yy.toFixed(2)}`;
    })
    .concat([`L ${w} ${h}`, `L 0 ${h}`, "Z"])
    .join(" ");
  return { fill, outline, bottomShadow };
}

function RiceGrains({ press }: { press: number }) {
  const grains: { x: number; y: number; rx: number; ry: number; rot: number }[] =
    [
      { x: 0.18 * RICE_W, y: 0.32 * RICE_H, rx: 3.0, ry: 1.7, rot: -10 },
      { x: 0.34 * RICE_W, y: 0.2 * RICE_H, rx: 2.6, ry: 1.5, rot: 14 },
      { x: 0.5 * RICE_W, y: 0.24 * RICE_H, rx: 2.8, ry: 1.5, rot: 0 },
      { x: 0.66 * RICE_W, y: 0.2 * RICE_H, rx: 2.6, ry: 1.5, rot: -8 },
      { x: 0.82 * RICE_W, y: 0.32 * RICE_H, rx: 3.0, ry: 1.7, rot: 10 },
      { x: 0.3 * RICE_W, y: 0.5 * RICE_H, rx: 2.6, ry: 1.5, rot: 5 },
      { x: 0.5 * RICE_W, y: 0.46 * RICE_H, rx: 2.8, ry: 1.5, rot: -3 },
      { x: 0.7 * RICE_W, y: 0.5 * RICE_H, rx: 2.6, ry: 1.5, rot: -7 },
      { x: 0.4 * RICE_W, y: 0.74 * RICE_H, rx: 2.4, ry: 1.3, rot: 12 },
      { x: 0.6 * RICE_W, y: 0.74 * RICE_H, rx: 2.4, ry: 1.3, rot: -12 },
    ];
  return (
    <g pointerEvents="none">
      {grains.map((g, i) => {
        const cxn = (g.x - RICE_W / 2) / (RICE_W / 2);
        const offsetX = cxn * Math.max(0, press) * 3;
        const offsetY = Math.max(0, press) * (1.4 - Math.abs(cxn) * 1.2) * 3;
        const cx = g.x + offsetX;
        const cy = g.y + offsetY;
        return (
          <ellipse
            key={i}
            cx={cx}
            cy={cy}
            rx={g.rx}
            ry={g.ry}
            transform={`rotate(${g.rot} ${cx} ${cy})`}
            fill="rgba(255,255,255,0.94)"
            stroke="rgba(80,60,30,0.18)"
            strokeWidth={0.3}
          />
        );
      })}
    </g>
  );
}

function NetaImageHtml({
  species,
  innerW,
  offsetX,
  onError,
}: {
  species: Species;
  innerW: number;
  offsetX: number;
  onError: () => void;
}) {
  return (
    <div
      style={{
        width: NETA_W,
        height: NETA_H,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={FISH_IMG(species)}
        alt={SPECIES_LABEL[species]}
        onError={onError}
        draggable={false}
        style={{
          position: "absolute",
          left: offsetX,
          top: 0,
          width: innerW,
          height: NETA_H,
          objectFit: "cover",
          userSelect: "none",
          pointerEvents: "none",
          display: "block",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 30%, rgba(0,0,0,0.18) 100%)",
          mixBlendMode: "overlay",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function NetaPlaceholder({ species }: { species: Species }) {
  return (
    <g>
      <rect
        x={0}
        y={0}
        width={NETA_W}
        height={NETA_H}
        fill="rgba(255,80,80,0.15)"
        stroke="rgba(255,80,80,0.7)"
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
      <text
        x={NETA_W / 2}
        y={NETA_H / 2 + 4}
        fontSize={10}
        textAnchor="middle"
        fill="#ffd6d6"
      >
        📷 {species}.png 未配置
      </text>
    </g>
  );
}

// ─── HUD ───
function Hud({
  phase,
  fillPct,
  squeezesDone,
}: {
  phase: Phase;
  fillPct: number;
  squeezesDone: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {phase === "active" && (
        <div
          style={{
            position: "absolute",
            left: "6%",
            top: "59%",
            width: "88%",
            height: 6,
            background: "rgba(0,0,0,0.35)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${(1 - fillPct) * 100}%`,
              height: "100%",
              background:
                fillPct > 0.7
                  ? "linear-gradient(90deg,#ef4444,#f59e0b)"
                  : "linear-gradient(90deg,#facc15,#84cc16)",
              transition: "width 60ms linear",
            }}
          />
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "55%",
          width: "100%",
          display: "flex",
          justifyContent: "center",
          gap: "5%",
        }}
      >
        {Array.from({ length: TARGET_TAPS }).map((_, i) => (
          <span
            key={i}
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              background:
                i < squeezesDone
                  ? "rgba(245,200,80,1)"
                  : "rgba(255,255,255,0.18)",
              boxShadow:
                i < squeezesDone
                  ? "0 0 8px rgba(245,200,80,0.95)"
                  : "none",
              transition: "background 90ms",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Hint({
  text,
  tone = "info",
}: {
  text: string;
  tone?: "info" | "warn" | "ok";
}) {
  const bg =
    tone === "warn"
      ? "bg-rose-500/85"
      : tone === "ok"
        ? "bg-emerald-500/85"
        : "bg-slate-700/85";
  return (
    <div
      className={`absolute left-1/2 bottom-6 -translate-x-1/2 ${bg} text-white text-xs font-bold px-4 py-2 rounded-full shadow-lg pointer-events-none`}
    >
      {text}
    </div>
  );
}

function ScoreOverlay({ score }: { score: Score }) {
  const stars = "★".repeat(score.stars) + "☆".repeat(3 - score.stars);
  const comment =
    score.stars === 3
      ? "粋な握り!"
      : score.stars === 2
        ? "上々の手つき"
        : "もう一度ゆっくり";
  return (
    <div className="absolute left-1/2 bottom-6 -translate-x-1/2 bg-slate-900/90 text-white px-5 py-3 rounded-2xl shadow-xl pointer-events-none text-center">
      <div className="text-2xl font-bold tracking-widest text-amber-300">
        {stars}
      </div>
      <div className="text-[11px] text-slate-200 mt-0.5">{comment}</div>
      <div className="text-[10px] text-slate-400 mt-1">
        間隔 {Math.round(score.intervalMs)}ms · 合計{" "}
        {(score.totalMs / 1000).toFixed(2)}s
      </div>
      <div className="text-[10px] text-slate-400 mt-1">タップでもう一度</div>
    </div>
  );
}
