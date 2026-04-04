"use client";

import { useState } from "react";
import { Fish } from "lucide-react";

interface LoginScreenProps {
  onLogin: (name: string) => void;
  hasSave: boolean;
  savedName?: string;
}

export default function LoginScreen({ onLogin, hasSave, savedName }: LoginScreenProps) {
  const [name, setName] = useState(savedName ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onLogin(trimmed);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-sky-400 to-blue-900 text-white px-4">
      <div className="text-center w-full max-w-sm">
        <Fish className="w-12 h-12 mx-auto mb-3 text-blue-200" />
        <h1 className="text-3xl font-bold mb-1">Angler & Artisan</h1>
        <p className="text-blue-200 text-sm mb-8">釣り師と寿司職人</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-blue-200 mb-1 text-left">
              プレイヤー名
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="名前を入力..."
              className="w-full px-4 py-3 rounded-lg bg-white/15 backdrop-blur border border-white/30 text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-orange-400 text-lg"
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={name.trim().length === 0}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-full text-lg shadow-lg transition-all hover:scale-105 active:scale-95"
          >
            {hasSave ? "続きから始める" : "はじめる"}
          </button>
        </form>

        {hasSave && (
          <p className="text-blue-300 text-xs mt-3">
            セーブデータが見つかりました
          </p>
        )}
      </div>
    </div>
  );
}
