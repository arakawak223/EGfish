// ゲームセーブ/ロード

import { GameState, createInitialState } from "./game-state";

const SAVE_KEY = "angler-artisan-save";

export interface SaveData {
  gameState: GameState;
  savedAt: number;
  playerName: string;
}

export function saveGame(gameState: GameState, playerName: string): void {
  if (typeof window === "undefined") return;
  const data: SaveData = {
    gameState: {
      ...gameState,
      // フェーズは釣りに戻す（途中状態は保存しない）
      phase: "fishing",
      catches: [],
      inventory: [],
    },
    savedAt: Date.now(),
    playerName,
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

export function loadGame(): SaveData | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SaveData;
    // 基本的なバリデーション
    if (!data.gameState || typeof data.gameState.day !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

export function hasSaveData(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(SAVE_KEY) !== null;
}

export function deleteSave(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SAVE_KEY);
}
