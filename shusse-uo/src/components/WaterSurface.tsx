"use client";

import { useEffect, useRef } from "react";

interface WaterSurfaceProps {
  width: number;
  height: number;
  ripples: { x: number; y: number; time: number }[];
}

interface Particle {
  x: number;
  y: number;
  size: number;
  speed: number;
  drift: number;
  depth: number;
  phase: number;
}

function createParticles(width: number, height: number, count: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 1 + Math.random() * 2,
      speed: 0.15 + Math.random() * 0.4,
      drift: (Math.random() - 0.5) * 0.3,
      depth: Math.random(),
      phase: Math.random() * Math.PI * 2,
    });
  }
  return particles;
}

// 光のカーテン描画（動的エフェクト）
function drawLightCurtains(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number
) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < 6; i++) {
    const baseX = width * (0.1 + i * 0.16);
    const sway = Math.sin(time * 0.25 + i * 1.1) * 40
      + Math.sin(time * 0.15 + i * 2.3) * 20;
    const topX = baseX + sway;
    const curtainWidth = 45 + Math.sin(time * 0.2 + i * 1.7) * 18;
    const intensity = 0.5 + Math.sin(time * 0.35 + i * 0.9) * 0.3
      + Math.sin(time * 0.6 + i * 2.1) * 0.2;
    const alpha = 0.03 * Math.max(0.2, intensity);
    const bottomSpread = curtainWidth * 2.2;
    const reach = height * (0.75 + Math.sin(time * 0.18 + i * 1.4) * 0.12);

    const lightGrad = ctx.createLinearGradient(topX, 0, topX, reach);
    lightGrad.addColorStop(0, `rgba(180, 235, 255, ${alpha * 3})`);
    lightGrad.addColorStop(0.15, `rgba(150, 225, 255, ${alpha * 2.2})`);
    lightGrad.addColorStop(0.4, `rgba(120, 210, 250, ${alpha * 1.2})`);
    lightGrad.addColorStop(0.7, `rgba(80, 180, 230, ${alpha * 0.5})`);
    lightGrad.addColorStop(1, "rgba(50, 150, 200, 0)");

    ctx.beginPath();
    ctx.moveTo(topX - curtainWidth * 0.3, 0);
    ctx.bezierCurveTo(
      topX - curtainWidth * 0.2 + sway * 0.2, reach * 0.3,
      topX - bottomSpread * 0.4 + sway * 0.3, reach * 0.6,
      topX - bottomSpread * 0.5 + sway * 0.4, reach
    );
    ctx.lineTo(topX + bottomSpread * 0.5 + sway * 0.4, reach);
    ctx.bezierCurveTo(
      topX + bottomSpread * 0.4 + sway * 0.3, reach * 0.6,
      topX + curtainWidth * 0.5 + sway * 0.2, reach * 0.3,
      topX + curtainWidth * 0.7, 0
    );
    ctx.closePath();
    ctx.fillStyle = lightGrad;
    ctx.fill();

    // 光芯
    if (intensity > 0.5) {
      const coreAlpha = alpha * 0.5;
      const coreGrad = ctx.createLinearGradient(topX, 0, topX, reach * 0.55);
      coreGrad.addColorStop(0, `rgba(220, 245, 255, ${coreAlpha * 2})`);
      coreGrad.addColorStop(0.5, `rgba(180, 230, 255, ${coreAlpha})`);
      coreGrad.addColorStop(1, "rgba(150, 220, 250, 0)");
      ctx.beginPath();
      ctx.moveTo(topX - curtainWidth * 0.08, 0);
      ctx.bezierCurveTo(
        topX, reach * 0.2,
        topX + sway * 0.1, reach * 0.35,
        topX + sway * 0.15, reach * 0.55
      );
      ctx.bezierCurveTo(
        topX + sway * 0.1, reach * 0.35,
        topX, reach * 0.2,
        topX + curtainWidth * 0.15, 0
      );
      ctx.closePath();
      ctx.fillStyle = coreGrad;
      ctx.fill();
    }
  }

  ctx.restore();
}

export default function WaterSurface({ width, height, ripples }: WaterSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    if (width > 0 && height > 0) {
      particlesRef.current = createParticles(width, height, 45);
    }
  }, [width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animFrame: number;

    function draw() {
      if (!ctx) return;
      const now = Date.now();
      const time = now / 1000;

      // --- 水面グラデーション ---
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, "#2a8faa");
      grad.addColorStop(0.06, "#1d7f9a");
      grad.addColorStop(0.2, "#10627e");
      grad.addColorStop(0.45, "#0a4d65");
      grad.addColorStop(0.7, "#06384d");
      grad.addColorStop(1, "#031e2e");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // --- 光のカーテン ---
      drawLightCurtains(ctx, width, height, time);

      // --- 浮遊パーティクル ---
      const particles = particlesRef.current;
      for (const p of particles) {
        p.y -= p.speed;
        p.x += Math.sin(time * 0.8 + p.phase) * p.drift;
        if (p.y < -10) { p.y = height + 10; p.x = Math.random() * width; }
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;

        const depthScale = 0.3 + p.depth * 0.7;
        const drawSize = p.size * depthScale;
        const depthAlpha = 0.06 + p.depth * 0.18;
        const yRatio = p.y / height;
        const brightness = Math.max(0, 1 - yRatio * 0.6);

        ctx.beginPath();
        ctx.arc(p.x, p.y, drawSize, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${Math.round(180 * brightness)}, ${Math.round(230 * brightness)}, 255, ${depthAlpha})`;
        ctx.fill();
      }

      // --- 水面のきらめき ---
      for (let i = 0; i < 14; i++) {
        const sx = ((Math.sin(time * 0.5 + i * 1.3) + 1) / 2) * width;
        const sy = ((Math.cos(time * 0.3 + i * 0.9) + 1) / 2) * height * 0.12;
        const sparkleAlpha = (Math.sin(time * 2.5 + i) + 1) / 2 * 0.45;
        const sparkleSize = 1.5 + Math.sin(time * 1.5 + i * 0.7) * 1;
        ctx.beginPath();
        ctx.arc(sx, sy, sparkleSize, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${sparkleAlpha})`;
        ctx.fill();
      }

      // --- 水面の波ライン ---
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let x = 0; x <= width; x += 4) {
        const waveY = 3 + Math.sin(x * 0.02 + time * 1.5) * 2.5
          + Math.sin(x * 0.035 + time * 0.8) * 1.5;
        ctx.lineTo(x, waveY);
      }
      ctx.lineTo(width, 0);
      ctx.closePath();
      const waveGrad = ctx.createLinearGradient(0, 0, 0, 10);
      waveGrad.addColorStop(0, "rgba(180, 230, 255, 0.25)");
      waveGrad.addColorStop(1, "rgba(140, 210, 250, 0)");
      ctx.fillStyle = waveGrad;
      ctx.fill();
      ctx.restore();

      // --- 波紋 ---
      for (const ripple of ripples) {
        const age = (now - ripple.time) / 1000;
        if (age > 2) continue;
        const radius = age * 60;
        const alpha = Math.max(0, 1 - age / 2);
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.3})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (radius > 15) {
          ctx.beginPath();
          ctx.arc(ripple.x, ripple.y, radius - 15, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.15})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      animFrame = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(animFrame);
  }, [width, height, ripples]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="absolute inset-0"
      style={{ zIndex: 0 }}
    />
  );
}
