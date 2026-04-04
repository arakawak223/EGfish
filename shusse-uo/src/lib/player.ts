// プレイヤー情報管理

export interface PlayerInfo {
  name: string;
  createdAt: number;
}

const PLAYER_KEY = "angler-artisan-player";

export function getPlayer(): PlayerInfo | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(PLAYER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function savePlayer(name: string): PlayerInfo {
  const player: PlayerInfo = { name, createdAt: Date.now() };
  localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  return player;
}

export function clearPlayer(): void {
  localStorage.removeItem(PLAYER_KEY);
}
