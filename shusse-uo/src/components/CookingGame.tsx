"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CaughtFish, calculateFreshness } from "@/lib/game-state";
import { FISH_DATABASE, FishSpecies } from "@/lib/fish-data";
import { vibrate } from "@/lib/haptics";
import { playSESlice, playSESell } from "@/lib/audio";

interface CookingGameProps {
  inventory: CaughtFish[];
  marketTrend: Partial<Record<FishSpecies, number>>;
  onSell: (fishId: string, price: number) => void;
}

type PrepState = "idle" | "cutting" | "done";

interface SliceLine {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  time: number;
}

interface PrepProgress {
  fishId: string;
  slices: number;
  required: number;
  state: PrepState;
}

export default function CookingGame({ inventory, marketTrend, onSell }: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [sellMode, setSellMode] = useState<string | null>(null);
  const [activeCut, setActiveCut] = useState<string | null>(null); // 捌き中の魚ID
  const [sliceLines, setSliceLines] = useState<SliceLine[]>([]);
  const [knifePos, setKnifePos] = useState<{ x: number; y: number } | null>(null);
  const sliceIdRef = useRef(0);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const cuttingAreaRef = useRef<HTMLDivElement>(null);

  // 鮮度更新
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const updated: Record<string, number> = {};
      for (const fish of inventory) {
        updated[fish.id] = calculateFreshness(fish.caughtAt, now);
      }
      setFreshness(updated);
    }, 500);
    return () => clearInterval(interval);
  }, [inventory]);

  // 古い切り線を削除
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSliceLines((prev) => prev.filter((s) => now - s.time < 800));
    }, 200);
    return () => clearInterval(interval);
  }, []);

  const getEventPos = (e: React.MouseEvent | React.TouchEvent) => {
    if ("touches" in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if ("clientX" in e) {
      return { x: e.clientX, y: e.clientY };
    }
    return null;
  };

  const getRelativePos = (clientX: number, clientY: number) => {
    const rect = cuttingAreaRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // スワイプ開始
  const handleCutStart = useCallback(
    (fishId: string, e: React.MouseEvent | React.TouchEvent) => {
      const pos = getEventPos(e);
      if (!pos) return;
      dragStartRef.current = pos;
      setActiveCut(fishId);
      setKnifePos(getRelativePos(pos.x, pos.y));
    },
    []
  );

  // スワイプ中
  const handleCutMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const pos = getEventPos(e);
      if (!pos || !dragStartRef.current || !activeCut) return;
      setKnifePos(getRelativePos(pos.x, pos.y));
    },
    [activeCut]
  );

  // スワイプ終了 → 切り判定
  const handleCutEnd = useCallback(
    (fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
      if (!dragStartRef.current || !activeCut) return;

      const endPos = getEventPos(e) ||
        (knifePos ? { x: knifePos.x, y: knifePos.y } : null);
      if (!endPos) { dragStartRef.current = null; setActiveCut(null); return; }

      const dx = endPos.x - dragStartRef.current.x;
      const dy = endPos.y - dragStartRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const fishData = FISH_DATABASE[fish.species];
      const stage = fishData.stages[fish.stageIndex];
      // シンコなど難度高い魚は長いスワイプが必要
      const minDist = 30 + stage.prepDifficulty * 40;

      if (dist >= minDist) {
        // 有効な切り！
        vibrate([15, 5, 15]);
        playSESlice();
        const startRel = getRelativePos(dragStartRef.current.x, dragStartRef.current.y);
        const endRel = getRelativePos(endPos.x, endPos.y);
        setSliceLines((prev) => [
          ...prev,
          {
            id: sliceIdRef.current++,
            x1: startRel.x,
            y1: startRel.y,
            x2: endRel.x,
            y2: endRel.y,
            time: Date.now(),
          },
        ]);

        const required = Math.ceil(stage.prepDifficulty * 6) + 2; // 2~8スワイプ
        setPrepProgress((prev) => {
          const current = prev[fish.id] || {
            fishId: fish.id,
            slices: 0,
            required,
            state: "cutting" as PrepState,
          };
          const newSlices = current.slices + 1;
          if (newSlices >= required) {
            vibrate([30, 10, 30, 10, 60]);
            return {
              ...prev,
              [fish.id]: { ...current, slices: newSlices, state: "done" },
            };
          }
          return {
            ...prev,
            [fish.id]: { ...current, slices: newSlices, state: "cutting" },
          };
        });
      }

      dragStartRef.current = null;
      setActiveCut(null);
      setKnifePos(null);
    },
    [activeCut, knifePos]
  );

  // 販売
  const handleSell = (fish: CaughtFish, premium: boolean) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;

    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const premiumMult = premium ? 1.8 : 1;
    const price = Math.round(fish.sushiPrice * trendMult * freshMult * premiumMult);

    onSell(fish.id, price);
    setSellMode(null);
    playSESell();
  };

  if (inventory.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gradient-to-b from-amber-50 to-orange-100 text-gray-600">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">🍣</div>
          <p className="text-lg font-bold mb-1">在庫なし</p>
          <p className="text-sm">兄が魚を釣るのを待ちましょう！</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-gradient-to-b from-amber-50 to-orange-100 overflow-y-auto p-3">
      <div className="space-y-3">
        {inventory.map((fish) => {
          const fishData = FISH_DATABASE[fish.species];
          const stage = fishData.stages[fish.stageIndex];
          const fishFreshness = freshness[fish.id] ?? 100;
          const prep = prepProgress[fish.id];
          const isDone = prep?.state === "done";
          const isRotten = fishFreshness <= 0;
          const isRare = fishData.reverseValue && fish.stageIndex === 0;
          const required = Math.ceil(stage.prepDifficulty * 6) + 2;

          return (
            <div
              key={fish.id}
              className={`bg-white rounded-xl shadow-md p-4 ${
                isRotten ? "opacity-50" : ""
              } ${isRare ? "ring-2 ring-yellow-400" : ""}`}
            >
              {/* 魚情報ヘッダー */}
              <div className="flex justify-between items-center mb-2">
                <div>
                  <span className="font-bold text-lg">{fish.stageName}</span>
                  <span className="text-gray-500 text-sm ml-1">
                    ({fishData.displayName})
                  </span>
                  {isRare && (
                    <span className="ml-1 text-xs bg-yellow-400 text-yellow-900 px-1.5 py-0.5 rounded-full font-bold">
                      超レア
                    </span>
                  )}
                </div>
                <span className="text-green-600 font-bold">
                  ¥{fish.sushiPrice.toLocaleString()}
                </span>
              </div>

              {/* 鮮度ゲージ */}
              <div className="mb-3">
                <div className="flex justify-between text-xs mb-0.5">
                  <span>鮮度</span>
                  <span
                    className={`font-bold ${
                      fishFreshness > 50
                        ? "text-green-600"
                        : fishFreshness > 20
                        ? "text-yellow-600"
                        : "text-red-600"
                    }`}
                  >
                    {isRotten ? "まかない行き" : `${fishFreshness}%`}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 rounded-full ${
                      fishFreshness > 50
                        ? "bg-green-500"
                        : fishFreshness > 20
                        ? "bg-yellow-500"
                        : "bg-red-500"
                    }`}
                    style={{ width: `${fishFreshness}%` }}
                  />
                </div>
              </div>

              {/* 捌きエリア or 販売 */}
              {isRotten ? (
                <div className="text-center text-gray-400 text-sm py-2">
                  鮮度が落ちてしまいました...
                </div>
              ) : !isDone ? (
                /* ---- 包丁スワイプエリア ---- */
                <div
                  ref={cuttingAreaRef}
                  className="relative bg-gradient-to-b from-gray-50 to-gray-100 rounded-lg overflow-hidden select-none touch-none"
                  style={{ height: 120 }}
                  onMouseDown={(e) => handleCutStart(fish.id, e)}
                  onMouseMove={handleCutMove}
                  onMouseUp={(e) => handleCutEnd(fish, e)}
                  onMouseLeave={(e) => { if (activeCut) handleCutEnd(fish, e); }}
                  onTouchStart={(e) => handleCutStart(fish.id, e)}
                  onTouchMove={handleCutMove}
                  onTouchEnd={(e) => handleCutEnd(fish, e)}
                >
                  {/* まな板テクスチャ */}
                  <div className="absolute inset-0 bg-amber-100 opacity-50"
                    style={{
                      backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 40px, rgba(180,140,80,0.15) 40px, rgba(180,140,80,0.15) 41px)",
                    }}
                  />

                  {/* 魚イラスト（中央） */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-5xl opacity-60" style={{
                      transform: `scale(${0.6 + stage.silhouetteScale * 0.5})`,
                    }}>
                      🐟
                    </div>
                  </div>

                  {/* 切り線アニメーション */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    {sliceLines.map((line) => {
                      const age = (Date.now() - line.time) / 800;
                      const opacity = Math.max(0, 1 - age);
                      return (
                        <line
                          key={line.id}
                          x1={line.x1}
                          y1={line.y1}
                          x2={line.x2}
                          y2={line.y2}
                          stroke="rgba(220, 50, 50, 0.8)"
                          strokeWidth={2.5}
                          strokeLinecap="round"
                          opacity={opacity}
                        />
                      );
                    })}
                  </svg>

                  {/* 包丁カーソル */}
                  {knifePos && activeCut === fish.id && (
                    <div
                      className="absolute pointer-events-none text-2xl"
                      style={{
                        left: knifePos.x - 14,
                        top: knifePos.y - 20,
                        transform: "rotate(-30deg)",
                      }}
                    >
                      🔪
                    </div>
                  )}

                  {/* 進捗 */}
                  <div className="absolute bottom-1 left-0 right-0 text-center">
                    <span className="text-xs bg-black/40 text-white px-2 py-0.5 rounded-full">
                      {prep ? `${prep.slices}/${prep.required}` : `0/${required}`} スワイプで捌く
                    </span>
                  </div>

                  {/* 難度表示 */}
                  {isRare && (
                    <div className="absolute top-1 right-1">
                      <span className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded font-bold">
                        極細
                      </span>
                    </div>
                  )}
                </div>
              ) : sellMode === fish.id ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSell(fish, false)}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-3 rounded-lg text-sm font-bold active:scale-95 transition-all"
                  >
                    即売り
                    <span className="block text-xs opacity-80">安定価格</span>
                  </button>
                  <button
                    onClick={() => handleSell(fish, true)}
                    className="flex-1 bg-purple-500 hover:bg-purple-600 text-white py-3 rounded-lg text-sm font-bold active:scale-95 transition-all"
                  >
                    限定メニュー
                    <span className="block text-xs opacity-80">x1.8 高リスク</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSellMode(fish.id)}
                  className="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-lg font-bold transition-all active:scale-95"
                >
                  🍣 握って売る！
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
