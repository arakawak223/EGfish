// ゲーム全体の状態管理

import { FishSpecies } from "./fish-data";

export type GamePhase = "title" | "fishing" | "cooking" | "market" | "result";
export type ShopRank = "yatai" | "kaiten" | "ginza";

export interface CaughtFish {
  id: string;
  species: FishSpecies;
  stageIndex: number;
  stageName: string;
  basePrice: number;
  sushiPrice: number;
  freshness: number; // 0-100, 時間経過で減少
  caughtAt: number;  // timestamp
  processed: boolean;
  sold: boolean;
  soldPrice?: number;
}

export interface GameState {
  phase: GamePhase;
  day: number;           // ゲーム内日数
  timeRemaining: number; // 1日の残り時間(秒)
  brotherMoney: number;  // 兄（漁師）の資産
  youngerMoney: number;  // 弟（職人）の資産
  totalAssets: number;   // 合計資産
  shopRank: ShopRank;
  catches: CaughtFish[];
  inventory: CaughtFish[]; // 弟の在庫（未調理）
  marketTrend: Partial<Record<FishSpecies, number>>; // 魚種ごとの市場倍率
}

export function createInitialState(): GameState {
  return {
    phase: "title",
    day: 1,
    timeRemaining: 180, // 1日3分
    brotherMoney: 0,
    youngerMoney: 0,
    totalAssets: 0,
    shopRank: "yatai",
    catches: [],
    inventory: [],
    marketTrend: generateMarketTrend(),
  };
}

// 市場トレンドをランダム生成
function generateMarketTrend(): Partial<Record<FishSpecies, number>> {
  const species: FishSpecies[] = ["buri", "suzuki", "maiwashi", "sawara", "konoshiro"];
  const trend: Partial<Record<FishSpecies, number>> = {};
  // 1-2種にボーナス、1種にマイナス
  const bonusCount = Math.floor(Math.random() * 2) + 1;
  const shuffled = [...species].sort(() => Math.random() - 0.5);
  for (let i = 0; i < bonusCount; i++) {
    trend[shuffled[i]] = 1.3 + Math.random() * 0.4; // +30%~+70%
  }
  trend[shuffled[shuffled.length - 1]] = 0.6 + Math.random() * 0.2; // -20%~-40%
  return trend;
}

// 店舗ランク判定
export function calculateShopRank(totalAssets: number): ShopRank {
  if (totalAssets >= 50000) return "ginza";
  if (totalAssets >= 15000) return "kaiten";
  return "yatai";
}

export const SHOP_RANK_NAMES: Record<ShopRank, string> = {
  yatai: "屋台",
  kaiten: "回転寿司",
  ginza: "銀座の名店",
};

// 鮮度計算（時間経過で減少）
export function calculateFreshness(caughtAt: number, now: number): number {
  const elapsed = (now - caughtAt) / 1000; // 秒
  const freshness = Math.max(0, 100 - elapsed * 1.5); // 約67秒で0
  return Math.round(freshness);
}
