"use client";

import { useEffect, useState } from "react";

interface ParallaxLayersProps {
  width: number;
  height: number;
}

// 各レイヤーの配置要素
interface PlacedAsset {
  src: string;
  x: number;       // % 基準の位置
  bottom: number;   // 下端からの位置(%)
  width: number;    // 表示幅(px)
  flipX?: boolean;
  depth: number;    // 0(奥)~1(手前): blur, opacity, scaleに影響
}

// 奥行きレイヤー別の配置定義
const LAYER_ASSETS: PlacedAsset[] = [
  // === 奥レイヤー (depth 0.1~0.3): ぼんやり小さく ===
  { src: "/assets/rock-small.png", x: 8, bottom: 2, width: 30, depth: 0.15 },
  { src: "/assets/coral-pink.png", x: 22, bottom: 1, width: 25, depth: 0.2 },
  { src: "/assets/seaweed-green.png", x: 40, bottom: 0, width: 20, depth: 0.15 },
  { src: "/assets/rock-small.png", x: 60, bottom: 3, width: 25, depth: 0.25, flipX: true },
  { src: "/assets/seaweed-yellow.png", x: 75, bottom: 1, width: 22, depth: 0.2 },
  { src: "/assets/coral-pink.png", x: 90, bottom: 2, width: 20, depth: 0.18 },

  // === 中景レイヤー (depth 0.4~0.6): やや見える ===
  { src: "/assets/stone-pillar.png", x: 5, bottom: 0, width: 70, depth: 0.45 },
  { src: "/assets/seaweed-green.png", x: 30, bottom: 0, width: 35, depth: 0.5 },
  { src: "/assets/coral-pink.png", x: 48, bottom: 2, width: 40, depth: 0.55 },
  { src: "/assets/seaweed-yellow.png", x: 55, bottom: 0, width: 40, depth: 0.45 },
  { src: "/assets/coral-arch-1.png", x: 72, bottom: 0, width: 110, depth: 0.5 },
  { src: "/assets/rock-small.png", x: 92, bottom: 0, width: 40, depth: 0.5, flipX: true },

  // === 手前レイヤー (depth 0.75~1.0): くっきり大きく ===
  { src: "/assets/stone-pillar-vine.png", x: -2, bottom: -2, width: 120, depth: 0.85 },
  { src: "/assets/seaweed-green.png", x: 18, bottom: 0, width: 50, depth: 0.8 },
  { src: "/assets/coral-arch-2.png", x: 35, bottom: -1, width: 160, depth: 0.9 },
  { src: "/assets/seaweed-yellow.png", x: 62, bottom: 0, width: 55, depth: 0.75 },
  { src: "/assets/coral-pink.png", x: 70, bottom: 3, width: 50, depth: 0.8 },
  { src: "/assets/rock-arch.png", x: 80, bottom: -2, width: 200, depth: 0.95 },
];

export default function ParallaxLayers({ width, height }: ParallaxLayersProps) {
  const [time, setTime] = useState(0);

  // 海藻の揺れアニメーション
  useEffect(() => {
    let frame: number;
    const animate = () => {
      setTime(Date.now() / 1000);
      frame = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(frame);
  }, []);

  if (width === 0 || height === 0) return null;

  // depth順にソート（奥から描画）
  const sorted = [...LAYER_ASSETS].sort((a, b) => a.depth - b.depth);

  return (
    <>
      {/* タイリング背景: コースティクス（光模様） */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "url(/assets/bg-caustics.png)",
          backgroundSize: "288px 256px",
          backgroundRepeat: "repeat",
          opacity: 0.15,
          mixBlendMode: "screen",
        }}
      />

      {/* 中景リーフ（海底の大きな岩場） */}
      <div
        className="absolute pointer-events-none"
        style={{
          bottom: 0,
          left: 0,
          right: 0,
          height: "45%",
          backgroundImage: "url(/assets/midground-reef.png)",
          backgroundSize: "cover",
          backgroundPosition: "bottom center",
          backgroundRepeat: "repeat-x",
          opacity: 0.2,
          filter: "blur(2px) brightness(0.6)",
        }}
      />

      {/* 個別アセット配置 */}
      {sorted.map((asset, i) => {
        const blur = (1 - asset.depth) * 4;
        const opacity = 0.15 + asset.depth * 0.7;
        const scale = 0.4 + asset.depth * 0.6;
        const actualWidth = asset.width * scale;

        // 海藻系の揺れ
        const isSeaweed = asset.src.includes("seaweed");
        const swayAngle = isSeaweed
          ? Math.sin(time * 0.8 + i * 1.7) * (3 - asset.depth * 2)
          : 0;

        // サンゴの微揺れ
        const isCoral = asset.src.includes("coral");
        const coralSway = isCoral
          ? Math.sin(time * 0.4 + i * 2.3) * 1
          : 0;

        return (
          <div
            key={`${asset.src}-${i}`}
            className="absolute pointer-events-none"
            style={{
              left: `${asset.x}%`,
              bottom: `${asset.bottom}%`,
              width: actualWidth,
              filter: `blur(${blur}px) brightness(${0.5 + asset.depth * 0.5})`,
              opacity,
              transform: [
                asset.flipX ? "scaleX(-1)" : "",
                `rotate(${swayAngle + coralSway}deg)`,
              ].join(" "),
              transformOrigin: "bottom center",
              transition: "transform 0.1s linear",
              zIndex: Math.round(asset.depth * 10),
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.src}
              alt=""
              className="w-full h-auto"
              draggable={false}
            />
          </div>
        );
      })}

      {/* 海底の地面（手前） */}
      <div
        className="absolute pointer-events-none"
        style={{
          bottom: 0,
          left: 0,
          right: 0,
          height: "14%",
          backgroundImage: "url(/assets/ground-top.png)",
          backgroundSize: "480px 100%",
          backgroundRepeat: "repeat-x",
          backgroundPosition: "bottom",
          opacity: 0.7,
          zIndex: 11,
        }}
      />
    </>
  );
}
