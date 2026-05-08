/**
 * PlayProposalCard
 *
 * Stage 1 → Stage 2 之間的確認卡。
 * 顯示 mechanicProposer 回傳的提案，讓照護師三選一：
 *   ✅ 確定生成 → 進入 Stage 2 (generateGame with confirmedMechanic)
 *   🔄 重新提案 → 用同一段描述再叫一次 proposeMechanic
 *   ✏️  改描述   → 回到輸入框並保留原本文字
 */

import React, { useState, useEffect } from "react";
import { CheckCircle2, RefreshCw, Pencil, Users, Sparkles, AlertTriangle, Target, Clock, Minus, Plus } from "lucide-react";
import type { MechanicProposal } from "../services/mechanicProposer";

interface PlayProposalCardProps {
  proposal: MechanicProposal;
  /** 是否正在重新提案或生成中（按鈕全部 disabled）。 */
  busy?: boolean;
  onConfirm: (proposal: MechanicProposal) => void;
  onRegenerate: () => void;
  onEdit: () => void;
}

const DURATION_MIN = 30;
const DURATION_MAX = 600;
const DURATION_STEP = 30;
const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} 秒`;
  if (s === 0) return `${m} 分鐘`;
  return `${m} 分 ${s} 秒`;
};

const confidenceTone: Record<MechanicProposal["confidence"], { label: string; className: string }> = {
  high:   { label: "高",   className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  medium: { label: "中",   className: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  low:    { label: "低",   className: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
};

const PlayProposalCard: React.FC<PlayProposalCardProps> = ({
  proposal,
  busy = false,
  onConfirm,
  onRegenerate,
  onEdit,
}) => {
  const tone = confidenceTone[proposal.confidence];

  // 照護師可在卡片內微調時長,確認時把調整後的值帶回 onConfirm。
  const [duration, setDuration] = useState(proposal.recommended_duration_seconds);
  useEffect(() => {
    setDuration(proposal.recommended_duration_seconds);
  }, [proposal]);

  const adjustDuration = (delta: number) => {
    setDuration((prev) =>
      Math.max(DURATION_MIN, Math.min(DURATION_MAX, prev + delta)),
    );
  };

  const handleConfirm = () => {
    onConfirm({ ...proposal, recommended_duration_seconds: duration });
  };

  return (
    <div className="fixed inset-0 bg-amber-950/95 backdrop-blur-2xl z-[250] flex items-center justify-center p-4 animate-in fade-in zoom-in duration-300">
      <div className="w-full max-w-2xl bg-amber-900 border border-emerald-500/30 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-900/40 via-amber-900 to-cyan-900/40 p-8 border-b border-emerald-500/10">
          <div className="flex items-center gap-4 mb-2">
            <div className="p-3 bg-emerald-500/20 rounded-2xl">
              <Sparkles className="w-8 h-8 text-emerald-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-3xl font-black text-white tracking-tight">我幫你規劃了這個玩法</h2>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-emerald-500 text-[10px] font-bold uppercase tracking-widest">
                  Mechanic Match · 待你確認
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">

          {/* Title row */}
          <section className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-2xl font-bold text-white leading-tight flex-1">
                {proposal.proposed_title}
              </h3>
              <span
                className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold border ${tone.className}`}
                title="AI 對這個匹配的信心程度"
              >
                信心 · {tone.label}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-amber-300">
              <Target className="w-4 h-4 text-cyan-400" />
              <span className="font-mono text-xs uppercase tracking-wider">{proposal.matched_mechanic_id}</span>
              <span className="text-amber-500">·</span>
              <span>{proposal.matched_mechanic_name}</span>
            </div>
          </section>

          {/* Summary */}
          <section className="bg-amber-950/40 border border-amber-700/30 rounded-2xl p-5">
            <p className="text-amber-100 text-base leading-relaxed">
              {proposal.proposed_summary}
            </p>
          </section>

          {/* Player count */}
          <section className="flex items-start gap-3">
            <div className="p-2 bg-cyan-500/20 rounded-xl shrink-0">
              <Users className="w-5 h-5 text-cyan-300" />
            </div>
            <div className="flex-1">
              <div className="text-white font-bold text-lg">
                {proposal.player_count} 人
              </div>
              <div className="text-amber-300 text-sm mt-0.5">
                {proposal.player_count_reasoning}
              </div>
            </div>
          </section>

          {/* Duration (可調整) */}
          <section className="flex items-start gap-3">
            <div className="p-2 bg-emerald-500/20 rounded-xl shrink-0">
              <Clock className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => adjustDuration(-DURATION_STEP)}
                  disabled={busy || duration <= DURATION_MIN}
                  className="w-8 h-8 flex items-center justify-center bg-amber-800 hover:bg-amber-700 disabled:bg-amber-900/40 disabled:cursor-not-allowed text-amber-100 rounded-lg transition-all border border-amber-700/40"
                  aria-label="減少時長"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <div className="text-white font-bold text-lg min-w-[6rem] text-center tabular-nums">
                  {formatDuration(duration)}
                </div>
                <button
                  type="button"
                  onClick={() => adjustDuration(DURATION_STEP)}
                  disabled={busy || duration >= DURATION_MAX}
                  className="w-8 h-8 flex items-center justify-center bg-amber-800 hover:bg-amber-700 disabled:bg-amber-900/40 disabled:cursor-not-allowed text-amber-100 rounded-lg transition-all border border-amber-700/40"
                  aria-label="增加時長"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="text-amber-300 text-sm mt-1">
                時間到自動結束(競速類仍可提前由勝負觸發)
              </div>
            </div>
          </section>

          {/* Caveats (only if any) */}
          {proposal.caveats.length > 0 && (
            <section className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-amber-300 font-bold text-sm uppercase tracking-wider">注意事項</span>
              </div>
              <ul className="space-y-2">
                {proposal.caveats.map((caveat, idx) => (
                  <li key={idx} className="text-amber-100 text-sm leading-relaxed flex gap-2">
                    <span className="text-amber-500 shrink-0">•</span>
                    <span>{caveat}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-amber-700/30 p-6 bg-amber-950/40 space-y-3">
          {/* Primary action */}
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-amber-700 disabled:cursor-not-allowed text-amber-950 font-black text-lg rounded-2xl transition-all shadow-lg shadow-emerald-500/30 disabled:shadow-none"
          >
            <CheckCircle2 className="w-5 h-5" />
            {busy ? "處理中…" : "確定，生成這個遊戲"}
          </button>

          {/* Secondary actions */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onRegenerate}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-amber-800 hover:bg-amber-700 disabled:bg-amber-900/40 disabled:cursor-not-allowed text-amber-100 font-bold rounded-2xl transition-all border border-amber-700/40"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
              重新提案
            </button>
            <button
              onClick={onEdit}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-amber-800 hover:bg-amber-700 disabled:bg-amber-900/40 disabled:cursor-not-allowed text-amber-100 font-bold rounded-2xl transition-all border border-amber-700/40"
            >
              <Pencil className="w-4 h-4" />
              改一下描述
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlayProposalCard;
