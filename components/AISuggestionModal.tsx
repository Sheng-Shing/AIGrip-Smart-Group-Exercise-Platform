import React from 'react';
import { BrainCircuit, Activity, Heart, TrendingUp, Sliders, Play, X, ShieldCheck, Zap } from 'lucide-react';
import { PatientSuggestion } from '../services/geminiService';

interface AISuggestionModalProps {
    suggestion: PatientSuggestion;
    patientName: string;
    onAccept: (suggestion: PatientSuggestion) => void;
    onClose: () => void;
}

const AISuggestionModal: React.FC<AISuggestionModalProps> = ({
    suggestion,
    patientName,
    onAccept,
    onClose
}) => {
    const { analysis, clinical_advice, recommended_config } = suggestion;

    return (
        <div className="fixed inset-0 bg-amber-950/95 backdrop-blur-2xl z-[300] flex items-center justify-center p-4 animate-in fade-in zoom-in duration-500">
            <div className="w-full max-w-2xl bg-amber-900 border border-emerald-500/30 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="bg-gradient-to-r from-emerald-900/40 via-amber-900 to-cyan-900/40 p-8 border-b border-emerald-500/10 relative">
                    <div className="flex items-center gap-4 mb-2">
                        <div className="p-3 bg-emerald-500/20 rounded-2xl animate-pulse">
                            <BrainCircuit className="w-8 h-8 text-emerald-400" />
                        </div>
                        <div>
                            <h2 className="text-3xl font-black text-white tracking-tight">AI 智能團康建議系統</h2>
                            <div className="flex items-center gap-2 mt-1">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                                <span className="text-emerald-500 text-[10px] font-bold uppercase tracking-widest">Data-Driven Activity Reasoning Active</span>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="absolute right-6 top-6 w-10 h-10 bg-white/5 hover:bg-white/10 rounded-full flex items-center justify-center text-amber-500 transition-all border border-white/5"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                    {/* Section 1: Data Retrieval & Analysis */}
                    <section className="space-y-4">
                        <div className="flex items-center gap-2 text-amber-400">
                            <TrendingUp className="w-4 h-4 text-cyan-400" />
                            <h3 className="text-sm font-bold uppercase tracking-widest">1. 歷史數據檢索與活動分析 (Analysis)</h3>
                        </div>
                        <div className="bg-amber-950/50 rounded-2xl p-6 border border-amber-800 leading-relaxed">
                            <p className="text-amber-300 text-sm italic">{analysis}</p>
                        </div>
                    </section>

                    {/* Section 2: Activity Advice */}
                    <section className="space-y-4">
                        <div className="flex items-center gap-2 text-amber-400">
                            <Heart className="w-4 h-4 text-rose-400" />
                            <h3 className="text-sm font-bold uppercase tracking-widest">2. 智能活動建議 (Activity Advice)</h3>
                        </div>
                        <div className="bg-emerald-500/10 rounded-2xl p-6 border border-emerald-500/20 relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-4 opacity-5">
                                <ShieldCheck className="w-24 h-24 text-emerald-400" />
                            </div>
                            <p className="text-emerald-50 text-xl font-bold leading-relaxed relative z-10">
                                「{clinical_advice}」
                            </p>
                        </div>
                    </section>

                    {/* Section 3: Optimization Suggestion */}
                    <section className="space-y-4">
                        <div className="flex items-center gap-2 text-amber-400">
                            <Sliders className="w-4 h-4 text-amber-400" />
                            <h3 className="text-sm font-bold uppercase tracking-widest">3. 參數自動優化 (Auto-Optimization)</h3>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-amber-950/50 rounded-xl p-4 border border-amber-800">
                                <span className="text-[10px] font-bold text-amber-500 uppercase block mb-1">建議遊戲名稱</span>
                                <span className="text-white font-bold">{recommended_config.game_topic}</span>
                            </div>
                            <div className="bg-amber-950/50 rounded-xl p-4 border border-amber-800">
                                <span className="text-[10px] font-bold text-amber-500 uppercase block mb-1">訓練模式</span>
                                <span className="text-cyan-400 font-bold">{recommended_config.mode}</span>
                            </div>
                            <div className="bg-emerald-500/5 rounded-xl p-4 border border-emerald-500/10">
                                <span className="text-[10px] font-bold text-emerald-500/50 uppercase block mb-1">優化目標區間</span>
                                <span className="text-emerald-400 font-bold text-lg">
                                    {Math.round(recommended_config.target_range[0] * 100)}% - {Math.round(recommended_config.target_range[1] * 100)}%
                                </span>
                            </div>
                            <div className="bg-amber-500/5 rounded-xl p-4 border border-amber-500/10">
                                <span className="text-[10px] font-bold text-amber-500/50 uppercase block mb-1">優化維持時間</span>
                                <div className="flex items-end gap-1">
                                    <span className="text-amber-400 font-black text-2xl">{recommended_config.hold_time}</span>
                                    <span className="text-amber-400/50 text-xs font-bold mb-1">秒</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 bg-blue-500/10 p-4 rounded-xl border border-blue-500/20">
                            <Zap className="w-4 h-4 text-blue-400" />
                            <span className="text-blue-200 text-xs font-medium">總建議時長：{recommended_config.total_duration} 秒</span>
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <div className="p-8 bg-amber-950/50 border-t border-amber-800">
                    <button
                        onClick={() => onAccept(suggestion)}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-5 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl shadow-emerald-500/20 text-lg uppercase tracking-widest"
                    >
                        <Play className="w-6 h-6" />
                        採用並生成今日推薦團康
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AISuggestionModal;
