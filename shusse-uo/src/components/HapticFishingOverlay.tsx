"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FishSpecies, FISH_DATABASE } from "@/lib/fish-data";
import { vibrate, vibrateFishSpecific } from "@/lib/haptics";
import { playSEHit, playSEMiss, playSEReel } from "@/lib/audio";

// FishingGame 側の SwimmingFish と互換の最小セット
export interface ProbeFish {
  id: string;
  species: FishSpecies;
  stageIndex: number;
  x: number;
  y: number;
  depth: number;
}

interface Props {
  fishes: ProbeFish[];
  paused: boolean;
  onHook: (fish: ProbeFish) => void;
  onBarashi: (fish: ProbeFish | null) => void;
  onBiteStart?: (fish: ProbeFish) => void;
}

type Phase = "idle" | "probing" | "biting" | "resolved";

// 近接 → 揺れる間隔（ms）: 近いほど短い
const PULSE_FAR_MS = 520;
const PULSE_NEAR_MS = 120;
const DETECTION_RADIUS = 180;   // この半径以内から反応開始
const BITE_RADIUS = 28;         // 噛む距離
const BITE_HOLD_MS = 420;       // この時間一定距離以内に留まると噛みつく
const BITE_TAP_WINDOW_MS = 900; // ガツン！後のタップ受付猶予

