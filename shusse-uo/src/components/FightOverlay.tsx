"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { FishSpecies, FISH_DATABASE } from "@/lib/fish-data";
import { vibrate, HAPTIC_PATTERNS } from "@/lib/haptics";
import { playSEReel, playSESnap } from "@/lib/audio";

interface FightOverlayProps {
  species: FishSpecies;
  stageIndex: number;
  fishX: number;
  fishY: number;
  onSuccess: () => void;
  onFail: () => void;
}

// タイミングリング: 回転する針を「当たりゾーン」で止める
export default function FightOverlay({
  species,
  stageIndex,
  fishX,
  fishY,
  onSuccess,
  onFail,
}: FightOverlayProps) {
  const fishData = FISH_DATABASE[species];
  const stage = fishData.stages[stageIndex];
  const difficulty = stage.catchDifficulty;

  // 必要な成功回数（2〜4回）
  const requiredHits = 2 + Math.floor(difficulty * 2);
  const [hits, setHits] = useState(0);
  const [misses, setMisses] = useState(0);
  const maxMisses = 3;

  // 針の角度（0〜360度、自動回転）
  const [needleAngle, setNeedleAngle] = useState(0);
  // 当たりゾーンの開始角度
  const [sweetSpotAngle, setSweetSpotAngle] = useState(() => Math.random() * 360);
  // 当たりゾーンの幅（難度で変わる）
  const sweetSpotSize = 70 - difficulty * 35; // 70度〜35度
  // 回転速度（難度で変わる）
  const speed = 1.2 + difficulty * 1.5; // deg/frame

  // 判定中フラグ
  const [judging, setJudging] = useState(false);
  const [lastResult, setLastResult] = useState<"hit" | "miss" | null>(null);
  const doneRef = useRef(false);
  // 回転方向（成功ごとに反転して変化をつける）
  const directionRef = useRef(1);

  // 針の自動回転
  useEffect(() => {
    if (doneRef.current || judging) return;
    const interval = setInterval(() => {
      setNeedleAngle((prev) => (prev + speed * directionRef.current + 360) % 360);
    }, 16);
    return () => clearInterval(interval);
  }, [speed, judging]);

  // タップ判定
  const handleTap = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.stopPropagation();
      if (doneRef.current || judging) return;

      setJudging(true);

      // 当たり判定: 針が当たりゾーン内にあるか
      let diff = ((needleAngle - sweetSpotAngle) % 360 + 360) % 360;
      if (diff > 180) diff = 360 - diff;
      const inZone = diff <= sweetSpotSize / 2;

      if (inZone) {
        // 成功！
        playSEReel();
        vibrate([30, 15, 50]);
        setLastResult("hit");
        const newHits = hits + 1;
        setHits(newHits);

        if (newHits >= requiredHits) {
          // 釣り上げ成功！
          doneRef.current = true;
          vibrate(HAPTIC_PATTERNS.perfect);
          setTimeout(onSuccess, 600);
        } else {
          // 次のラウンド: 当たりゾーンをランダム移動 & 方向反転
          setTimeout(() => {
            setSweetSpotAngle(Math.random() * 360);
            directionRef.current *= -1;
            setJudging(false);
            setLastResult(null);
          }, 700);
        }
      } else {
        // 失敗
        playSESnap();
        vibrate([80, 30, 80]);
        setLastResult("miss");
        const newMisses = misses + 1;
        setMisses(newMisses);

        if (newMisses >= maxMisses) {
          // 逃げられた
          doneRef.current = true;
          setTimeout(onFail, 600);
        } else {
          // 当たりゾーン移動してリトライ
          setTimeout(() => {
            setSweetSpotAngle(Math.random() * 360);
            setJudging(false);
            setLastResult(null);
          }, 700);
        }
      }
    },
    [needleAngle, sweetSpotAngle, sweetSpotSize, hits, misses, requiredHits, judging, onSuccess, onFail]
  );

  const ringRadius = 70;
  const cx = 90;
  const cy = 90;

  // 当たりゾーンの弧パス
  const sweetStart = ((sweetSpotAngle - sweetSpotSize / 2) * Math.PI) / 180;
  const sweetEnd = ((sweetSpotAngle + sweetSpotSize / 2) * Math.PI) / 180;
  const arcX1 = cx + Math.cos(sweetStart) * ringRadius;
  const arcY1 = cy + Math.sin(sweetStart) * ringRadius;
  const arcX2 = cx + Math.cos(sweetEnd) * ringRadius;
  const arcY2 = cy + Math.sin(sweetEnd) * ringRadius;
  const largeArc = sweetSpotSize > 180 ? 1 : 0;
  const sweetArc = `M ${arcX1} ${arcY1} A ${ringRadius} ${ringRadius} 0 ${largeArc} 1 ${arcX2} ${arcY2}`;

  // 針の先端位置
  const needleRad = (needleAngle * Math.PI) / 180;
  const needleX = cx + Math.cos(needleRad) * ringRadius;
  const needleY = cy + Math.sin(needleRad) * ringRadius;

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center"
      onClick={handleTap}
      onTouchStart={handleTap}
    >
      {/* 背景オーバーレイ */}
      <div className="absolute inset-0 bg-black/30 pointer-events-none" />

      {/* ライン */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        <line
          x1="50%"
          y1="0"
          x2={fishX}
          y2={fishY}
          stroke="white"
          strokeWidth={1}
          opacity={0.5}
        />
      </svg>

      {/* 魚の表示 */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: fishX - 20,
          top: fishY - 20,
          transform: `translateX(${Math.sin(Date.now() / 400) * 8}px)`,
        }}
      >
        <div className="text-3xl">🐟</div>
      </div>

      {/* タイミングリング */}
      <div className="relative pointer-events-none" style={{ width: 180, height: 180 }}>
        <svg width={180} height={180} viewBox="0 0 180 180">
          {/* 外枠リング */}
          <circle
            cx={cx}
            cy={cy}
            r={ringRadius}
            fill="none"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth={14}
          />

          {/* 当たりゾーン */}
          <path
            d={sweetArc}
            fill="none"
            stroke={
              lastResult === "hit"
                ? "#4ade80"
                : lastResult === "miss"
                ? "#f87171"
                : "#facc15"
            }
            strokeWidth={14}
            strokeLinecap="round"
          />

          {/* 回転する針 */}
          <circle
            cx={needleX}
            cy={needleY}
            r={8}
            fill={judging ? (lastResult === "hit" ? "#22c55e" : "#ef4444") : "white"}
            stroke="rgba(0,0,0,0.3)"
            strokeWidth={1.5}
          />
          <line
            x1={cx}
            y1={cy}
            x2={needleX}
            y2={needleY}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={1}
          />

          {/* 中央テキスト */}
          <text x={cx} y={cy - 8} textAnchor="middle" fill="white" fontSize={12} fontWeight="bold">
            {stage.name}
          </text>
          <text x={cx} y={cy + 8} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={10}>
            {fishData.displayName}
          </text>
        </svg>

        {/* 判定結果フラッシュ */}
        {lastResult && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span
              className={`text-3xl font-bold drop-shadow-lg ${
                lastResult === "hit" ? "text-green-400" : "text-red-400"
              }`}
              style={{ animation: "float 0.5s ease-out" }}
            >
              {lastResult === "hit" ? "GOOD!" : "MISS"}
            </span>
          </div>
        )}
      </div>

      {/* 下部UI */}
      <div className="absolute bottom-4 left-4 right-4 pointer-events-none">
        <div className="bg-black/50 rounded-xl p-3 backdrop-blur-sm">
          {/* 成功回数 */}
          <div className="flex justify-center gap-2 mb-2">
            {Array.from({ length: requiredHits }).map((_, i) => (
              <div
                key={i}
                className={`w-5 h-5 rounded-full border-2 transition-all ${
                  i < hits
                    ? "bg-green-400 border-green-400 scale-110"
                    : "bg-transparent border-white/40"
                }`}
              />
            ))}
          </div>

          {/* ミス回数 */}
          <div className="flex justify-center gap-1 mb-2">
            {Array.from({ length: maxMisses }).map((_, i) => (
              <span
                key={i}
                className={`text-sm ${i < misses ? "opacity-100" : "opacity-30"}`}
              >
                ✕
              </span>
            ))}
          </div>

          <p className="text-center text-white/70 text-xs">
            黄色のゾーンに針が来たらタップ！
          </p>
        </div>
      </div>
    </div>
  );
}
