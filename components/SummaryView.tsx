import React, { useMemo, useState } from 'react';
import { SessionMetrics, SavedPrescription, GameConfig, Patient } from '../types';
import { CheckCircle2, Save, RotateCcw, Activity, ShieldCheck, Clock, Zap, User, UserPlus, Users } from 'lucide-react';

interface SummaryViewProps {
    metrics: SessionMetrics;
    config: GameConfig;
    onSave: (patientName: string) => void;
    onRetry: () => void;
    onClose: () => void;
    isHistorical?: boolean;
    existingPatients?: string[];
    initialPatientName?: string;
    patients?: Patient[];
    selectedPatientId?: string;
}

const SummaryView: React.FC<SummaryViewProps> = ({
    metrics,
    config,
    onSave,
    onRetry,
    onClose,
    isHistorical = false,
    existingPatients = [],
    initialPatientName = '',
    patients = [],
    selectedPatientId
}) => {
    const { effectiveSeconds, totalSeconds, avgPressureL = 0, avgPressureR = 0, compensationOccurred = false } = metrics;
    const [patientName, setPatientName] = useState(initialPatientName);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

    const achievementRate = Math.round((effectiveSeconds / totalSeconds) * 100);

    // Calculate a "Rehab Score" based on achievement and stability
    const rehabScore = useMemo(() => {
        let score = achievementRate;
        if (!compensationOccurred) score += 10;
        // Normalize to 0-100
        return Math.min(100, score);
    }, [achievementRate, compensationOccurred]);

    const handleSave = () => {
        if (!patientName.trim()) {
            alert('請輸入參加者姓名');
            return;
        }
        setSaveStatus('saving');
        onSave(patientName);
        setTimeout(() => {
            setSaveStatus('saved');
        }, 600);
    };

    const StarRating = () => {
        const stars = rehabScore >= 90 ? 3 : rehabScore >= 60 ? 2 : 1;
        const labels = rehabScore >= 90 ? '完美康復' : rehabScore >= 60 ? '穩定進步' : '加油訓練';

        return (
            <div className="flex flex-col items-center gap-2">
                <div className="flex gap-2">
                    {[1, 2, 3].map((s) => (
                        <div key={s} className={`text-3xl transition-all ${s <= stars ? 'scale-110 text-yellow-400' : 'grayscale opacity-20 scale-90 text-amber-600'}`}>
                            ⭐
                        </div>
                    ))}
                </div>
                <span className="text-amber-400 text-xs font-bold uppercase tracking-widest">{labels}</span>
            </div>
        );
    };

    const ForceRing = ({ value, label, color }: { value: number; label: string; color: string }) => {
        const radius = 40;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (value * circumference);

        return (
            <div className="flex flex-col items-center">
                <div className="relative w-32 h-32 flex items-center justify-center">
                    <svg className="w-full h-full transform -rotate-90">
                        <circle
                            cx="64"
                            cy="64"
                            r={radius}
                            stroke="currentColor"
                            strokeWidth="8"
                            fill="transparent"
                            className="text-amber-800"
                        />
                        <circle
                            cx="64"
                            cy="64"
                            r={radius}
                            stroke={color}
                            strokeWidth="8"
                            fill="transparent"
                            strokeDasharray={circumference}
                            strokeDashoffset={offset}
                            strokeLinecap="round"
                            className="transition-all duration-1000 ease-out"
                        />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-xl font-black text-white">{Math.round(value * 100)}%</span>
                    </div>
                </div>
                <span className="text-amber-500 text-xs font-bold mt-2">{label}</span>
            </div>
        );
    };

    return (
        <div className="fixed inset-0 bg-amber-950/90 backdrop-blur-2xl z-[200] flex items-center justify-center p-4 animate-in fade-in zoom-in duration-300">
            <div className="w-full max-w-2xl bg-amber-900 border border-emerald-500/20 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="bg-gradient-to-r from-emerald-900/40 to-cyan-900/40 p-10 text-center relative">
                    <button
                        onClick={onClose}
                        className="absolute right-8 top-8 w-12 h-12 bg-amber-950/40 hover:bg-amber-950/60 text-white rounded-full flex items-center justify-center transition-colors border border-white/10"
                    >
                        ✕
                    </button>

                    <div className="mb-4 inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-4 py-1.5 rounded-full">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-400 text-xs font-bold tracking-tighter uppercase font-mono">Anti-Compensation Validated</span>
                    </div>

                    <h2 className="text-4xl font-black text-white mb-2 tracking-tight">
                        {isHistorical ? '歷史康復報告' : '本次訓練分析報告'}
                    </h2>
                    {config?.logic?.mode === 'STABLE_HOLD' && !isHistorical && (
                        <p className="text-emerald-400 font-bold mb-4 animate-bounce">
                            恭喜完成降壓訓練，血管內皮細胞已成功活化！
                        </p>
                    )}
                    <StarRating />
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto px-10 pb-10 space-y-8">
                    {/* Patient Input Area */}
                    {!isHistorical && (
                        <div className="bg-amber-950/50 rounded-3xl p-8 border border-amber-800 space-y-4">
                            <label className="text-sm font-bold text-amber-400 flex items-center gap-2 uppercase tracking-widest mb-2">
                                <User className="w-4 h-4 text-emerald-400" />
                                參加者個人康復檔案
                            </label>

                            <div className="relative group">
                                <input
                                    type="text"
                                    value={patientName}
                                    onChange={(e) => setPatientName(e.target.value)}
                                    placeholder="請輸入參加者姓名 (例如: 王小明)"
                                    className="w-full bg-amber-900 border-2 border-amber-800 focus:border-emerald-500/50 rounded-2xl px-6 py-4 text-white font-bold outline-none transition-all placeholder:text-amber-600"
                                    list="existing-patients"
                                />
                                <datalist id="existing-patients">
                                    {existingPatients.map(name => <option key={name} value={name} />)}
                                </datalist>
                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-700 group-focus-within:text-emerald-500/50">
                                    <UserPlus className="w-5 h-5" />
                                </div>
                            </div>

                            {patients.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-2">
                                    <span className="text-[10px] font-bold text-amber-600 uppercase w-full mb-1">快速從管理列表選擇</span>
                                    {patients.map(p => (
                                        <button
                                            key={p.id}
                                            onClick={() => setPatientName(p.name)}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${patientName === p.name
                                                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                                                : 'bg-amber-800 border-amber-700 text-amber-400 hover:border-amber-500'
                                                }`}
                                        >
                                            {p.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Dual Track Analytics */}
                    <div className="bg-amber-950/50 rounded-3xl p-8 border border-amber-800">
                        <div className="flex items-center justify-between mb-8">
                            <h3 className="text-sm font-bold text-amber-400 flex items-center gap-2 uppercase tracking-widest">
                                <Activity className="w-4 h-4 text-cyan-400" />
                                雙軌數據分析
                            </h3>
                            {!compensationOccurred && (
                                <div className="flex items-center gap-1.5 text-emerald-400 bg-emerald-400/10 px-3 py-1 rounded-lg border border-emerald-400/20">
                                    <CheckCircle2 className="w-4 h-4" />
                                    <span className="text-[10px] font-black uppercase">抗代償校驗通過</span>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-8 items-center justify-items-center">
                            <ForceRing value={avgPressureL} label="左手平均力道" color="#34d399" />
                            <ForceRing value={avgPressureR} label="右手平均力道" color="#22d3ee" />
                        </div>
                    </div>

                    {/* Intensity Summary */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-amber-950/50 p-6 rounded-3xl border border-amber-800 flex flex-col items-center text-center">
                            <Clock className="w-5 h-5 text-amber-500 mb-3" />
                            <span className="text-[10px] font-bold text-amber-500 uppercase mb-1">總計時長</span>
                            <span className="text-2xl font-black text-white">{totalSeconds}s</span>
                        </div>
                        <div className="bg-emerald-500/5 p-6 rounded-3xl border border-emerald-500/10 flex flex-col items-center text-center">
                            <Zap className="w-5 h-5 text-emerald-400 mb-3" />
                            <span className="text-[10px] font-bold text-emerald-500 uppercase mb-1">有效訓練</span>
                            <span className="text-2xl font-black text-emerald-400">{Math.round(effectiveSeconds)}s</span>
                        </div>
                        <div className="bg-amber-500/5 p-6 rounded-3xl border border-amber-500/10 flex flex-col items-center text-center">
                            <Activity className="w-5 h-5 text-amber-400 mb-3" />
                            <span className="text-[10px] font-bold text-amber-500 uppercase mb-1">峰值壓力</span>
                            <span className="text-2xl font-black text-amber-400">{Math.round((metrics.maxPressure || 0) * 100)}%</span>
                        </div>
                        <div className="bg-cyan-500/5 p-6 rounded-3xl border border-cyan-500/10 flex flex-col items-center text-center">
                            <Zap className="w-5 h-5 text-cyan-400 mb-3" />
                            <span className="text-[10px] font-bold text-cyan-500 uppercase mb-1">康復評分</span>
                            <span className="text-2xl font-black text-cyan-400">{rehabScore}</span>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col gap-3 pt-4">
                        {saveStatus === 'saved' ? (
                            <div className="w-full bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 font-black py-5 rounded-2xl flex items-center justify-center gap-3 animate-in zoom-in duration-300">
                                <CheckCircle2 className="w-5 h-5" />
                                數據已存入 [{patientName}] 的個人康復檔案
                            </div>
                        ) : (
                            <button
                                onClick={handleSave}
                                disabled={saveStatus === 'saving'}
                                className="w-full bg-emerald-500 hover:bg-emerald-400 text-amber-900 font-black py-5 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl shadow-emerald-500/10 uppercase tracking-widest text-sm disabled:opacity-50"
                            >
                                <Save className="w-5 h-5" />
                                {saveStatus === 'saving' ? '正在存檔...' : '確認儲存此團康與紀錄'}
                            </button>
                        )}

                        <button
                            onClick={onRetry}
                            className="w-full bg-amber-800 hover:bg-amber-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-3 transition-all uppercase tracking-widest text-xs"
                        >
                            <RotateCcw className="w-4 h-4" />
                            重新開始訓練
                        </button>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 text-center border-t border-amber-800 bg-amber-950/20">
                    <p className="text-amber-600 text-[10px] font-bold tracking-[0.2em] uppercase">
                        AIGrip 智癒球 - 您最精準的 AI 康復助理
                    </p>
                </div>
            </div>
        </div>
    );
};

export default SummaryView;