export default function HapticFishingOverlay({
  fishes, paused, onHook, onBarashi, onBiteStart,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [probe, setProbe] = useState<{ x: number; y: number } | null>(null);
  const [biteFish, setBiteFish] = useState<ProbeFish | null>(null);
  const [biteWindowRemaining, setBiteWindowRemaining] = useState(1);
  const [nearestDist, setNearestDist] = useState<number>(Infinity);

  const fishesRef = useRef(fishes);
  useEffect(() => { fishesRef.current = fishes; }, [fishes]);

  const probeRef = useRef<{ x: number; y: number } | null>(null);
  const hoverRef = useRef<{ fishId: string; since: number } | null>(null);
  const lastPulseRef = useRef<number>(0);
  const biteStartRef = useRef<number>(0);
  const resolvedRef = useRef(false);

  // 確定時のガード
  const resolveOnce = useCallback((fn: () => void) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setPhase("resolved");
    fn();
  }, []);

  // 外部 paused で状態リセット（探索中断）
  useEffect(() => {
    if (!paused) return;
    if (phase === "probing") {
      setPhase("idle");
      setProbe(null);
      probeRef.current = null;
      hoverRef.current = null;
    }
  }, [paused, phase]);

  // ── 近接ハプティクス・ループ ──
  useEffect(() => {
    if (phase !== "probing" || paused) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const p = probeRef.current;
      if (p) {
        // 捕獲可能な魚（手前にいる魚）だけ対象
        let minDist = Infinity;
        let closest: ProbeFish | null = null;
        for (const f of fishesRef.current) {
          if (f.depth < 0.5) continue;
          const d = Math.hypot(p.x - f.x, p.y - f.y);
          if (d < minDist) { minDist = d; closest = f; }
        }
        setNearestDist(minDist);

        // 近接パルス
        if (closest && minDist < DETECTION_RADIUS) {
          const t = Math.max(0, Math.min(1, 1 - minDist / DETECTION_RADIUS));
          const interval = PULSE_FAR_MS - (PULSE_FAR_MS - PULSE_NEAR_MS) * t;
          if (now - lastPulseRef.current > interval) {
            lastPulseRef.current = now;
            // 近いほど強め（ただし微細）
            const ms = Math.max(5, Math.round(6 + t * 10));
            vibrate([ms]);
          }

          // BITE_RADIUS 内に一定時間留まったら噛む
          if (minDist < BITE_RADIUS) {
            const hover = hoverRef.current;
            if (!hover || hover.fishId !== closest.id) {
              hoverRef.current = { fishId: closest.id, since: now };
            } else if (now - hover.since >= BITE_HOLD_MS) {
              // 噛みついた！
              triggerBite(closest);
            }
          } else {
            hoverRef.current = null;
          }
        } else {
          hoverRef.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused]);

  // ── ガツン発動 ──
  const triggerBite = useCallback((fish: ProbeFish) => {
    if (resolvedRef.current || phase === "biting") return;
    const data = FISH_DATABASE[fish.species];
    setBiteFish(fish);
    setPhase("biting");
    biteStartRef.current = performance.now();
    // 魚種別の大振動
    vibrateFishSpecific(data.vibrationPattern);
    playSEHit();
    // 親に通知して魚を固定
    onBiteStart?.(fish);
  }, [phase, onBiteStart]);

  // ── ガツン後のタップ窓 ──
  useEffect(() => {
    if (phase !== "biting" || paused) return;
    let raf = 0;
    const loop = () => {
      const elapsed = performance.now() - biteStartRef.current;
      const remaining = Math.max(0, 1 - elapsed / BITE_TAP_WINDOW_MS);
      setBiteWindowRemaining(remaining);
      if (remaining <= 0) {
        // 逃げられた
        if (!resolvedRef.current) {
          resolveOnce(() => {
            const fish = biteFish;
            vibrate([60, 30, 60]);
            playSEMiss();
            onBarashi(fish);
          });
        }
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, paused, biteFish, onBarashi, resolveOnce]);

  // ── イベントハンドラ ──
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (paused || resolvedRef.current) return;
    e.preventDefault();

    if (phase === "biting") {
      // 窓内タップ → フッキング成功
      const elapsed = performance.now() - biteStartRef.current;
      if (elapsed <= BITE_TAP_WINDOW_MS && biteFish) {
        const fish = biteFish;
        resolveOnce(() => {
          playSEReel();
          vibrate([40, 15, 80, 15, 120]);
          onHook(fish);
        });
      }
      return;
    }

    // idle / probing: 探索開始
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    probeRef.current = p;
    hoverRef.current = null;
    lastPulseRef.current = 0;
    setProbe(p);
    setPhase("probing");
  }, [paused, phase, biteFish, onHook, resolveOnce]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (phase !== "probing" || paused) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    probeRef.current = p;
    setProbe(p);
  }, [phase, paused]);

  const handlePointerUp = useCallback(() => {
    if (phase === "probing") {
      setPhase("idle");
      setProbe(null);
      probeRef.current = null;
      hoverRef.current = null;
      setNearestDist(Infinity);
    }
    // biting 中の release は無視（タップ＝pointerdownで判定）
  }, [phase]);

  // ── UI ──
  const proximity = Math.max(0, Math.min(1,
    phase === "probing" && nearestDist < DETECTION_RADIUS
      ? 1 - nearestDist / DETECTION_RADIUS
      : 0
  ));
  const biteData = biteFish ? FISH_DATABASE[biteFish.species] : null;
  const biteStage = biteFish && biteData ? biteData.stages[biteFish.stageIndex] : null;

  return (
    <div
      className="absolute inset-0 z-20 select-none"
      style={{ touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {/* 探索: 指先のソナー */}
      {phase === "probing" && probe && (
        <>
          {/* 近接オーラ（proximity が高いほど強く光る） */}
          <div
            className="absolute pointer-events-none rounded-full"
            style={{
              left: probe.x - 90,
              top: probe.y - 90,
              width: 180,
              height: 180,
              background: `radial-gradient(circle at center, rgba(250,204,21,${0.25 + proximity * 0.45}) 0%, rgba(251,191,36,${proximity * 0.25}) 40%, transparent 70%)`,
              transition: "background 80ms linear",
            }}
          />
          {/* 同心円ソナー */}
          <div
            className="absolute pointer-events-none rounded-full border-2"
            style={{
              left: probe.x - 22,
              top: probe.y - 22,
              width: 44,
              height: 44,
              borderColor: `rgba(253,224,71,${0.4 + proximity * 0.6})`,
              boxShadow: `0 0 ${10 + proximity * 30}px rgba(250,204,21,${0.3 + proximity * 0.5})`,
            }}
          />
          {/* 中心 */}
          <div
            className="absolute pointer-events-none rounded-full bg-white"
            style={{ left: probe.x - 4, top: probe.y - 4, width: 8, height: 8 }}
          />
        </>
      )}

      {/* 下部ガイド */}
      {phase === "idle" && (
        <div className="absolute bottom-4 left-0 right-0 pointer-events-none text-center">
          <div className="inline-block bg-black/50 text-white text-xs px-4 py-1.5 rounded-full backdrop-blur">
            💧 画面を長押しして海面を探る
          </div>
        </div>
      )}

      {/* 探索中の近接バー */}
      {phase === "probing" && (
        <div className="absolute top-3 left-3 right-3 pointer-events-none">
          <div className="bg-black/50 rounded-full px-3 py-1 backdrop-blur flex items-center gap-2">
            <span className="text-xs text-white/80">気配</span>
            <div className="flex-1 h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-100"
                style={{
                  width: `${proximity * 100}%`,
                  background: `linear-gradient(90deg, #facc15 0%, #fb923c ${Math.round(proximity * 100)}%)`,
                }}
              />
            </div>
            <span className="text-xs text-yellow-300 font-bold w-10 text-right">
              {proximity >= 0.85 ? "直下" : proximity >= 0.5 ? "近い" : proximity >= 0.2 ? "微か" : "—"}
            </span>
          </div>
        </div>
      )}

      {/* ガツン！表示 */}
      {phase === "biting" && biteFish && biteStage && biteData && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="absolute inset-0 bg-black/25" />
          <div
            className="absolute rounded-full"
            style={{
              left: biteFish.x - 80,
              top: biteFish.y - 80,
              width: 160,
              height: 160,
              background: "radial-gradient(circle at center, rgba(239,68,68,0.6) 0%, rgba(245,158,11,0.25) 50%, transparent 70%)",
              animation: "pulse 0.4s ease-out infinite",
            }}
          />
          <div className="relative text-center">
            <div
              className="text-5xl font-black text-transparent bg-clip-text drop-shadow-2xl mb-2"
              style={{
                backgroundImage: "linear-gradient(120deg, #fef08a 0%, #fb923c 45%, #dc2626 100%)",
                WebkitTextStroke: "2px rgba(0,0,0,0.6)",
                animation: "shakeBig 0.25s ease-in-out infinite",
              }}
            >
              ガツン！
            </div>
            <div className="text-lg font-bold text-white drop-shadow-lg">
              今だ！画面をタップ
            </div>
            <div className="text-xs text-white/80 mt-1">
              {biteStage.name}（{biteData.displayName}）
            </div>
            {/* タップ残り窓 */}
            <div className="mt-3 mx-auto w-48 h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${biteWindowRemaining * 100}%`,
                  background: biteWindowRemaining > 0.5 ? "#facc15" : biteWindowRemaining > 0.2 ? "#fb923c" : "#ef4444",
                  transition: "width 60ms linear",
                }}
              />
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes shakeBig {
          0%, 100% { transform: translate(0, 0) rotate(-2deg); }
          25% { transform: translate(-4px, 2px) rotate(1deg); }
          50% { transform: translate(3px, -3px) rotate(-1deg); }
          75% { transform: translate(-2px, 2px) rotate(2deg); }
        }
      `}</style>
    </div>
  );
}
