"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Fish, Anchor, Timer, Waves, Trophy, ChevronRight } from "lucide-react";
import {
  FishSpecies,
  FISH_DATABASE,
  rollFishSpecies,
  rollFishStage,
  getSeasonMultiplier,
} from "@/lib/fish-data";
import { vibrateFishSpecific, vibrateMiss, vibrate, HAPTIC_PATTERNS } from "@/lib/haptics";
import { playBGM, stopBGM, playSEHit, playSECatch, playSEMiss } from "@/lib/audio";
import {
  GameState,
  CaughtFish,
  createInitialState,
  calculateShopRank,
  SHOP_RANK_NAMES,
} from "@/lib/game-state";
import WaterSurface from "./WaterSurface";
import ParallaxLayers from "./ParallaxLayers";
import FishSilhouette from "./FishSilhouette";
import FightOverlay from "./FightOverlay";
import CookingGame from "./CookingGame";
import MarketView from "./MarketView";

interface SwimmingFish {
  id: string;
  species: FishSpecies;
  stageIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  depth: number;   // 0(奥) ~ 1(手前)
  vDepth: number;   // 奥行き方向の速度
  spawnTime: number;
}

// ルアー位置
interface Lure {
  x: number;
  y: number;
  active: boolean;
}

export default function FishingGame() {
  const [gameState, setGameState] = useState<GameState>(createInitialState);
  const [fishes, setFishes] = useState<SwimmingFish[]>([]);
  const [lure, setLure] = useState<Lure>({ x: 200, y: 250, active: false });
  const [ripples, setRipples] = useState<{ x: number; y: number; time: number }[]>([]);
  const [message, setMessage] = useState<string>("");
  const [catchAnimation, setCatchAnimation] = useState<{
    fish: SwimmingFish;
    success: boolean;
  } | null>(null);
  const [fightTarget, setFightTarget] = useState<SwimmingFish | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fishIdCounter = useRef(0);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // 画面サイズ取得
  useEffect(() => {
    function updateSize() {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    }
    updateSize();
    // 初回は少し遅延してレイアウト確定後に再取得
    const timer = setTimeout(updateSize, 100);
    window.addEventListener("resize", updateSize);
    return () => {
      window.removeEventListener("resize", updateSize);
      clearTimeout(timer);
    };
  }, [gameState.phase]);

  // 魚のスポーン
  useEffect(() => {
    if (gameState.phase !== "fishing") return;
    const interval = setInterval(() => {
      if (fishes.length >= 6) return;
      const species = rollFishSpecies();
      const stageIndex = rollFishStage(species);
      const fromLeft = Math.random() > 0.5;
      const initialDepth = 0.1 + Math.random() * 0.5; // 最初は奥寄り
      const newFish: SwimmingFish = {
        id: `fish-${++fishIdCounter.current}`,
        species,
        stageIndex,
        x: fromLeft ? -40 : dimensions.width + 40,
        y: 80 + Math.random() * (dimensions.height - 160),
        vx: (fromLeft ? 1 : -1) * (0.3 + Math.random() * 1.0),
        vy: (Math.random() - 0.5) * 0.4,
        depth: initialDepth,
        vDepth: (Math.random() - 0.3) * 0.008, // やや手前に来る傾向
        spawnTime: Date.now(),
      };
      setFishes((prev) => [...prev, newFish]);
    }, 1200 + Math.random() * 1800);

    return () => clearInterval(interval);
  }, [gameState.phase, fishes.length, dimensions]);

  // 魚の移動アニメーション
  useEffect(() => {
    if (gameState.phase !== "fishing") return;
    const frame = setInterval(() => {
      setFishes((prev) =>
        prev
          .map((f) => {
            let { x, y, vx, vy, depth, vDepth } = f;
            // 奥行きに応じた速度スケール（奥=遅い、手前=速い）
            const speedScale = 0.4 + depth * 0.8;
            x += vx * speedScale;
            y += vy * speedScale;
            // 奥行き更新
            depth += vDepth;
            // 奥行き範囲制限 & 反転
            if (depth < 0.05) { depth = 0.05; vDepth = Math.abs(vDepth); }
            if (depth > 1.0) { depth = 1.0; vDepth = -Math.abs(vDepth); }
            // ランダムな奥行き方向転換
            if (Math.random() < 0.01) vDepth = (Math.random() - 0.4) * 0.01;
            // 上下バウンド
            if (y < 60 || y > dimensions.height - 60) vy = -vy;
            // ランダムな方向転換
            if (Math.random() < 0.02) vy = (Math.random() - 0.5) * 0.6;
            return { ...f, x, y, vx, vy, depth, vDepth };
          })
          .filter((f) => f.x > -80 && f.x < dimensions.width + 80)
      );
    }, 32);
    return () => clearInterval(frame);
  }, [gameState.phase, dimensions]);

  // タイマー
  useEffect(() => {
    if (gameState.phase !== "fishing" && gameState.phase !== "cooking") return;
    const timer = setInterval(() => {
      setGameState((prev) => {
        const newTime = prev.timeRemaining - 1;
        if (newTime <= 0) {
          stopBGM();
          return { ...prev, timeRemaining: 0, phase: "result" };
        }
        return { ...prev, timeRemaining: newTime };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [gameState.phase]);

  // 水面クリック: ルアー投入
  const handleWaterClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      if (gameState.phase !== "fishing" || fightTarget) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      let clientX: number, clientY: number;
      if ("touches" in e) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      // ルアー設置
      setLure({ x, y, active: true });
      setRipples((prev) => [...prev.slice(-4), { x, y, time: Date.now() }]);

      // 魚との当たり判定（depth 0.5以上の手前の魚のみ釣れる）
      const hitRadius = 50;
      const hitFish = fishes
        .filter((f) => f.depth >= 0.5)
        .sort((a, b) => b.depth - a.depth)
        .find((f) => {
          const dx = f.x - x;
          const dy = f.y - y;
          return Math.sqrt(dx * dx + dy * dy) < hitRadius * f.depth;
        });

      if (hitFish) {
        const fishData = FISH_DATABASE[hitFish.species];
        const stage = fishData.stages[hitFish.stageIndex];

        const dist = Math.sqrt((hitFish.x - x) ** 2 + (hitFish.y - y) ** 2);
        const accuracy = 1 - dist / hitRadius;

        if (accuracy > stage.catchDifficulty * 0.5) {
          // ヒット！ → ファイトフェーズへ
          vibrateFishSpecific(fishData.vibrationPattern);
          playSEHit();
          setCatchAnimation({ fish: hitFish, success: true });
          setFightTarget(hitFish);
          setMessage(`${stage.name}（${fishData.displayName}）がヒット！巻き上げろ！`);

          // 他の魚は泳ぎ続ける（ファイト中の魚だけ固定）
          setFishes((prev) =>
            prev.map((f) =>
              f.id === hitFish.id ? { ...f, vx: 0, vy: 0, vDepth: 0 } : f
            )
          );

          setTimeout(() => setCatchAnimation(null), 800);
        } else {
          vibrateMiss();
          playSEMiss();
          setMessage("バラシ！タイミングが合わなかった...");
          setTimeout(() => setMessage(""), 1500);
        }
      }
    },
    [gameState.phase, fishes, fightTarget]
  );

  // ファイト成功: 魚をキャッチ
  const handleFightSuccess = useCallback(() => {
    if (!fightTarget) return;
    const fishData = FISH_DATABASE[fightTarget.species];
    const stage = fishData.stages[fightTarget.stageIndex];
    const seasonMult = getSeasonMultiplier(fishData);
    const price = Math.round(stage.basePrice * seasonMult);

    const caught: CaughtFish = {
      id: fightTarget.id,
      species: fightTarget.species,
      stageIndex: fightTarget.stageIndex,
      stageName: stage.name,
      basePrice: price,
      sushiPrice: Math.round(stage.sushiPrice * seasonMult),
      freshness: 100,
      caughtAt: Date.now(),
      processed: false,
      sold: false,
    };

    const isRare = fishData.reverseValue && fightTarget.stageIndex === 0;
    const rareMsg = isRare ? " 🎉 超レア！" : "";

    setMessage(`${stage.name}（${fishData.displayName}）を釣り上げた！ 卸値: ¥${price}${rareMsg}`);
    vibrate(HAPTIC_PATTERNS.perfect);
    playSECatch();

    setGameState((prev) => ({
      ...prev,
      brotherMoney: prev.brotherMoney + price,
      catches: [...prev.catches, caught],
      inventory: [...prev.inventory, caught],
      totalAssets: prev.totalAssets + price,
    }));

    setFishes((prev) => prev.filter((f) => f.id !== fightTarget.id));
    setFightTarget(null);
    setTimeout(() => setMessage(""), 2500);
  }, [fightTarget]);

  // ファイト失敗: 魚が逃げる
  const handleFightFail = useCallback(() => {
    if (!fightTarget) return;
    setMessage("逃げられた...糸のテンションに注意！");
    vibrateMiss();
    playSEMiss();
    setFishes((prev) => prev.filter((f) => f.id !== fightTarget.id));
    setFightTarget(null);
    setTimeout(() => setMessage(""), 2000);
  }, [fightTarget]);

  // フェーズ切替
  const switchToCooking = () => {
    setGameState((prev) => ({ ...prev, phase: "cooking" }));
  };

  const switchToFishing = () => {
    setGameState((prev) => ({ ...prev, phase: "fishing" }));
  };

  const startGame = () => {
    setGameState((prev) => ({ ...prev, phase: "fishing" }));
    playBGM();
  };

  const handleSell = (fishId: string, price: number) => {
    setGameState((prev) => {
      const inventory = prev.inventory.map((f) =>
        f.id === fishId ? { ...f, sold: true, soldPrice: price, processed: true } : f
      );
      return {
        ...prev,
        youngerMoney: prev.youngerMoney + price,
        totalAssets: prev.totalAssets + price,
        inventory,
        shopRank: calculateShopRank(prev.totalAssets + price),
      };
    });
    vibrate(HAPTIC_PATTERNS.sell);
  };

  const nextDay = () => {
    setGameState((prev) => ({
      ...createInitialState(),
      day: prev.day + 1,
      brotherMoney: prev.brotherMoney,
      youngerMoney: prev.youngerMoney,
      totalAssets: prev.totalAssets,
      shopRank: prev.shopRank,
      phase: "fishing",
    }));
    setFishes([]);
    setRipples([]);
  };

  // --- タイトル画面 ---
  if (gameState.phase === "title") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-sky-400 to-blue-900 text-white px-4">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-2 tracking-wide">
            🐟 出世魚兄弟
          </h1>
          <p className="text-lg text-blue-200 mb-1">Shusse-Uo Brothers</p>
          <p className="text-sm text-blue-300 mb-8">
            漁師の兄 × 寿司職人の弟
          </p>

          <div className="bg-white/10 backdrop-blur rounded-xl p-5 mb-6 text-left text-sm max-w-sm mx-auto">
            <p className="mb-2">
              <Fish className="inline w-4 h-4 mr-1" />
              <strong>兄（漁師）:</strong> 魚影をタップして釣り上げろ！
            </p>
            <p className="mb-2">
              <Anchor className="inline w-4 h-4 mr-1" />
              <strong>弟（職人）:</strong> 鮮度が落ちる前に捌いて売れ！
            </p>
            <p>
              <Trophy className="inline w-4 h-4 mr-1" />
              <strong>目標:</strong> 屋台→回転寿司→銀座の名店へ！
            </p>
          </div>

          <div className="bg-white/10 backdrop-blur rounded-lg p-3 mb-8 text-xs max-w-sm mx-auto">
            <p className="font-semibold mb-1">🔥 コノシロの逆転ロジック</p>
            <p className="text-blue-200">
              シンコ（稚魚）は超高単価！小さいほどレアで価値が高い！
            </p>
          </div>

          <button
            onClick={startGame}
            className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 px-10 rounded-full text-lg shadow-lg transition-all hover:scale-105 active:scale-95"
          >
            出航する
            <ChevronRight className="inline w-5 h-5 ml-1" />
          </button>
        </div>
      </div>
    );
  }

  // --- リザルト画面 ---
  if (gameState.phase === "result") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-amber-100 to-orange-200 text-gray-800 px-4">
        <h2 className="text-3xl font-bold mb-4">📊 {gameState.day}日目の結果</h2>

        <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-sm mb-6">
          <div className="flex justify-between mb-3 pb-3 border-b">
            <span>🎣 兄（漁師）の売上</span>
            <span className="font-bold text-blue-600">
              ¥{gameState.brotherMoney.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between mb-3 pb-3 border-b">
            <span>🍣 弟（職人）の利益</span>
            <span className="font-bold text-red-600">
              ¥{gameState.youngerMoney.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between mb-3 pb-3 border-b">
            <span>💰 合計資産</span>
            <span className="font-bold text-green-600">
              ¥{gameState.totalAssets.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span>🏪 店舗ランク</span>
            <span className="font-bold text-amber-600">
              {SHOP_RANK_NAMES[gameState.shopRank]}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-4 w-full max-w-sm mb-6">
          <h3 className="font-bold mb-2">釣果一覧</h3>
          {gameState.catches.length === 0 ? (
            <p className="text-gray-400 text-sm">釣果なし</p>
          ) : (
            <div className="space-y-1 text-sm max-h-40 overflow-y-auto">
              {gameState.catches.map((c) => {
                const fishData = FISH_DATABASE[c.species];
                return (
                  <div key={c.id} className="flex justify-between">
                    <span>
                      {c.stageName}（{fishData.displayName}）
                    </span>
                    <span>¥{c.basePrice.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={nextDay}
          className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-8 rounded-full shadow-lg transition-all hover:scale-105 active:scale-95"
        >
          {gameState.day + 1}日目へ
          <ChevronRight className="inline w-5 h-5 ml-1" />
        </button>
      </div>
    );
  }

  // --- メインゲーム画面（釣り / 調理 / 市場） ---
  return (
    <div className="flex flex-col h-screen bg-gray-900 overflow-hidden">
      {/* ヘッダー */}
      <div className="bg-gray-800 text-white px-3 py-2 flex items-center justify-between text-sm shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-bold">{gameState.day}日目</span>
          <span className="flex items-center gap-1">
            <Timer className="w-4 h-4" />
            {Math.floor(gameState.timeRemaining / 60)}:
            {String(gameState.timeRemaining % 60).padStart(2, "0")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-blue-300">🎣 ¥{gameState.brotherMoney.toLocaleString()}</span>
          <span className="text-red-300">🍣 ¥{gameState.youngerMoney.toLocaleString()}</span>
        </div>
      </div>

      {/* 市場トレンド */}
      <div className="bg-gray-700 text-xs text-white px-3 py-1 flex gap-2 overflow-x-auto shrink-0">
        <span className="text-gray-400 shrink-0">📈 市場:</span>
        {Object.entries(gameState.marketTrend).map(([species, mult]) => {
          const fish = FISH_DATABASE[species as FishSpecies];
          const pct = Math.round(((mult as number) - 1) * 100);
          const color = pct > 0 ? "text-green-400" : "text-red-400";
          return (
            <span key={species} className={`${color} shrink-0`}>
              {fish.displayName} {pct > 0 ? "+" : ""}
              {pct}%
            </span>
          );
        })}
      </div>

      {/* フェーズ切替タブ */}
      <div className="flex shrink-0">
        <button
          onClick={switchToFishing}
          className={`flex-1 py-2 text-sm font-bold transition-colors ${
            gameState.phase === "fishing"
              ? "bg-blue-600 text-white"
              : "bg-gray-600 text-gray-300"
          }`}
        >
          <Fish className="inline w-4 h-4 mr-1" />
          釣り（兄）
        </button>
        <button
          onClick={switchToCooking}
          className={`flex-1 py-2 text-sm font-bold transition-colors ${
            gameState.phase === "cooking"
              ? "bg-red-600 text-white"
              : "bg-gray-600 text-gray-300"
          }`}
        >
          🍣 調理（弟）
          {gameState.inventory.filter((f) => !f.processed).length > 0 && (
            <span className="ml-1 bg-yellow-400 text-gray-900 rounded-full px-1.5 text-xs">
              {gameState.inventory.filter((f) => !f.processed).length}
            </span>
          )}
        </button>
        <button
          onClick={() => setGameState((p) => ({ ...p, phase: "market" }))}
          className={`flex-1 py-2 text-sm font-bold transition-colors ${
            gameState.phase === "market"
              ? "bg-green-600 text-white"
              : "bg-gray-600 text-gray-300"
          }`}
        >
          💰 市場
        </button>
      </div>

      {/* メッセージバー */}
      {message && (
        <div className="bg-yellow-400 text-gray-900 text-center py-1 text-sm font-bold animate-pulse shrink-0">
          {message}
        </div>
      )}

      {/* ゲームエリア */}
      <div className="flex-1 relative overflow-hidden" ref={containerRef}>
        {gameState.phase === "fishing" && (
          <div
            className="w-full h-full relative"
            onClick={handleWaterClick}
            onTouchStart={handleWaterClick}
          >
            {/* 水面エフェクト（Canvas: グラデ+光+パーティクル+波紋） */}
            <WaterSurface
              width={dimensions.width}
              height={dimensions.height}
              ripples={ripples}
            />

            {/* パララックス背景（画像素材レイヤー） */}
            <ParallaxLayers
              width={dimensions.width}
              height={dimensions.height}
            />

            {/* 魚影（奥行き順にソートして描画） */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            >
              {[...fishes]
                .sort((a, b) => a.depth - b.depth) // 奥から描画
                .map((f) => {
                  const depthOpacity = 0.15 + f.depth * 0.55; // 奥:薄い 手前:濃い
                  const canCatch = f.depth >= 0.5;
                  return (
                    <FishSilhouette
                      key={f.id}
                      species={f.species}
                      stageIndex={f.stageIndex}
                      x={f.x}
                      y={f.y}
                      depth={f.depth}
                      opacity={depthOpacity}
                      catchable={canCatch}
                    />
                  );
                })}
            </svg>

            {/* ルアー */}
            {lure.active && (
              <div
                className="absolute w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-lg animate-bounce pointer-events-none"
                style={{
                  left: lure.x - 6,
                  top: lure.y - 6,
                }}
              />
            )}

            {/* キャッチアニメーション */}
            {catchAnimation && (
              <div
                className="absolute pointer-events-none animate-bounce"
                style={{
                  left: catchAnimation.fish.x - 40,
                  top: catchAnimation.fish.y - 50,
                }}
              >
                <div
                  className={`text-2xl font-bold ${
                    catchAnimation.success ? "text-yellow-300" : "text-red-400"
                  } drop-shadow-lg`}
                >
                  {catchAnimation.success ? "🎣 HIT!" : "💨 バラシ"}
                </div>
              </div>
            )}

            {/* ファイトオーバーレイ */}
            {fightTarget && (
              <FightOverlay
                species={fightTarget.species}
                stageIndex={fightTarget.stageIndex}
                fishX={fightTarget.x}
                fishY={fightTarget.y}
                onSuccess={handleFightSuccess}
                onFail={handleFightFail}
              />
            )}

            {/* 操作ヒント */}
            {fishes.length === 0 && !fightTarget && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-white/50 text-center">
                  <Waves className="w-8 h-8 mx-auto mb-2 animate-pulse" />
                  <p className="text-sm">魚影を待っています...</p>
                </div>
              </div>
            )}
          </div>
        )}

        {gameState.phase === "cooking" && (
          <CookingGame
            inventory={gameState.inventory.filter((f) => !f.processed)}
            marketTrend={gameState.marketTrend}
            onSell={handleSell}
          />
        )}

        {gameState.phase === "market" && (
          <MarketView gameState={gameState} />
        )}
      </div>

      {/* 店舗ランク */}
      <div className="bg-gray-800 text-center text-xs text-amber-400 py-1 shrink-0">
        🏪 {SHOP_RANK_NAMES[gameState.shopRank]} | 合計資産: ¥
        {gameState.totalAssets.toLocaleString()}
      </div>
    </div>
  );
}
