"use client";

import { FishSpecies, FISH_DATABASE } from "@/lib/fish-data";

interface FishSilhouetteProps {
  species: FishSpecies;
  stageIndex: number;
  x: number;
  y: number;
  depth?: number;
  opacity?: number;
  catchable?: boolean;
  onClick?: () => void;
}

// 魚種ごとの詳細SVGパス
// body: 本体, tail: 尾びれ, dorsal: 背びれ, pectoral: 胸びれ, ventral: 腹びれ
interface FishPaths {
  body: string;
  tail: string;
  dorsal?: string;
  pectoral?: string;
  belly?: string; // 腹部ライン
  eyeX: number;
  eyeY: number;
  colors: {
    top: string;     // 背中
    mid: string;     // 側面
    bottom: string;  // 腹
    fin: string;     // ひれ
    accent?: string; // 模様
  };
}

const FISH_DETAILS: Record<FishSpecies, FishPaths> = {
  buri: {
    // ブリ: がっしりした紡錘形、背は濃紺、腹は銀白
    body: "M -12,0 C -12,-7 -6,-13 2,-14 C 10,-14 22,-11 30,-5 C 34,-2 34,2 30,5 C 22,11 10,14 2,14 C -6,13 -12,7 -12,0 Z",
    tail: "M 30,-5 C 34,-3 36,-8 40,-10 L 38,0 L 40,10 C 36,8 34,3 30,5 Z",
    dorsal: "M 2,-14 C 6,-18 14,-17 20,-14 C 16,-14 10,-14 2,-14 Z",
    pectoral: "M 0,2 C 2,6 -2,10 -5,8 C -3,6 -1,4 0,2 Z",
    belly: "M -8,6 C 0,10 12,10 26,4",
    eyeX: -4, eyeY: -3,
    colors: {
      top: "#1a3a5f",
      mid: "#3a6a8f",
      bottom: "#b0c8d8",
      fin: "#2a5070",
      accent: "#4a8aaf",
    },
  },
  suzuki: {
    // スズキ: 細長く銀色、大きな口
    body: "M -12,0 C -12,-6 -4,-11 4,-12 C 14,-12 24,-8 32,-3 C 35,0 35,0 32,3 C 24,8 14,12 4,12 C -4,11 -12,6 -12,0 Z",
    tail: "M 32,-3 C 35,-1 38,-7 42,-9 L 40,0 L 42,9 C 38,7 35,1 32,3 Z",
    dorsal: "M 4,-12 C 8,-16 16,-16 24,-12 L 20,-12 Z",
    pectoral: "M -2,2 C 0,7 -4,9 -6,7 Z",
    belly: "M -8,5 C 2,9 14,9 28,3",
    eyeX: -5, eyeY: -2,
    colors: {
      top: "#4a6a5a",
      mid: "#8aaa9a",
      bottom: "#d0ddd5",
      fin: "#5a7a6a",
    },
  },
  maiwashi: {
    // マイワシ: 小さく丸みのある体、銀色に青い背中、黒い斑点
    body: "M -8,0 C -8,-5 -3,-8 3,-9 C 10,-9 18,-6 24,-2 C 26,0 26,0 24,2 C 18,6 10,9 3,9 C -3,8 -8,5 -8,0 Z",
    tail: "M 24,-2 C 26,0 28,-4 32,-6 L 30,0 L 32,6 C 28,4 26,0 24,2 Z",
    pectoral: "M -2,1 C 0,4 -2,6 -4,5 Z",
    belly: "M -5,4 C 2,7 12,7 20,2",
    eyeX: -3, eyeY: -2,
    colors: {
      top: "#2a4a6a",
      mid: "#7a9aaa",
      bottom: "#d0dce8",
      fin: "#4a6a80",
      accent: "#1a3050",
    },
  },
  sawara: {
    // サワラ: 細長い流線型、鋭い顔つき
    body: "M -14,0 C -14,-5 -6,-10 4,-11 C 16,-11 28,-7 36,-3 C 40,0 40,0 36,3 C 28,7 16,11 4,11 C -6,10 -14,5 -14,0 Z",
    tail: "M 36,-3 C 38,0 40,-6 44,-8 L 42,0 L 44,8 C 40,6 38,0 36,3 Z",
    dorsal: "M 6,-11 C 10,-14 18,-14 26,-11 Z",
    pectoral: "M -4,1 C -2,5 -5,8 -7,6 Z",
    belly: "M -10,4 C 0,8 16,8 32,3",
    eyeX: -7, eyeY: -2,
    colors: {
      top: "#4a5a4a",
      mid: "#8a9a8a",
      bottom: "#c8d0c8",
      fin: "#5a6a5a",
      accent: "#3a4a3a",
    },
  },
  konoshiro: {
    // コノシロ: 平たい体、銀色
    body: "M -8,0 C -8,-6 -2,-10 4,-11 C 12,-11 20,-7 26,-2 C 28,0 28,0 26,2 C 20,7 12,11 4,11 C -2,10 -8,6 -8,0 Z",
    tail: "M 26,-2 C 28,0 30,-5 34,-7 L 32,0 L 34,7 C 30,5 28,0 26,2 Z",
    dorsal: "M 4,-11 C 7,-14 13,-14 18,-11 Z",
    pectoral: "M -2,1 C 0,5 -3,7 -5,5 Z",
    belly: "M -5,5 C 4,8 14,8 22,2",
    eyeX: -3, eyeY: -3,
    colors: {
      top: "#6a7a6a",
      mid: "#b0baa0",
      bottom: "#dce0d0",
      fin: "#8a9a7a",
      accent: "#c0a060",
    },
  },
};

