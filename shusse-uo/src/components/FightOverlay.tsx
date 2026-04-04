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

  // テンション: 0で逃げる、100で糸切れ、30~70が安全圏
  const [tension, setTension] = useState(50);
  // リール進捗: 100で釣り上げ成功
  const [progress, setProgress] = useState(0);
  // 魚の抵抗方向
  const [fishPull, setFishPull] = useState(0);
  // ライン角度（視覚用）
  const [lineAngle, setLineAngle] = useState(0);
  // 終了フラグ
  const doneRef = useRef(false);

  // 魚の抵抗AI（自動で引っ張る）
  useEffect(() => {
    const interval = setInterval(() => {
      if (doneRef.current) return;

      // 魚がランダムに引っ張る強さ（大幅に緩和）
      const pullStrength = 0.8 + difficulty * 1.2;
      const newPull = (Math.random() - 0.5) * pullStrength;
      setFishPull(newPull);

      // テンション自然変化（中央50に戻ろうとする復元力あり）
      setTension((prev) => {
        const restore = (50 - prev) * 0.02; // 中央に引き戻す力
        let next = prev + newPull + restore;
        next = Math.max(0, Math.min(100, next));

        // 糸切れ or 逃亡
        if (next >= 100) {
          doneRef.current = true;
          vibrate([200, 50, 200]);
          playSESnap();
          setTimeout(onFail, 300);
        }
        if (next <= 0) {
          doneRef.current = true;
          vibrate([100, 50, 100]);
          playSESnap();
          setTimeout(onFail, 300);
        }
        return next;
      });

      // ライン揺れ
      setLineAngle(Math.sin(Date.now() / 200) * (5 + difficulty * 10));

      // 巻かないと進捗は少しずつ戻る（緩やかに）
      setProgress((prev) => Math.max(0, prev - 0.15 - difficulty * 0.2));
    }, 80);

    return () => clearInterval(interval);
  }, [difficulty, onFail]);

  // リールタップ（連打で巻き上げ）
  const handleReel = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.stopPropagation();
      if (doneRef.current) return;

      // テンションを少し上げつつ進捗を進める
      setTension((prev) => Math.min(100, prev + 1 + difficulty * 0.8));
      setProgress((prev) => {
        const gain = 4 - difficulty * 2; // 難しい魚でも最低2は進む
        const next = prev + Math.max(2, gain);
        if (next >= 100) {
          doneRef.current = true;
          vibrate(HAPTIC_PATTERNS.perfect);
          setTimeout(onSuccess, 200);
          return 100;
        }
        return next;
      });

      // リール振動 + SE
      vibrate([20, 10, 20]);
      playSEReel();
    },
    [difficulty, onSuccess]
  );

  // テンションの色
  const tensionColor =
    tension > 80
      ? "bg-red-500"
      : tension > 60
      ? "bg-yellow-500"
      : tension < 20
      ? "bg-blue-400"
      : "bg-green-500";

  const tensionLabel =
    tension > 80
      ? "危険！"
      : tension < 20
      ? "緩すぎ！"
      : "";

  return (
    <div
      className="absolute inset-0 z-30"
      onClick={handleReel}
      onTouchStart={handleReel}
    >
      {/* 背景オーバーレイ */}
      <div className="absolute inset-0 bg-black/20 pointer-events-none" />

      {/* ライン描画 */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        {/* 竿先（画面上部中央）からの糸 */}
        <line
          x1="50%"
          y1="0"
          x2={fishX}
          y2={fishY}
          stroke="white"
          strokeWidth={tension > 70 ? 2 : 1}
          opacity={0.7}
          strokeDasharray={tension > 80 ? "4,4" : "none"}
          transform={`rotate(${lineAngle}, ${fishX}, ${fishY})`}
        />
      </svg>

      {/* 魚の抵抗表示 */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: fishX - 30,
          top: fishY - 30,
          transform: `translate(${fishPull * 8}px, ${Math.sin(Date.now() / 150) * 5}px)`,
        }}
      >
        <div className="text-3xl animate-pulse">
          🐟
        </div>
      </div>

      {/* UI パネル（画面下部） */}
      <div className="absolute bottom-4 left-4 right-4 pointer-events-none">
        {/* 魚名 */}
        <div className="text-center mb-2">
          <span className="bg-black/60 text-white px-3 py-1 rounded-full text-sm font-bold">
            {stage.name}（{fishData.displayName}）と格闘中！
          </span>
        </div>

        {/* テンションゲージ */}
        <div className="bg-black/50 rounded-xl p-3 backdrop-blur-sm">
          <div className="flex justify-between text-xs text-white mb-1">
            <span>🎣 テンション</span>
            <span className={tension > 80 || tension < 20 ? "text-red-400 font-bold animate-pulse" : ""}>
              {tensionLabel || `${Math.round(tension)}%`}
            </span>
          </div>
          <div className="w-full h-3 bg-gray-700 rounded-full overflow-hidden mb-3 relative">
            {/* 安全圏マーカー */}
            <div
              className="absolute top-0 bottom-0 bg-green-900/40 rounded-full"
              style={{ left: "20%", width: "50%" }}
            />
            <div
              className={`h-full rounded-full transition-all duration-75 ${tensionColor}`}
              style={{ width: `${tension}%` }}
            />
          </div>

          {/* リール進捗 */}
          <div className="flex justify-between text-xs text-white mb-1">
            <span>巻き上げ</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="w-full h-3 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-400 rounded-full transition-all duration-75"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* 操作ヒント */}
          <div className="text-center mt-2 pointer-events-auto">
            <span className="text-white/80 text-xs">
              画面を連打してリールを巻け！（巻きすぎ注意）
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
