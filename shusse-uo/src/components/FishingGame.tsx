"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Fish, Anchor, Timer, Waves, Trophy, ChevronRight, Pause, Play, Settings } from "lucide-react";
import {
  FishSpecies,
  FISH_DATABASE,
  rollFishSpecies,
  rollFishStage,
  getSeasonMultiplier,
} from "@/lib/fish-data";
import { vibrateFishSpecific, vibrateMiss, vibrate, HAPTIC_PATTERNS } from "@/lib/haptics";
import { apiUrl } from "@/lib/api-url";
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
import HapticFishingOverlay, { ProbeFish } from "./HapticFishingOverlay";
import CookingGame from "./CookingGame";
import LoginScreen from "./LoginScreen";
import RankingBoard from "./RankingBoard";
import { getPlayer, savePlayer } from "@/lib/player";
import { saveGame, loadGame, hasSaveData } from "@/lib/save-game";
import MarketView from "./MarketView";
import {
  GameSettings,
  SpeedLevel,
  FishingMode,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  FISHING_SPEED_MULT,
  COOKING_TIME_MULT,
  SPEED_LABEL,
  FISHING_MODE_LABEL,
  FISHING_MODE_DESC,
} from "@/lib/game-settings";

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
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showRanking, setShowRanking] = useState(false);
  const [initialized, setInitialized] = useState(false);
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
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fishingAttempt, setFishingAttempt] = useState(0); // 触覚オーバーレイの再マウント用
  const containerRef = useRef<HTMLDivElement>(null);
  const fishIdCounter = useRef(0);
  const pauseStartRef = useRef<number | null>(null);

  // 設定ロード
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const updateSettings = useCallback((partial: Partial<GameSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      return next;
    });
  }, []);

  // 一時停止の開始/終了で、鮮度計算に影響する caughtAt / spawnTime をシフト
  useEffect(() => {
    if (paused) {
      pauseStartRef.current = Date.now();
      return;
    }
    if (pauseStartRef.current != null) {
      const delta = Date.now() - pauseStartRef.current;
      pauseStartRef.current = null;
      if (delta > 0) {
        setGameState((prev) => ({
          ...prev,
          inventory: prev.inventory.map((f) => ({ ...f, caughtAt: f.caughtAt + delta })),
          catches: prev.catches.map((f) => ({ ...f, caughtAt: f.caughtAt + delta })),
        }));
        setFishes((prev) => prev.map((f) => ({ ...f, spawnTime: f.spawnTime + delta })));
      }
    }
  }, [paused]);

  // 初期化: 既存プレイヤー & セーブデータのロード
  useEffect(() => {
    const player = getPlayer();
    if (player) {
      setPlayerName(player.name);
      const save = loadGame();
      if (save) {
        setGameState({ ...save.gameState, phase: "title" });
      }
    }
    setInitialized(true);
  }, []);

  // ログイン処理
  const handleLogin = (name: string) => {
    savePlayer(name);
    setPlayerName(name);
    const save = loadGame();
    if (save && save.playerName === name) {
      setGameState({ ...save.gameState, phase: "title" });
    }
  };
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
    if (gameState.phase !== "fishing" || paused) return;
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
        vx: (fromLeft ? 1 : -1) * (0.2 + Math.random() * 0.6),
        vy: (Math.random() - 0.5) * 0.25,
        depth: initialDepth,
        vDepth: (Math.random() - 0.3) * 0.008, // やや手前に来る傾向
        spawnTime: Date.now(),
      };
      setFishes((prev) => [...prev, newFish]);
    }, 2000 + Math.random() * 2500);

    return () => clearInterval(interval);
  }, [gameState.phase, fishes.length, dimensions, paused]);

  // 魚の移動アニメーション
  useEffect(() => {
    if (gameState.phase !== "fishing" || paused) return;
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
  }, [gameState.phase, dimensions, paused]);

  // タイマー
  useEffect(() => {
    if (gameState.phase !== "fishing" && gameState.phase !== "cooking") return;
    if (paused) return;
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
  }, [gameState.phase, paused]);

  // 水面クリック: ルアー投入
  const handleWaterClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      if (gameState.phase !== "fishing" || fightTarget || paused) return;

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
    [gameState.phase, fishes, fightTarget, paused]
  );

  // ── 触覚モード: 噛みつき開始 / フッキング成功 / バラシ ──
  const handleHapticBiteStart = useCallback((fish: ProbeFish) => {
    setFishes((prev) => prev.map((f) => f.id === fish.id ? { ...f, vx: 0, vy: 0, vDepth: 0 } : f));
    setMessage("ガツン！— 今すぐタップ！");
  }, []);

  const handleHapticHook = useCallback((fish: ProbeFish) => {
    // 魚が何らかの理由で消えていても biteFish データからフォールバック合成
    const found = fishes.find((f) => f.id === fish.id);
    const target: SwimmingFish = found ?? {
      id: fish.id,
      species: fish.species,
      stageIndex: fish.stageIndex,
      x: fish.x,
      y: fish.y,
      depth: fish.depth,
      vx: 0, vy: 0, vDepth: 0,
      spawnTime: Date.now(),
    };
    const fishData = FISH_DATABASE[target.species];
    const stage = fishData.stages[target.stageIndex];
    playSEHit();
    setCatchAnimation({ fish: target, success: true });
    setFightTarget(target);
    setMessage(`${stage.name}（${fishData.displayName}）がヒット！巻き上げろ！`);
    setTimeout(() => setCatchAnimation(null), 800);
  }, [fishes]);

  const handleHapticBarashi = useCallback((fish: ProbeFish | null) => {
    if (fish) setFishes((prev) => prev.filter((f) => f.id !== fish.id));
    playSEMiss();
    setMessage("バラシ！タップが遅れた...");
    setTimeout(() => setMessage(""), 1800);
    // 失敗でもオーバーレイをフレッシュに入れ替え
    setFishingAttempt((c) => c + 1);
  }, []);

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
    setFishingAttempt((c) => c + 1);
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
    setFishingAttempt((c) => c + 1);
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
    setGameState((prev) => {
      const next = {
        ...createInitialState(),
        day: prev.day + 1,
        brotherMoney: prev.brotherMoney,
        youngerMoney: prev.youngerMoney,
        totalAssets: prev.totalAssets,
        shopRank: prev.shopRank,
        phase: "fishing" as const,
      };
      // オートセーブ
      if (playerName) saveGame(next, playerName);
      return next;
    });
    setFishes([]);
    setRipples([]);
  };

  // ランキング送信（リザルト画面表示時）
  const submitRanking = useCallback(() => {
    if (!playerName) return;
    fetch(apiUrl("/api/rankings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: playerName,
        totalAssets: gameState.totalAssets,
        shopRank: gameState.shopRank,
        day: gameState.day,
      }),
    }).catch(() => {});
  }, [playerName, gameState.totalAssets, gameState.shopRank, gameState.day]);

  // --- 初期化中 ---
  if (!initialized) return null;

  // --- ログイン画面 ---
  if (!playerName) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        hasSave={hasSaveData()}
        savedName={getPlayer()?.name}
      />
    );
  }

  // --- ランキング画面 ---
  if (showRanking) {
    return <RankingBoard playerName={playerName} onClose={() => setShowRanking(false)} />;
  }

  // --- タイトル画面 ---
  if (gameState.phase === "title") {
    return (
      <div className="flex flex-col items-center min-h-screen bg-gradient-to-b from-sky-400 to-blue-900 text-white px-4 py-8 overflow-y-auto">
        <div className="text-center w-full">
          <h1 className="text-4xl font-bold mb-2 tracking-wide">
            🐟 Angler & Artisan
          </h1>
          <p className="text-lg text-blue-200 mb-1">釣り師と寿司職人</p>
          <p className="text-sm text-blue-300 mb-8">
            漁師の兄 × 寿司職人の弟
          </p>

          <div className="bg-white/10 backdrop-blur rounded-xl p-5 mb-6 text-left text-sm max-w-sm mx-auto">
            <p className="mb-2">
              <Fish className="inline w-4 h-4 mr-1" />
              <strong>兄（漁師）:</strong> 魚影をタップして出世魚を釣り上げろ！
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

          {/* 出世魚図鑑 */}
          <div className="bg-white/10 backdrop-blur rounded-xl p-4 mb-6 text-left text-xs max-w-sm mx-auto">
            <h3 className="font-bold text-sm text-center mb-3">🐟 出世魚図鑑</h3>
            <div className="space-y-2.5">
              <div>
                <p className="font-bold text-blue-200">ブリ <span className="font-normal text-blue-300/70">（大物）</span></p>
                <p className="text-blue-300">ワカシ → イナダ → ワラサ → <span className="text-yellow-300 font-bold">ブリ</span></p>
                <p className="text-blue-400 mt-0.5">大きいほど高単価。最終段階は高値の花</p>
              </div>
              <div>
                <p className="font-bold text-green-200">スズキ <span className="font-normal text-green-300/70">（夏の王者）</span></p>
                <p className="text-blue-300">セイゴ → フッコ → <span className="text-yellow-300 font-bold">スズキ</span></p>
                <p className="text-blue-400 mt-0.5">夏場（6〜8月）は価格1.5倍ボーナス！</p>
              </div>
              <div>
                <p className="font-bold text-cyan-200">マイワシ <span className="font-normal text-cyan-300/70">（軍艦の星）</span></p>
                <p className="text-blue-300"><span className="text-yellow-300 font-bold">シラス</span> → カエリ → イワシ</p>
                <p className="text-blue-400 mt-0.5">シラスは軍艦ネタで高単価。小さいほど美味</p>
              </div>
              <div>
                <p className="font-bold text-amber-200">サワラ <span className="font-normal text-amber-300/70">（炙りの至宝）</span></p>
                <p className="text-blue-300">サゴシ → ナギ → <span className="text-yellow-300 font-bold">サワラ</span></p>
                <p className="text-blue-400 mt-0.5">炙り加工で寿司価格が跳ね上がる</p>
              </div>
              <div className="bg-yellow-400/10 rounded-lg p-2 -mx-1">
                <p className="font-bold text-yellow-200">🔥 コノシロ <span className="font-normal text-yellow-300/70">（逆転の超レア）</span></p>
                <p className="text-blue-300"><span className="text-yellow-300 font-bold">シンコ</span> → コハダ → ナカズミ → コノシロ</p>
                <p className="text-yellow-400 mt-0.5 font-semibold">小さいほど超高単価！シンコは最高値 ¥5,000</p>
              </div>
            </div>
          </div>

          {/* プレイヤー名 & セーブ情報 */}
          <div className="bg-white/10 backdrop-blur rounded-lg p-2 mb-4 text-sm max-w-sm mx-auto">
            <span className="text-blue-200">プレイヤー: </span>
            <span className="font-bold">{playerName}</span>
            {gameState.day > 1 && (
              <span className="text-blue-300 ml-2">
                （{gameState.day}日目 / ¥{gameState.totalAssets.toLocaleString()}）
              </span>
            )}
          </div>

          {/* 速度設定 */}
          <div className="bg-white/10 backdrop-blur rounded-xl p-4 mb-4 text-left max-w-sm mx-auto">
            <h3 className="font-bold text-sm text-center mb-3">⚙️ 速度設定</h3>
            <SpeedPicker
              label="🎣 釣りの回転速度"
              value={settings.fishingSpeed}
              onChange={(v) => updateSettings({ fishingSpeed: v })}
            />
            <div className="h-2" />
            <SpeedPicker
              label="🍣 さばきのカット速度"
              value={settings.cookingSpeed}
              onChange={(v) => updateSettings({ cookingSpeed: v })}
            />
            <div className="h-3" />
            <FishingModePicker
              value={settings.fishingMode}
              onChange={(v) => updateSettings({ fishingMode: v })}
            />
            <p className="text-[10px] text-blue-300/80 mt-2 text-center">
              プレイ中でも ⚙ ボタンから変更できます
            </p>
          </div>

          <div className="flex gap-3 justify-center max-w-sm mx-auto">
            <button
              onClick={startGame}
              className="flex-1 bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 px-6 rounded-full text-lg shadow-lg transition-all hover:scale-105 active:scale-95"
            >
              {gameState.day > 1 ? "続きから" : "出航する"}
              <ChevronRight className="inline w-5 h-5 ml-1" />
            </button>
            <button
              onClick={() => setShowRanking(true)}
              className="bg-amber-500 hover:bg-amber-600 text-white font-bold py-3 px-5 rounded-full shadow-lg transition-all hover:scale-105 active:scale-95"
            >
              <Trophy className="inline w-5 h-5" />
            </button>
          </div>
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

        <div className="flex gap-3 w-full max-w-sm">
          <button
            onClick={() => { submitRanking(); nextDay(); }}
            className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-full shadow-lg transition-all hover:scale-105 active:scale-95"
          >
            {gameState.day + 1}日目へ
            <ChevronRight className="inline w-5 h-5 ml-1" />
          </button>
          <button
            onClick={() => { submitRanking(); setShowRanking(true); }}
            className="bg-amber-500 hover:bg-amber-600 text-white font-bold py-3 px-5 rounded-full shadow-lg transition-all hover:scale-105 active:scale-95"
          >
            <Trophy className="inline w-5 h-5" />
          </button>
        </div>

        <p className="text-gray-400 text-xs mt-3">スコアは自動でランキングに送信されます</p>
      </div>
    );
  }

  // --- メインゲーム画面（釣り / 調理 / 市場） ---
  return (
    <div className="flex flex-col h-screen bg-gray-900 overflow-hidden relative">
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
        <div className="flex items-center gap-2">
          <span className="text-blue-300">🎣 ¥{gameState.brotherMoney.toLocaleString()}</span>
          <span className="text-red-300">🍣 ¥{gameState.youngerMoney.toLocaleString()}</span>
          <button
            onClick={() => setPaused((p) => !p)}
            className="bg-gray-700 hover:bg-gray-600 rounded-md p-1.5 ml-1 active:scale-95 transition-all"
            title={paused ? "再開" : "一時停止"}
            aria-label={paused ? "再開" : "一時停止"}
          >
            {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="bg-gray-700 hover:bg-gray-600 rounded-md p-1.5 active:scale-95 transition-all"
            title="設定"
            aria-label="設定"
          >
            <Settings className="w-4 h-4" />
          </button>
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
            onClick={settings.fishingMode === "classic" ? handleWaterClick : undefined}
            onTouchStart={settings.fishingMode === "classic" ? handleWaterClick : undefined}
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

            {/* 触覚モード: Spot & Timing オーバーレイ
                attemptId で内部状態のソフトリセット（remount ではない） */}
            {settings.fishingMode === "haptic" && !fightTarget && (
              <HapticFishingOverlay
                attemptId={fishingAttempt}
                fishes={fishes}
                paused={paused}
                onHook={handleHapticHook}
                onBiteStart={handleHapticBiteStart}
                onBarashi={handleHapticBarashi}
              />
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
                speedMultiplier={FISHING_SPEED_MULT[settings.fishingSpeed]}
                paused={paused}
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
            timeMultiplier={COOKING_TIME_MULT[settings.cookingSpeed]}
            paused={paused}
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

      {/* 一時停止オーバーレイ */}
      {paused && (
        <div className="absolute inset-0 z-40 bg-black/70 flex items-center justify-center">
          <div className="bg-gray-800 text-white rounded-2xl shadow-2xl p-6 max-w-xs w-[85%] text-center">
            <Pause className="w-10 h-10 mx-auto mb-2 text-yellow-300" />
            <h3 className="text-xl font-bold mb-1">一時停止中</h3>
            <p className="text-xs text-gray-400 mb-4">
              タイマー・魚・カウンターは停止しています
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setPaused(false)}
                className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-2.5 rounded-lg active:scale-95 transition-all"
              >
                <Play className="inline w-4 h-4 mr-1" />
                再開
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="w-full bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm active:scale-95 transition-all"
              >
                <Settings className="inline w-4 h-4 mr-1" />
                設定を変更
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 設定モーダル */}
      {settingsOpen && (
        <div
          className="absolute inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="bg-white text-gray-800 rounded-2xl shadow-2xl p-5 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">⚙️ 速度設定</h3>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none"
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <SpeedPicker
              label="🎣 釣りの回転速度"
              value={settings.fishingSpeed}
              onChange={(v) => updateSettings({ fishingSpeed: v })}
              dark={false}
            />
            <div className="h-3" />
            <SpeedPicker
              label="🍣 さばきのカット速度"
              value={settings.cookingSpeed}
              onChange={(v) => updateSettings({ cookingSpeed: v })}
              dark={false}
            />
            <div className="h-3" />
            <FishingModePicker
              value={settings.fishingMode}
              onChange={(v) => updateSettings({ fishingMode: v })}
              dark={false}
            />
            <p className="text-xs text-gray-500 mt-3 text-center">
              変更はすぐに反映されます
            </p>
            <button
              onClick={() => setSettingsOpen(false)}
              className="w-full mt-4 bg-blue-500 hover:bg-blue-600 text-white py-2.5 rounded-lg font-bold active:scale-95 transition-all"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// 釣りモード選択ピッカー
function FishingModePicker({
  value,
  onChange,
  dark = true,
}: {
  value: FishingMode;
  onChange: (v: FishingMode) => void;
  dark?: boolean;
}) {
  const modes: FishingMode[] = ["classic", "haptic"];
  return (
    <div>
      <p className={`text-xs mb-1 ${dark ? "text-blue-200" : "text-gray-600"}`}>🎯 釣りアクション</p>
      <div className="flex gap-1.5">
        {modes.map((m) => {
          const active = m === value;
          const base = "flex-1 py-2 rounded-lg text-[11px] font-bold transition-all active:scale-95 leading-tight";
          const activeCls = dark
            ? "bg-orange-500 text-white shadow"
            : "bg-blue-500 text-white shadow";
          const inactiveCls = dark
            ? "bg-white/10 text-blue-100 hover:bg-white/20"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200";
          return (
            <button
              key={m}
              onClick={() => onChange(m)}
              className={`${base} ${active ? activeCls : inactiveCls}`}
              title={FISHING_MODE_DESC[m]}
            >
              <div>{FISHING_MODE_LABEL[m]}</div>
              <div className={`text-[9px] font-normal mt-0.5 ${active ? "opacity-90" : "opacity-60"}`}>
                {FISHING_MODE_DESC[m]}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 速度選択ピッカー: タイトル / 設定モーダル共通
function SpeedPicker({
  label,
  value,
  onChange,
  dark = true,
}: {
  label: string;
  value: SpeedLevel;
  onChange: (v: SpeedLevel) => void;
  dark?: boolean;
}) {
  const levels: SpeedLevel[] = ["slow", "normal", "fast"];
  return (
    <div>
      <p className={`text-xs mb-1 ${dark ? "text-blue-200" : "text-gray-600"}`}>{label}</p>
      <div className="flex gap-1.5">
        {levels.map((lv) => {
          const active = lv === value;
          const base = "flex-1 py-2 rounded-lg text-sm font-bold transition-all active:scale-95";
          const activeCls = dark
            ? "bg-orange-500 text-white shadow"
            : "bg-blue-500 text-white shadow";
          const inactiveCls = dark
            ? "bg-white/10 text-blue-100 hover:bg-white/20"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200";
          return (
            <button
              key={lv}
              onClick={() => onChange(lv)}
              className={`${base} ${active ? activeCls : inactiveCls}`}
            >
              {SPEED_LABEL[lv]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
