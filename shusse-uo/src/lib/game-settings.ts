// 速度設定: 釣りの回転 / 調理のカット
export type SpeedLevel = "slow" | "normal" | "fast";

// 釣りの針回転速度倍率。現状実装が「遅め」基準なので slow=1.0
// 体感が遅めという要望で 3段階すべてを底上げ
export const FISHING_SPEED_MULT: Record<SpeedLevel, number> = {
  slow: 1.35,
  normal: 1.75,
  fast: 2.25,
};

// 調理のカット速度に対応する「時間倍率」。
// 現状実装が「速め」基準なので fast=1.0、ゆっくりにするほど時間が伸びる。
// この倍率は timing ゲートの拍・窓、理想カット時間 (idealMs) に掛ける。
export const COOKING_TIME_MULT: Record<SpeedLevel, number> = {
  fast: 1.0,
  normal: 1.3,
  slow: 1.6,
};

export interface GameSettings {
  fishingSpeed: SpeedLevel;
  cookingSpeed: SpeedLevel;
}

const STORAGE_KEY = "shusse-uo-settings";

export const DEFAULT_SETTINGS: GameSettings = {
  fishingSpeed: "slow",
  cookingSpeed: "fast",
};

export function loadSettings(): GameSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      fishingSpeed: parsed.fishingSpeed ?? DEFAULT_SETTINGS.fishingSpeed,
      cookingSpeed: parsed.cookingSpeed ?? DEFAULT_SETTINGS.cookingSpeed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: GameSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export const SPEED_LABEL: Record<SpeedLevel, string> = {
  slow: "遅め",
  normal: "普通",
  fast: "速め",
};