export default function FishSilhouette({
  species,
  stageIndex,
  x,
  y,
  depth = 1,
  opacity = 0.6,
  catchable = true,
  onClick,
}: FishSilhouetteProps) {
  const fish = FISH_DATABASE[species];
  const stage = fish.stages[stageIndex];
  const detail = FISH_DETAILS[species];
  const depthScale = 0.35 + depth * 0.65;
  const scale = stage.silhouetteScale * 2.5 * depthScale;
  const blur = (1 - depth) * 2.5;
  const gradId = `fish-grad-${species}-${x}-${y}`;
  const facingLeft = true; // 魚は左向きデフォルト

  return (
    <g
      transform={`translate(${x}, ${y}) scale(${scale})`}
      onClick={onClick}
      className="cursor-pointer"
      style={{ filter: `blur(${blur}px)` }}
    >
      <defs>
        {/* 体のグラデーション（背→腹） */}
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={detail.colors.top} stopOpacity={opacity} />
          <stop offset="40%" stopColor={detail.colors.mid} stopOpacity={opacity} />
          <stop offset="100%" stopColor={detail.colors.bottom} stopOpacity={opacity * 0.9} />
        </linearGradient>
      </defs>

      {/* 背びれ */}
      {detail.dorsal && (
        <path
          d={detail.dorsal}
          fill={detail.colors.fin}
          opacity={opacity * 0.8}
        />
      )}

      {/* 尾びれ */}
      <path
        d={detail.tail}
        fill={detail.colors.fin}
        opacity={opacity * 0.85}
      />

      {/* 本体 */}
      <path
        d={detail.body}
        fill={`url(#${gradId})`}
      />

      {/* 側線（lateral line） */}
      {detail.belly && (
        <path
          d={detail.belly}
          fill="none"
          stroke={detail.colors.bottom}
          strokeWidth={0.5}
          opacity={opacity * 0.4}
        />
      )}

      {/* 胸びれ */}
      {detail.pectoral && (
        <path
          d={detail.pectoral}
          fill={detail.colors.fin}
          opacity={opacity * 0.7}
        />
      )}

      {/* マイワシの黒い斑点 */}
      {species === "maiwashi" && depth > 0.4 && detail.colors.accent && (
        <>
          <circle cx={2} cy={0} r={0.8} fill={detail.colors.accent} opacity={opacity * 0.5} />
          <circle cx={6} cy={-1} r={0.6} fill={detail.colors.accent} opacity={opacity * 0.4} />
          <circle cx={10} cy={0} r={0.7} fill={detail.colors.accent} opacity={opacity * 0.45} />
          <circle cx={14} cy={-1} r={0.5} fill={detail.colors.accent} opacity={opacity * 0.35} />
        </>
      )}

      {/* ブリの黄色い帯 */}
      {species === "buri" && depth > 0.4 && (
        <path
          d="M -6,0 C 4,-1 16,-1 28,0"
          fill="none"
          stroke="#c8a830"
          strokeWidth={1.2}
          opacity={opacity * 0.4}
        />
      )}

      {/* 目 */}
      {depth > 0.35 && (
        <>
          <circle
            cx={detail.eyeX}
            cy={detail.eyeY}
            r={2}
            fill={`rgba(255,255,255,${depth * 0.5})`}
          />
          <circle
            cx={detail.eyeX}
            cy={detail.eyeY}
            r={1}
            fill={`rgba(0,0,0,${depth * 0.6})`}
          />
          {/* 目のハイライト */}
          <circle
            cx={detail.eyeX - 0.4}
            cy={detail.eyeY - 0.5}
            r={0.4}
            fill={`rgba(255,255,255,${depth * 0.4})`}
          />
        </>
      )}

      {/* 手前の魚のハイライト縁 */}
      {catchable && depth > 0.7 && (
        <path
          d={detail.body}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={0.6}
        />
      )}
    </g>
  );
}
