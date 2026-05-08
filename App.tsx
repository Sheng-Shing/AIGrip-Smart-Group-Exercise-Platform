
import React, { useState, useCallback, useRef, useMemo } from 'react';
import { ClipboardList, History, Search, User, Calendar, Star, ShieldCheck, Zap, Activity, Download, Upload } from 'lucide-react';
import { generateGame, generatePatientSuggestion, PatientSuggestion } from './services/geminiService';
import { proposeMechanic, MechanicProposal } from './services/mechanicProposer';
import { generateImage } from './services/imageService';
import { GameConfig, PressureData, SavedPrescription, SessionMetrics, Patient } from './types';
import GameView from './components/GameView';
import SummaryView from './components/SummaryView';
import ErrorBoundary from './components/ErrorBoundary';
import PatientManagementModal from './components/PatientManagementModal';
import AISuggestionModal from './components/AISuggestionModal';
import PlayProposalCard from './components/PlayProposalCard';

const BLE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const BLE_CHARACTERISTIC_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

const GripTrendLine: React.FC<{ data: { timestamp: number, maxPressure: number }[] }> = ({ data }) => {
  if (data.length < 2) return null;

  const width = 600;
  const height = 150;
  const padding = 20;

  const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);
  const minTime = Math.min(...sortedData.map(d => d.timestamp));
  const maxTime = Math.max(...sortedData.map(d => d.timestamp));
  const timeRange = maxTime - minTime || 1;
  const maxP = Math.max(...sortedData.map(d => d.maxPressure), 0.1);

  const points = sortedData.map(d => ({
    x: padding + ((d.timestamp - minTime) / timeRange) * (width - 2 * padding),
    y: height - padding - (d.maxPressure / maxP) * (height - 2 * padding)
  }));

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  // Calculate slope (simple linear regression or just last vs first)
  // For simplicity and clinical relevance, we'll check the trend of the last 5 points
  const recent = sortedData.slice(-5);
  let slope = 0;
  if (recent.length >= 3) {
    const xSum = recent.reduce((sum, _, i) => sum + i, 0);
    const ySum = recent.reduce((sum, d) => sum + d.maxPressure, 0);
    const xySum = recent.reduce((sum, d, i) => sum + i * d.maxPressure, 0);
    const xxSum = recent.reduce((sum, _, i) => sum + i * i, 0);
    const n = recent.length;
    slope = (n * xySum - xSum * ySum) / (n * xxSum - xSum * xSum);
  }

  const isDeclining = slope < -0.05;

  return (
    <div className="bg-amber-950/50 p-6 rounded-3xl border border-amber-800 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          最大握力趨勢區分析 (Grip Trend)
        </h3>
        {isDeclining && (
          <div className="bg-amber-500/20 border border-amber-500/50 text-amber-500 px-3 py-1 rounded-lg text-[10px] font-bold animate-pulse">
            ⚠️ 近期握力數據異常，請注意健康管理或諮詢專業醫師。
          </div>
        )}
      </div>
      <div className="relative h-[150px] w-full">
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          {/* Paths and points */}
          <path d={pathD} fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="4" fill="#34d399" />
          ))}
          {/* Grid lines */}
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#333" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [bleStatuses, setBleStatuses] = useState<Record<string, 'connecting' | 'connected'>>({});
  const [pressures, setPressures] = useState<Record<string, PressureData>>({});
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [isGameActive, setIsGameActive] = useState(false);
  const [prompt, setPrompt] = useState('我想做一個訓練握力，以草莓為主題的趣味復健遊戲');
  const [savedPrompts, setSavedPrompts] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('holoball_prompts');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to parse saved prompts:", e);
      return [];
    }
  });
  const [savedPrescriptions, setSavedPrescriptions] = useState<SavedPrescription[]>(() => {
    try {
      const saved = localStorage.getItem('holoball_prescriptions');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to parse saved prescriptions:", e);
      return [];
    }
  });
  const [historyImages, setHistoryImages] = useState<string[]>([]);
  const [showSettlement, setShowSettlement] = useState(false);
  const [sessionMetrics, setSessionMetrics] = useState<SessionMetrics & { isHistorical?: boolean } | null>(null);
  const [showRehabLog, setShowRehabLog] = useState(false);
  const [patientName, setPatientName] = useState('');
  const [clinicalAdvice, setClinicalAdvice] = useState<string | null>(null);
  const [userHistory, setUserHistory] = useState<SavedPrescription[]>([]);
  const [patients, setPatients] = useState<Patient[]>(() => {
    try {
      const saved = localStorage.getItem('holoball_patients');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to parse patients:", e);
      return [];
    }
  });
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>(() => {
    return localStorage.getItem('holoball_selected_patient_id') || undefined;
  });
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<PatientSuggestion | null>(null);
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [generationPatientName, setGenerationPatientName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);
  const [proposal, setProposal] = useState<MechanicProposal | null>(null);
  const [proposing, setProposing] = useState(false);
  // 確認提案後的遊戲時長(秒);timer 到時 GameView 自動觸發 onSessionEnd。
  // null 代表沒有計時器(舊流程或未設定),GameView 內部會視為無限時長。
  const [sessionDurationSeconds, setSessionDurationSeconds] = useState<number | null>(null);

  const showToast = (message: string, type: 'success' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const selectedPatient = useMemo(() =>
    patients.find(p => p.id === selectedPatientId),
    [patients, selectedPatientId]
  );

  // Sync selected patient name to patientName state for auto-fill
  React.useEffect(() => {
    if (selectedPatient) {
      setPatientName(selectedPatient.name);
    }
  }, [selectedPatient]);

  const existingPatients = useMemo(() => {
    const names = savedPrescriptions
      .map(rx => rx.patientName)
      .filter((name): name is string => !!name);
    return Array.from(new Set(names));
  }, [savedPrescriptions]);

  // 更新歷史數據
  React.useEffect(() => {
    if (patientName.trim()) {
      const history = savedPrescriptions
        .filter(rx => rx.patientName === patientName.trim())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);
      setUserHistory(history);
    } else {
      setUserHistory([]);
    }
  }, [patientName, savedPrescriptions]);

  const handlePatientsUpdate = (newPatients: Patient[]) => {
    setPatients(newPatients);
    localStorage.setItem('holoball_patients', JSON.stringify(newPatients));
    // If selected patient was deleted, clear selection
    if (selectedPatientId && !newPatients.find(p => p.id === selectedPatientId)) {
      setSelectedPatientId(undefined);
      localStorage.removeItem('holoball_selected_patient_id');
      setPatientName('');
    }
  };

  const fetchHistoryImages = useCallback(async () => {
    try {
      const res = await fetch('/api/list-images');
      const data = await res.json();
      setHistoryImages(data);
    } catch (err) {
      console.error("Failed to fetch history images:", err);
    }
  }, []);

  React.useEffect(() => {
    fetchHistoryImages();
  }, [fetchHistoryImages]);



  const characteristicRefs = useRef<Record<string, any>>({});
  const deviceRefs = useRef<Record<string, any>>({});
  const leftCalibrateRefs = useRef<Record<string, number>>({});
  const rightCalibrateRefs = useRef<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const handleLocalImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const imageData = e.target?.result as string;
      if (config) {
        // 背景儲存到伺服器
        const filename = `uploaded_${Date.now()}_${file.name}`;
        try {
          const res = await fetch('/api/save-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageData, filename })
          });
          const data = await res.json();
          if (data.success) {
            // 使用伺服器回傳的路徑，不要用 Base64
            setConfig(prev => prev ? { ...prev, image_url: data.path } : null);
            fetchHistoryImages();
          }
        } catch (err) {
          console.error("Failed to save uploaded image:", err);
          // Fallback to base64 if server save fails, but warn user
          setConfig(prev => prev ? { ...prev, image_url: imageData } : null);
        }
      } else {
        alert('請先生成遊戲，再上傳對應的主題圖片。');
      }
    };
    reader.readAsDataURL(file);
    // 清除選取，以便下次可以上傳同一張圖
    event.target.value = '';
  };

  const handleSelectLibraryImage = (img: string, type: 'main' | 'bg') => {
    let newConfig = config;
    if (!newConfig) {
      newConfig = {
        metadata: {
          game_name: '新訓練任務',
          interaction_type: 'MIXED',
          prescription_summary: '手動配置的遊戲任務'
        },
        global_physics: {
          gravity_vector: [0, 1],
          world_friction: 0.1,
          reset_threshold: 0.05
        },
        entities: [
          {
            id: 'pawn_1',
            type: 'controllable_pawn',
            visual: {
              model_type: 'sprite',
              image_prompt: '',
              bg_image_prompt: '',
              alpha: 1.0,
              bg_alpha: 0.2
            },
            movement_logic: {
              atomic_action: 'DRIVE',
              axis: 'XY',
              multiplier: 1.0,
              clinical_tag: 'custom_training'
            }
          }
        ],
        collision_handlers: [],
        scoring_metrics: {
          win_condition: 'time_up',
          target_score: 100,
          data_logging: ['pressure']
        },
        clinical_advice: '請配合玩家能力調整',
        bg_image_url: '',
        image_url: ''
      };
    }

    if (type === 'main') {
      newConfig = { ...newConfig, image_url: img };
      showToast('✅ 已設定為物件圖片');
    } else {
      newConfig = { ...newConfig, bg_image_url: img };
      showToast('✅ 已設定為場景背景');
    }
    setConfig(newConfig);
    setShowSettlement(false);
    setShowPatientModal(false);
    setShowRehabLog(false);
    setSessionMetrics(null);
    setClinicalAdvice(null);
    setAiSuggestion(null);
  };

  const handleSavePrompt = () => {
    if (!prompt.trim()) return;
    if (savedPrompts.includes(prompt.trim())) return;
    const newPrompts = [prompt.trim(), ...savedPrompts];
    setSavedPrompts(newPrompts);
    try {
      localStorage.setItem('holoball_prompts', JSON.stringify(newPrompts));
    } catch (e) {
      console.error("Failed to save prompt to localStorage:", e);
      alert('儲存失敗：空間可能已滿');
    }
  };

  const handleDeletePrompt = (e: React.MouseEvent, p: string) => {
    e.stopPropagation();
    const newPrompts = savedPrompts.filter(item => item !== p);
    setSavedPrompts(newPrompts);
    try {
      localStorage.setItem('holoball_prompts', JSON.stringify(newPrompts));
    } catch (e) {
      console.error("Failed to delete prompt from localStorage:", e);
    }
  };

  const handleSavePrescription = (nameInput?: any) => {
    if (!config) return;

    // 優先使用傳入的姓名，若無則使用當前選取的玩家姓名
    const patientName = typeof nameInput === 'string' ? nameInput : selectedPatient?.name;
    const normalizedTargetName = patientName?.trim() || undefined;

    // 安全檢查：檢查 Assets 是否包含龐大的 Base64 字串
    const isBase64 = (str?: string) => str?.startsWith('data:image');
    if (isBase64(config.image_url) || isBase64(config.bg_image_url)) {
      if (!confirm('偵測到圖片數據尚未完成伺服器存檔（目前為 Base64 格式）。這會佔用極大的瀏覽器空間，可能導致未來無法儲存其他紀錄。確定要繼續儲存嗎？（建議稍等片刻待「生成遊戲」完成背景存檔）')) {
        return;
      }
    }

    // 深度正規化：遞迴將物件排序並對齊數值，忽略 null/undefined
    const normalize = (val: any): any => {
      if (Array.isArray(val)) return val.map(normalize);
      if (typeof val === 'object' && val !== null) {
        const sorted: any = {};
        Object.keys(val).sort().forEach(k => {
          const v = normalize(val[k]);
          if (v !== undefined && v !== null) {
            sorted[k] = v;
          }
        });
        return sorted;
      }
      if (typeof val === 'number') return Math.round(val * 10000) / 10000;
      return val;
    };

    const currentLogicNormalized = normalize({
      m: config.metadata,
      e: config.entities.map(e => ({ t: e.type, a: e.movement_logic.atomic_action }))
    });
    const currentLogicStr = JSON.stringify(currentLogicNormalized);
    const currentTrimmedGame = config.metadata.game_name?.trim();

    const shouldIncludeMetrics = !!normalizedTargetName;
    const targetMetrics = shouldIncludeMetrics ? sessionMetrics : undefined;

    // 先行檢查重複：僅針對「團康模板」（無 metrics 的項目）進行去重檢查
    // 康復日誌（含數據）理論上不應該因為參數相同就被攔截，因為每次訓練都是獨立紀錄
    if (!targetMetrics) {
      const isDuplicate = savedPrescriptions.some((rx) => {
        if (rx.metrics) return false; // 跳過日誌紀錄，只比對團康模板

        const normalizedRxName = rx.patientName?.trim() || undefined;
        const rxLogicNormalized = normalize({
          m: rx.config.metadata,
          e: rx.config.entities.map(e => ({ t: e.type, a: e.movement_logic.atomic_action }))
        });
        const rxLogicStr = JSON.stringify(rxLogicNormalized);

        const isSamePatient = normalizedRxName === normalizedTargetName;
        const isSameGame = rx.game_name?.trim() === currentTrimmedGame;
        const isSameLogic = rxLogicStr === currentLogicStr;

        return isSamePatient && isSameGame && isSameLogic;
      });

      if (isDuplicate) {
        alert('⚠️ 偵測到重複的團康模板。相同的參數設定已存在於列表中，無需重複儲存。');
        return;
      }
    }

    const newPrescription: SavedPrescription = {
      id: `rx_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: Date.now(),
      game_name: config.metadata.game_name,
      config: config,
      assets: {
        image_url: config.image_url,
        bg_image_url: config.bg_image_url,
      },
      raw_prompt: prompt,
      best_achievement_rate: targetMetrics ? Math.round((targetMetrics.effectiveSeconds / targetMetrics.totalSeconds) * 100) : undefined,
      patientName: normalizedTargetName,
      patientId: normalizedTargetName ? (patients.find(p => p.name === normalizedTargetName)?.id || selectedPatientId) : undefined,
      metrics: targetMetrics || undefined
    };

    const updatedPrescriptions = [newPrescription, ...savedPrescriptions];
    try {
      localStorage.setItem('holoball_prescriptions', JSON.stringify(updatedPrescriptions));
      setSavedPrescriptions(updatedPrescriptions);
      alert('✅ 團康儲存成功！');
    } catch (e: any) {
      console.error("Failed to save prescription to localStorage:", e);
      if (e.name === 'QuotaExceededError' || e.message?.includes('exceeded')) {
        alert('🚨 儲存空間已滿 (約 5MB)！請使用「清除歷史紀錄」以釋放空間，或避免儲存含有 Base64 數據的圖片。');
      } else {
        alert('儲存失敗：' + e.message);
      }
    }
  };

  const handleClearAllPrescriptions = () => {
    if (!confirm('此操作將永久刪除所有歷史團康模板，確定嗎？')) return;
    const updated = savedPrescriptions.filter(rx => !!rx.metrics);
    try {
      localStorage.setItem('holoball_prescriptions', JSON.stringify(updated));
      setSavedPrescriptions(updated);
      alert('已清除所有團康模板。');
    } catch (e) {
      console.error("Failed to clear prescriptions:", e);
    }
  };

  const handleClearAllLogs = () => {
    if (!confirm('此操作將永久刪除所有個人康復日誌，確定嗎？')) return;
    const updated = savedPrescriptions.filter(rx => !rx.metrics);
    try {
      localStorage.setItem('holoball_prescriptions', JSON.stringify(updated));
      setSavedPrescriptions(updated);
      alert('已清除所有康復日誌。');
    } catch (e) {
      console.error("Failed to clear logs:", e);
    }
  };

  const handleLoadPrescription = (rx: SavedPrescription) => {
    // 確保圖片與資源都帶入 config
    const loadedConfig = {
      ...rx.config,
      image_url: rx.assets.image_url,
      bg_image_url: rx.assets.bg_image_url
    };
    setConfig(loadedConfig);
    setPrompt(rx.raw_prompt);
    setIsGameActive(false);
    setSessionMetrics(null);
    setShowSettlement(false);
    setShowRehabLog(false);
    setAiSuggestion(null);
    // Don't clear clinicalAdvice here as it might be part of the prescription context
  };

  const handleDeletePrescription = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('確定要刪除此團康嗎？')) return;
    setSavedPrescriptions(prev => {
      const updated = prev.filter(rx => rx.id !== id);
      try {
        localStorage.setItem('holoball_prescriptions', JSON.stringify(updated));
      } catch (e) {
        console.error("Failed to delete prescription from localStorage:", e);
      }
      return updated;
    });
  };

  const handleExportData = () => {
    const backupData = {
      holoball_patients: localStorage.getItem('holoball_patients'),
      holoball_prescriptions: localStorage.getItem('holoball_prescriptions'),
      holoball_prompts: localStorage.getItem('holoball_prompts'),
      holoball_selected_patient_id: localStorage.getItem('holoball_selected_patient_id'),
      export_date: new Date().toISOString(),
      version: '0320'
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `holidayball_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('✅ 備份資料已匯出');
  };

  const handleImportData = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!confirm('載入備份將會覆蓋目前的本地資料，且頁面將會重新整理，確定要繼續嗎？')) {
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.holoball_patients) localStorage.setItem('holoball_patients', data.holoball_patients);
        if (data.holoball_prescriptions) localStorage.setItem('holoball_prescriptions', data.holoball_prescriptions);
        if (data.holoball_prompts) localStorage.setItem('holoball_prompts', data.holoball_prompts);
        if (data.holoball_selected_patient_id) localStorage.setItem('holoball_selected_patient_id', data.holoball_selected_patient_id);

        showToast('✅ 資料載入成功，正在嘗試重新整理...');
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        console.error('Import failed:', err);
        alert('載入失敗：檔案格式不正確');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleBLEValue = useCallback((event: Event) => {
    const value = (event.target as any).value;
    if (!value) return;

    const char = event.target as any;
    const patientId = Object.keys(characteristicRefs.current).find(id => characteristicRefs.current[id] === char) || 'default';

    const data = new Uint8Array(value.buffer);
    //if ((data[0] * 256 + data[1]) == 0x00) {
    if (data[0] < 200) {

      if ((data[0] * 256 + data[1]) == 0x00) {
        leftCalibrateRefs.current[patientId] = (data[2] * 256 * 256 + data[3] * 256 + data[4]); // Normalize to 0-1
        rightCalibrateRefs.current[patientId] = (data[5] * 256 * 256 + data[6] * 256 + data[7]); // Normalize to 0-1
      } else {
        var leftVal = (data[2] * 256 * 256 + data[3] * 256 + data[4]); // Normalize to 0-1
        var rightVal = (data[5] * 256 * 256 + data[6] * 256 + data[7]); // Normalize to 0-1
        const leftCalibrate = leftCalibrateRefs.current[patientId] || 0;
        const rightCalibrate = rightCalibrateRefs.current[patientId] || 0;

        if (leftVal > leftCalibrate) { leftVal = (leftVal - leftCalibrate) / (4194303 - leftCalibrate); }
        else { leftVal = 0; }
        if (rightVal > rightCalibrate) { rightVal = (rightVal - rightCalibrate) / (4194303 - rightCalibrate); }
        else { rightVal = 0; }
        setPressures(prev => ({ ...prev, [patientId]: { left: leftVal, right: rightVal } }));
      }

    } else {
      if (data[0] == 0xFF) {
        console.log('BLE receive 0xFF for ' + patientId);
        const encoder = new TextEncoder();
        characteristicRefs.current[patientId]?.writeValue(encoder.encode("ST"));
      }
    }
  }, []);

  const onDisconnected = useCallback((event: Event) => {
    const device = event.target as any;
    const patientId = Object.keys(deviceRefs.current).find(id => deviceRefs.current[id] === device);
    if (!patientId) return;

    setBleStatuses(prev => {
      const next = { ...prev };
      delete next[patientId];
      return next;
    });
    setPressures(prev => {
      const next = { ...prev };
      delete next[patientId];
      return next;
    });

    if (characteristicRefs.current[patientId]) {
      characteristicRefs.current[patientId].removeEventListener('characteristicvaluechanged', handleBLEValue);
      delete characteristicRefs.current[patientId];
    }
    delete deviceRefs.current[patientId];
    delete leftCalibrateRefs.current[patientId];
    delete rightCalibrateRefs.current[patientId];
    console.log(`BLE device disconnected for patient: ${patientId}`);
  }, [handleBLEValue]);

  const disconnectBLE = useCallback(() => {
    if (!selectedPatientId) return;
    const device = deviceRefs.current[selectedPatientId];
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
    }
  }, [selectedPatientId]);

  const stopGame = () => {
    setIsGameActive(false);
  };

  const handleSessionEnd = useCallback((metrics: SessionMetrics) => {
    setIsGameActive(false);
    setSessionMetrics(metrics);
    setShowSettlement(true);

    // Data Backflow: Update MVC if it was a calibration task
    if (config?.metadata.interaction_type === 'MIXED' && config?.metadata.game_name.includes('校準') && selectedPatient) {
      const newMaxL = metrics.maxPressureL || 0;
      const newMaxR = metrics.maxPressureR || 0;
      if (newMaxL > 0 || newMaxR > 0) {
        // Safeguard: Ensure MVC is at least 0.02 to avoid extreme sensitivity or division issues
        const safeL = newMaxL > 0 ? Math.max(0.02, newMaxL) : 0;
        const safeR = newMaxR > 0 ? Math.max(0.02, newMaxR) : 0;

        const updatedPatients = patients.map(p => {
          if (p.id === selectedPatientId) {
            return {
              ...p,
              daily_mvc_l: safeL || p.daily_mvc_l,
              daily_mvc_r: safeR || p.daily_mvc_r,
              last_mvc_timestamp: Date.now()
            };
          }
          return p;
        });
        handlePatientsUpdate(updatedPatients);
        alert(`✅ 校準完成！今日肌力基準已更新：左手 ${Math.round(safeL * 100)}% / 右手 ${Math.round(safeR * 100)}%`);
      }
    }
  }, [config, selectedPatient, selectedPatientId, patients]);

  const handlePatientSelect = async (patient: Patient, autoAiAnalysis: boolean) => {
    try {
      // 若當前已有生成的團康且姓名不同，執行連動更新
      if (generationPatientName && generationPatientName !== patient.name) {
        const oldName = generationPatientName;
        const newName = patient.name;

        const syncText = (text: string | null) => {
          if (!text || !newName) return text;
          // 先嘗試用上次記錄的姓名替換
          let updated = oldName ? text.split(oldName).join(newName) : text;

          // 強化：智慧識別「[人名]您好」或「[人名]先生/女士/伯伯/阿姨」等幻覺模式並校準
          const patterns = [
            /^「?([^，\s]{1,4})(您好|先生|女士|伯伯|阿姨|婆婆|奶奶|爺爺)/, // 匹配開頭
            /([^，\s]{1,4})(您好|先生|女士|伯伯|阿姨|婆婆|奶奶|爺爺)/      // 匹配文中
          ];

          patterns.forEach(pattern => {
            updated = updated.replace(pattern, (match, p1, p2) => {
              // 如果被匹配的人名不是目前的玩家，就換成目前的
              if (p1 !== newName) return (match.startsWith('「') ? '「' : '') + newName + p2;
              return match;
            });
          });

          return updated;
        };

        if (clinicalAdvice) setClinicalAdvice(syncText(clinicalAdvice));
        if (config) {
          setConfig(prev => prev ? {
            ...prev,
            game_name: syncText(prev.game_name) || prev.game_name,
            prescription_summary: syncText(prev.prescription_summary) || prev.prescription_summary,
            rehab_focus: syncText(prev.rehab_focus) || prev.rehab_focus,
            difficulty_suggestion: syncText(prev.difficulty_suggestion) || prev.difficulty_suggestion
          } : null);
        }
        if (prompt) setPrompt(syncText(prompt) || prompt);
        setGenerationPatientName(newName);
      }

      const isSamePatient = selectedPatientId === patient.id;
      setSelectedPatientId(patient.id);
      localStorage.setItem('holoball_selected_patient_id', patient.id);
      setShowPatientModal(false);

      if (!isSamePatient) {
        // 清空現有遊戲狀態，確保全新開始
        setConfig(null);
        setIsGameActive(false);
        setShowSettlement(false);
        setSessionMetrics(null);
        setAiSuggestion(null);
        setClinicalAdvice(null);
      }

      if (!autoAiAnalysis) return;

      // 觸發 AI 建議
      setLoadingSuggestion(true);
      const history = savedPrescriptions.filter(rx => rx.patientId === patient.id || rx.patientName === patient.name);
      try {
        const suggestion = await generatePatientSuggestion(patient.name, history);
        setAiSuggestion(suggestion);
      } catch (err) {
        console.error("Failed to generate AI suggestion:", err);
      } finally {
        setLoadingSuggestion(false);
      }
    } catch (err) {
      console.error('Error in handlePatientSelect:', err);
    }
  };

  const handleAcceptSuggestion = (suggestion: PatientSuggestion) => {
    const { recommended_config, clinical_advice } = suggestion;
    const { game_topic, interaction_type, total_duration } = recommended_config;

    const detailedPrompt = `主題：${game_topic}。
建議：${clinical_advice}
優化參數設定：
- 互動模式：${interaction_type}
- 總訓練時長：${total_duration} 秒`;

    setPrompt(detailedPrompt);
    setAiSuggestion(null);
    setGenerationPatientName(selectedPatient?.name || null);
  };





  const connectBLE = async () => {
    if (!selectedPatientId) {
      alert('請先在畫面上方選擇參加者，再連接好樂球！');
      return;
    }
    const targetPatientId = selectedPatientId;
    try {
      setBleStatuses(prev => ({ ...prev, [targetPatientId]: 'connecting' }));
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [BLE_SERVICE_UUID] }]
      });

      const server = await device.gatt?.connect();
      const service = await server?.getPrimaryService(BLE_SERVICE_UUID);
      const characteristic = await service?.getCharacteristic(BLE_CHARACTERISTIC_UUID);

      if (characteristic) {
        deviceRefs.current[targetPatientId] = device;
        device.addEventListener('gattserverdisconnected', onDisconnected);

        characteristicRefs.current[targetPatientId] = characteristic;
        //await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', handleBLEValue);
        await characteristic.startNotifications();

        await new Promise(resolve => setTimeout(resolve, 3000));

        const encoder = new TextEncoder();
        await characteristic.writeValue(encoder.encode("BFWLX"));
        setBleStatuses(prev => ({ ...prev, [targetPatientId]: 'connected' }));
      }
    } catch (error: any) {
      console.error('BLE connection error:', error);
      setBleStatuses(prev => {
        const next = { ...prev };
        delete next[targetPatientId];
        return next;
      });

      if (error.name === 'NotFoundError' || error.message?.includes('cancelled')) {
        console.log('User cancelled the BLE device chooser.');
      } else {
        alert('藍牙連線失敗：' + error.message);
      }
    }
  };


  // Stage 1: 機制提案。照護師按「生成遊戲」會先進入這一步,顯示確認卡。
  const handleGenerateGame = async () => {
    if (!prompt.trim()) return;
    if (proposing || loading) return;
    setProposing(true);
    try {
      const result = await proposeMechanic(prompt);
      setProposal(result);
    } catch (err: any) {
      console.error("Mechanic proposal error:", err);
      alert('玩法分析失敗：' + err.message);
    } finally {
      setProposing(false);
    }
  };

  // Stage 1 → 重新提案(同一段描述再叫一次 AI)
  const handleRegenerateProposal = async () => {
    if (!prompt.trim()) return;
    setProposing(true);
    try {
      const result = await proposeMechanic(prompt);
      setProposal(result);
    } catch (err: any) {
      console.error("Mechanic re-proposal error:", err);
      alert('玩法分析失敗：' + err.message);
    } finally {
      setProposing(false);
    }
  };

  // Stage 1 → 改一下描述(關卡片,讓使用者回到輸入框)
  const handleEditPrompt = () => {
    setProposal(null);
  };

  // Stage 2: 確認提案後實際生成遊戲。
  const handleConfirmProposal = async (p: MechanicProposal) => {
    setProposal(null);
    setSessionDurationSeconds(p.recommended_duration_seconds);
    setLoading(true);
    setIsGameActive(false);
    setSessionMetrics(null);
    setClinicalAdvice(null);
    setShowSettlement(false);
    setAiSuggestion(null);

    const advicePatientName = selectedPatient?.name || '玩家';
    const enhancedPrompt = `受訓者姓名為「${advicePatientName}」。請依據此姓名產出個人化建議。需求：${prompt}`;
    const confirmedMechanic = {
      mechanic_id: p.matched_mechanic_id,
      activity_theme: p.activity_theme,
      player_count: p.player_count,
    };

    try {
      const result = await generateGame(enhancedPrompt, userHistory, confirmedMechanic);
      const newConfig = result.config;
      let advice = result.clinicalAdvice;

      // 智慧校正生成內容中的姓名：防止 AI 幻覺
      if (advice && selectedPatient?.name) {
        const pattern = /^「?([^，\s]{1,4})(您好|先生|女士|伯伯|阿姨|婆婆|奶奶|爺爺)/;
        advice = advice.replace(pattern, (match, p1, p2) => {
          if (p1 !== selectedPatient.name) return (match.startsWith('「') ? '「' : '') + selectedPatient.name + p2;
          return match;
        });
      }

      setClinicalAdvice(advice);
      // 記錄此建議生成時對應的玩家，以便後續切換時能執行字串替換
      const currentPatientName = selectedPatient?.name || null;
      setGenerationPatientName(currentPatientName);

      // [暫停] 影像生成 API 暫時關閉。要恢復請將 SKIP_IMAGE_GEN 設為 false。
      const SKIP_IMAGE_GEN = true;

      // 尋找具有提示詞的場景背景
      const bgEntity = newConfig.entities.find((e: any) => e.visual?.bg_image_prompt);

      if (!SKIP_IMAGE_GEN) {
        // 1. 生成所有獨立實體的專屬圖片
        const entityPromises = newConfig.entities.map(async (ent: any) => {
          if (ent.visual?.image_prompt) {
            try {
              const imageUrl = await generateImage(ent.visual.image_prompt);
              // 立即儲存到伺服器並取得路徑
              const saveRes = await fetch('/api/save-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData: imageUrl, filename: `obj_${Date.now()}_${ent.id}.png` })
              });
              const saveData = await saveRes.json();
              if (saveData.success) {
                ent.visual.image_url = saveData.path;
                if (!newConfig.image_url) newConfig.image_url = saveData.path;
              } else {
                ent.visual.image_url = imageUrl; // Fallback to base64
                if (!newConfig.image_url) newConfig.image_url = imageUrl;
              }
            } catch (imgErr) {
              console.error(`Entity ${ent.id} Image generation/save failed:`, imgErr);
            }
          }
        });

        await Promise.all(entityPromises);
        if (newConfig.image_url) fetchHistoryImages();

        // 2. 生成場景背景圖
        if (bgEntity?.visual?.bg_image_prompt) {
          try {
            const bgImageUrl = await generateImage(bgEntity.visual.bg_image_prompt);
            const saveRes = await fetch('/api/save-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ imageData: bgImageUrl, filename: `bg_${Date.now()}.png` })
            });
            const saveData = await saveRes.json();
            if (saveData.success) {
              newConfig.bg_image_url = saveData.path;
            } else {
              newConfig.bg_image_url = bgImageUrl; // Fallback to base64
            }
          } catch (bgErr) {
            console.error("Background Image generation/save failed:", bgErr);
          }
        }
      }

      setConfig(newConfig);
      // 將生成的 JSON 顯示在提示詞區，方便除錯與測試
      setPrompt(JSON.stringify(newConfig, null, 2));
    } catch (err: any) {
      console.error("Game Generation Error:", err);
      alert('生成遊戲失敗：' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const currentBleStatus = selectedPatientId ? bleStatuses[selectedPatientId] || 'disconnected' : 'disconnected';
  const currentPressure = selectedPatientId && pressures[selectedPatientId] ? pressures[selectedPatientId] : { left: 0, right: 0 };

  const startGame = () => {
    if (currentBleStatus !== 'connected') {
      alert('請先選擇參加者並連接好樂球設備');
      return;
    }
    setIsGameActive(true);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-amber-950 p-4 md:p-8 space-y-4">
      <style>{`
        .checkered-bg {
          background-image: 
            linear-gradient(45deg, #92400e 25%, transparent 25%), 
            linear-gradient(-45deg, #92400e 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #92400e 75%),
            linear-gradient(-45deg, transparent 75%, #92400e 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
          background-color: #451a03;
        }
        @keyframes loading-dots {
          0% { content: ''; }
          33% { content: '.'; }
          66% { content: '..'; }
          100% { content: '...'; }
        }
        .loading-dots::after {
          content: '';
          animation: loading-dots 1.5s infinite;
          display: inline-block;
          width: 1.5em;
          text-align: left;
        }
      `}</style>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            AIGrip 智癒球：隨心定義、多人共玩之 AI 智慧團康平台
          </h1>
          <p className="text-amber-400 text-sm mt-1">整合 GenAI 動態遊戲生成與多機連線感測之樂齡社交解決方案 v0427</p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setShowPatientModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg font-bold bg-amber-800 hover:bg-amber-700 text-white transition-all border border-amber-700"
          >
            <User className={`w-4 h-4 ${selectedPatient ? 'text-emerald-400' : 'text-amber-500'}`} />
            {selectedPatient ? selectedPatient.name : '選擇玩家'}
          </button>
          <button
            onClick={() => setShowRehabLog(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg font-bold bg-amber-800 hover:bg-amber-700 text-white transition-all border border-amber-700"
          >
            <History className="w-4 h-4 text-cyan-400" />
            康復日誌
          </button>
          <button
            onClick={() => {
              if (currentBleStatus === 'disconnected') connectBLE();
              else if (currentBleStatus === 'connected' && !isGameActive) disconnectBLE();
            }}
            disabled={currentBleStatus === 'connecting' || (currentBleStatus === 'connected' && isGameActive)}
            className={`px-4 py-2 rounded-lg font-bold transition-all ${currentBleStatus === 'connected'
              ? (isGameActive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 opacity-50 cursor-not-allowed' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-rose-500/90 hover:text-white hover:border-rose-500 cursor-pointer')
              : currentBleStatus === 'connecting'
                ? 'bg-amber-800 text-amber-500 animate-pulse cursor-wait'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20'
              }`}
          >
            {currentBleStatus === 'connected' ? (isGameActive ? '● 已連線' : '● 已連線 (點擊斷開)') : currentBleStatus === 'connecting' ? '連接中...請勿握壓好樂球' : '連接好樂球'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">
        {/* Left Control Panel */}
        <div className="lg:col-span-1 flex flex-col space-y-4 overflow-y-auto pr-2 custom-scrollbar">
          <div className="bg-amber-900 p-4 rounded-xl border border-amber-800 flex flex-col items-center">
            <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4">好樂球狀態</h2>
            <div className="flex justify-between items-end w-full px-1 gap-1 pb-2 overflow-x-auto custom-scrollbar">
              {[0, 1, 2, 3].map((index) => {
                const connectedPatientIds = Object.keys(pressures);
                const patientId = connectedPatientIds[index];
                const patient = patientId ? patients.find(p => p.id === patientId) : null;
                const isActive = !!patientId;
                const pLeft = isActive && pressures[patientId] ? pressures[patientId].left : 0;
                const pRight = isActive && pressures[patientId] ? pressures[patientId].right : 0;

                return (
                  <div key={index} className={`flex flex-col items-center pb-1 flex-1 min-w-[55px] ${isActive ? '' : 'opacity-40'}`}>
                    <div className="flex gap-1.5 h-[160px] items-end w-full justify-center">
                      <div className="flex flex-col items-center h-full justify-end">
                        <span className="text-[9px] mb-1 font-bold text-rose-300 transform scale-90">{Math.round(pLeft * 100)}%</span>
                        <div className={`w-3 h-full rounded-sm overflow-hidden flex flex-col justify-end ${isActive ? 'bg-amber-800' : 'bg-amber-800/30 border border-amber-800/50 border-dashed'}`}>
                          <div className="w-full bg-rose-500 transition-all duration-75" style={{ height: `${pLeft * 100}%` }} />
                        </div>
                        <span className="text-rose-400 font-medium text-[9px] mt-1 transform scale-90">左</span>
                      </div>
                      <div className="flex flex-col items-center h-full justify-end">
                        <span className="text-[9px] mb-1 font-bold text-amber-300 transform scale-90">{Math.round(pRight * 100)}%</span>
                        <div className={`w-3 h-full rounded-sm overflow-hidden flex flex-col justify-end ${isActive ? 'bg-amber-800' : 'bg-amber-800/30 border border-amber-800/50 border-dashed'}`}>
                          <div className="w-full bg-amber-500 transition-all duration-75" style={{ height: `${pRight * 100}%` }} />
                        </div>
                        <span className="text-amber-400 font-medium text-[9px] mt-1 transform scale-90">右</span>
                      </div>
                    </div>
                    <div className="mt-2 bg-emerald-900/30 px-1 py-1 rounded w-full text-center border border-emerald-500/20 shadow-sm truncate">
                      <span className="text-[9px] font-bold text-emerald-400 whitespace-nowrap">
                        {isActive && patient ? patient.name : `玩家 ${index + 1}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-amber-900 p-4 rounded-xl border border-amber-800 flex flex-col min-h-[450px]">
            <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-3">AI 智能團康建議</h2>

            <div className="mb-4">
              <label className="text-[10px] font-bold text-amber-500 uppercase mb-1 block">參加者姓名</label>
              <div className="relative">
                <input
                  type="text"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="輸入姓名以載入紀錄..."
                  className="w-full bg-amber-950 border border-amber-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  list="app-patients-list"
                />
                <datalist id="app-patients-list">
                  {existingPatients.map(name => <option key={name} value={name} />)}
                </datalist>
                <User className="absolute right-2 top-2 w-4 h-4 text-amber-600" />
              </div>
            </div>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="輸入復健目標或主題..."
              className="w-full h-32 bg-amber-950 border border-amber-700 rounded-lg p-3 text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none resize-none mb-3"
            />
            <div className="flex gap-2 mb-4">
              <button
                onClick={handleGenerateGame}
                disabled={loading || proposing || !!proposal}
                className={`flex-1 py-3 rounded-lg font-bold transition-all ${loading || proposing || proposal ? 'bg-amber-800 text-amber-500 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg'
                  }`}
              >
                {proposing
                  ? <span className="loading-dots">分析玩法中</span>
                  : loading
                    ? <span className="loading-dots">生成中</span>
                    : '生成遊戲'}
              </button>
              {loadingSuggestion && (
                <div className="fixed inset-0 bg-amber-950/60 backdrop-blur-md flex items-center justify-center z-[1000] animate-in fade-in duration-300">
                  <div className="bg-amber-900/90 border-2 border-emerald-500/50 p-12 rounded-[2.5rem] shadow-2xl flex flex-col items-center gap-6 animate-in zoom-in duration-500">
                    <div className="w-20 h-20 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-[40px] font-black text-emerald-400 tracking-tighter drop-shadow-[0_0_15px_rgba(52,211,153,0.3)]">AI 分析中...</span>
                    <span className="text-amber-500 text-sm font-bold uppercase tracking-[0.2em]">正在為您打造個人化度假任務</span>
                  </div>
                </div>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-3 bg-amber-800 hover:bg-amber-700 text-amber-300 rounded-lg font-bold transition-all border border-amber-700"
                title="上傳本地圖片"
              >
                上傳
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleLocalImageUpload}
                accept="image/*"
                className="hidden"
              />
              <button
                onClick={handleSavePrompt}
                className="px-4 py-3 bg-amber-800 hover:bg-amber-700 text-amber-300 rounded-lg font-bold transition-all border border-amber-700"
                title="儲存提示詞"
              >
                儲存
              </button>
            </div>

            {/* Saved Prompts List */}
            <div className="flex-1 min-h-0 flex flex-col">
              <h3 className="text-xs font-bold text-amber-500 uppercase mb-2">已儲存的提示詞</h3>
              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                {savedPrompts.length === 0 ? (
                  <p className="text-amber-600 text-xs italic">尚未儲存任何提示詞</p>
                ) : (
                  savedPrompts.map((p, i) => (
                    <div
                      key={i}
                      onClick={() => setPrompt(p)}
                      className="group relative bg-amber-950 border border-amber-800 hover:border-amber-600 p-2 rounded-lg cursor-pointer transition-all"
                    >
                      <p className="text-amber-300 text-xs line-clamp-2 pr-6">{p}</p>
                      <button
                        onClick={(e) => handleDeletePrompt(e, p)}
                        className="absolute right-2 top-2 text-amber-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="刪除"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="bg-amber-900 p-4 rounded-xl border border-amber-800 flex flex-col min-h-[300px]">
            <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-3">歷史團康</h2>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
              {savedPrescriptions.filter(rx => !rx.metrics).length === 0 ? (
                <p className="text-amber-600 text-xs italic">尚未儲存任何團康</p>
              ) : (
                savedPrescriptions.filter(rx => !rx.metrics).map((rx) => (
                  <div
                    key={rx.id}
                    onClick={() => handleLoadPrescription(rx)}
                    className={`group relative bg-amber-950 border p-3 rounded-lg cursor-pointer transition-all hover:border-emerald-500/50 ${config && config.metadata.game_name === rx.game_name ? 'border-emerald-500 bg-emerald-500/5' : 'border-amber-800'
                      }`}
                  >
                    <div className="flex gap-3 items-center">
                      <div className="w-12 h-12 bg-amber-900 rounded border border-amber-800 flex items-center justify-center overflow-hidden shrink-0 checkered-bg">
                        {rx.assets.image_url ? (
                          <img src={rx.assets.image_url} alt="" className="w-full h-full object-contain p-0.5" />
                        ) : (
                          <span className="text-xl">🎮</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-amber-200 text-sm font-bold truncate">{rx.game_name}</p>
                          {rx.patientName && (
                            <span className="bg-emerald-500/10 text-emerald-500 text-[8px] px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold shrink-0">
                              {rx.patientName}
                            </span>
                          )}
                        </div>
                        <p className="text-amber-500 text-[10px]">{new Date(rx.timestamp).toLocaleString()}</p>
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleDeletePrescription(e, rx.id)}
                      className="absolute right-2 top-2 text-amber-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-amber-900 p-4 rounded-xl border border-amber-800 flex flex-col min-h-[300px]">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">素材圖庫</h2>
              <button
                onClick={fetchHistoryImages}
                className="text-[10px] text-amber-500 hover:text-cyan-400"
              >
                🔄 重新整理
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="h-full overflow-y-auto custom-scrollbar pr-1">
                <div className="grid grid-cols-2 gap-2 auto-rows-max">
                  {historyImages.length === 0 ? (
                    <p className="col-span-2 text-amber-600 text-xs italic text-center py-8">尚未有歷史素材</p>
                  ) : (
                    historyImages.map((img, i) => (
                      <div
                        key={i}
                        className={`w-full aspect-video checkered-bg border rounded-lg transition-all overflow-hidden group relative ${config?.image_url === img || config?.bg_image_url === img
                          ? 'border-emerald-500 ring-2 ring-emerald-500/10'
                          : 'border-amber-800'
                          }`}
                      >
                        <img src={img} alt={`History ${i}`} className="w-full h-full object-contain p-1" />
                        <div className="absolute inset-0 bg-amber-950/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-2 transition-opacity p-2">
                          <button
                            onClick={() => handleSelectLibraryImage(img, 'main')}
                            className="w-full py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded text-[10px] shadow-lg flex items-center justify-center gap-1 transition-transform active:scale-95"
                          >
                            <span>使用物件</span>
                          </button>
                          <button
                            onClick={() => handleSelectLibraryImage(img, 'bg')}
                            className="w-full py-1.5 bg-amber-700 hover:bg-amber-600 text-white font-bold rounded text-[10px] shadow-lg flex items-center justify-center gap-1 transition-transform active:scale-95"
                          >
                            <span>使用背景</span>
                          </button>
                        </div>
                        {config?.image_url === img && (
                          <div className="absolute top-1 left-1 bg-emerald-500 text-[8px] font-black px-1 rounded text-amber-950 uppercase">Main</div>
                        )}
                        {config?.bg_image_url === img && (
                          <div className="absolute top-1 right-1 bg-cyan-500 text-[8px] font-black px-1 rounded text-amber-950 uppercase">BG</div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="bg-amber-900 p-4 rounded-xl border border-amber-800 flex flex-col">
            <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-3">資料維護</h2>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleExportData}
                className="flex items-center justify-center gap-2 py-2 bg-amber-800 hover:bg-amber-700 text-amber-300 rounded-lg text-[10px] font-bold border border-amber-700 transition-all"
              >
                <Download className="w-3 h-3" />
                匯出備份
              </button>
              <button
                onClick={() => importFileInputRef.current?.click()}
                className="flex items-center justify-center gap-2 py-2 bg-amber-800 hover:bg-amber-700 text-amber-300 rounded-lg text-[10px] font-bold border border-amber-700 transition-all"
              >
                <Upload className="w-3 h-3" />
                載入備份
              </button>
              <input
                type="file"
                ref={importFileInputRef}
                onChange={handleImportData}
                accept="application/json"
                className="hidden"
              />
            </div>
            <p className="text-[9px] text-amber-600 mt-2 text-center">匯出結果為 JSON 格式，可跨機器轉移資料</p>
          </div>
        </div>

        {/* Right Game Canvas */}
        <div className="lg:col-span-3 flex flex-col space-y-4 overflow-y-auto pr-2 custom-scrollbar">
          {config ? (
            <>
              <div className="bg-amber-900/50 p-4 rounded-xl border border-amber-800 backdrop-blur-sm flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <span className="text-2xl">🎮</span>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">{config.metadata.game_name}</h2>
                    <p className="text-amber-400 text-sm">{config.metadata.prescription_summary}</p>
                  </div>
                </div>
                {isGameActive && (
                  <button
                    onClick={stopGame}
                    className="px-4 py-2 bg-amber-800 hover:bg-amber-700 text-amber-300 rounded-lg text-sm font-bold transition-colors border border-amber-700"
                  >
                    結束遊戲
                  </button>
                )}
              </div>

              <div className="flex-1 relative rounded-xl overflow-hidden group">
                <ErrorBoundary fallback={<div className="text-white p-4">Game Error</div>}>
                  <GameView
                    config={config}
                    pressure={currentPressure}
                    pressures={pressures}
                    isActive={isGameActive}
                    patientName={selectedPatient?.name}
                    mvcL={selectedPatient?.daily_mvc_l}
                    mvcR={selectedPatient?.daily_mvc_r}
                    durationSeconds={sessionDurationSeconds ?? undefined}
                    onSessionEnd={handleSessionEnd}
                  />
                </ErrorBoundary>

                {showSettlement && sessionMetrics && (
                  <SummaryView
                    metrics={sessionMetrics}
                    config={config!}
                    existingPatients={existingPatients}
                    onSave={(name) => {
                      handleSavePrescription(name);
                    }}
                    onRetry={() => {
                      setShowSettlement(false);
                      setIsGameActive(true);
                    }}
                    onClose={() => {
                      setShowSettlement(false);
                      setSessionMetrics(null);
                    }}
                    isHistorical={sessionMetrics.isHistorical}
                    initialPatientName={patientName}
                    patients={patients}
                    selectedPatientId={selectedPatientId}
                  />
                )}

                {!isGameActive && (
                  <div className="absolute inset-0 bg-amber-950/80 backdrop-blur-md flex flex-col items-center justify-center z-50 transition-all p-6">
                    <div className="w-full max-w-lg bg-amber-900 border-2 border-emerald-500/50 rounded-2xl shadow-2xl shadow-emerald-950/20 flex flex-col max-h-[90vh] overflow-hidden transform transition-all hover:scale-[1.01]">
                      {/* Header */}
                      <div className="bg-emerald-900/30 px-6 py-4 border-b border-emerald-500/20 shrink-0 flex justify-between items-center">
                        <h3 className="text-2xl font-black text-white tracking-tight flex items-center gap-3">
                          <span className="text-emerald-400">📋</span> 團康確認
                        </h3>
                        {selectedPatient && (
                          <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                            <User className="w-3 h-3 text-emerald-400" />
                            <span className="text-emerald-400 text-xs font-bold">{selectedPatient.name}</span>
                          </div>
                        )}
                      </div>

                      {/* Content (Scrollable) */}
                      <div className="px-6 py-6 space-y-6 overflow-y-auto custom-scrollbar">
                        <div className="space-y-1">
                          <label className="text-emerald-500/70 text-[10px] font-bold uppercase tracking-widest">任務名稱</label>
                          <p className="text-xl font-bold text-white">{config.metadata.game_name}</p>
                        </div>

                        <div className="bg-amber-950/50 rounded-xl p-5 border border-amber-800">
                          <label className="text-emerald-500/70 text-[10px] font-bold uppercase tracking-widest mb-2 block">訓練指令</label>
                          <p className="text-lg text-emerald-50 leading-relaxed font-medium">
                            {config.metadata.prescription_summary || `HolidayBall 任務：${config.metadata.game_name} (${config.metadata.interaction_type})`}
                          </p>
                        </div>

                        {clinicalAdvice && (
                          <div className="bg-emerald-500/10 rounded-xl p-5 border border-emerald-500/20 relative overflow-hidden group">
                            <div className="absolute top-0 right-0 p-2 opacity-20 group-hover:opacity-40 transition-opacity">
                              <Zap className="w-8 h-8 text-emerald-400" />
                            </div>
                            <label className="text-emerald-400 text-[10px] font-bold uppercase tracking-widest mb-2 block flex items-center gap-2">
                              <Star className="w-3 h-3" /> AI 活動助理建議
                            </label>
                            <p className="text-amber-200 text-sm leading-relaxed italic">
                              「{clinicalAdvice}」
                            </p>
                          </div>
                        )}

                        <div className="flex items-center gap-4 pt-2">
                          <button
                            onClick={startGame}
                            className="flex-1 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-xl text-lg transition-all active:scale-[0.98] shadow-lg shadow-emerald-900/20"
                          >
                            確定開始
                          </button>
                          <button
                            onClick={() => handleSavePrescription()}
                            className="px-4 py-4 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl text-lg transition-all active:scale-[0.98] flex items-center justify-center"
                            title="儲存團康"
                          >
                            💾
                          </button>
                          <button
                            onClick={() => setConfig(null)}
                            className="px-6 py-4 bg-amber-800 hover:bg-amber-700 text-amber-400 font-bold rounded-xl text-lg transition-all active:scale-[0.98]"
                          >
                            取消
                          </button>
                        </div>
                      </div>

                      {/* Footer Badge */}
                      <div className="bg-amber-950 px-6 py-3 text-center border-t border-amber-900 shrink-0">
                        <p className="text-[10px] text-amber-600 font-bold uppercase tracking-[0.2em]">HolidayBall AI Activity Protocol Approved</p>
                      </div>
                    </div>

                    {currentBleStatus !== 'connected' && (
                      <div className="mt-8 px-6 py-3 bg-rose-500/10 border border-rose-500/20 rounded-full animate-pulse">
                        <p className="text-rose-400 text-sm font-bold flex items-center gap-2">
                          <span>⚠️</span> 請先連接好樂球設備以進行訓練
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-amber-900/50 p-4 rounded-xl border border-amber-800 max-h-32 overflow-y-auto custom-scrollbar">
                  <h3 className="text-amber-400 text-xs font-bold uppercase mb-1 sticky top-0 bg-amber-900/50">訓練強度預覽</h3>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-amber-200 text-sm font-bold">{config.metadata.interaction_type} 模式</span>
                    <span className="text-amber-400 text-[10px]">
                      分數目標: {config.scoring_metrics.target_score || 100}
                    </span>
                  </div>
                  <p className="text-amber-500 text-[10px] mt-1">
                    {config.entities.length} 個互動物件
                  </p>
                </div>
                <div className="bg-amber-900/50 p-4 rounded-xl border border-amber-800 max-h-32 overflow-y-auto custom-scrollbar">
                  <h3 className="text-cyan-400 text-xs font-bold uppercase mb-1 sticky top-0 bg-amber-900/50">活動焦點</h3>
                  <p className="text-amber-200 text-sm leading-relaxed">
                    與 {config.collision_handlers.length} 個碰撞處理邏輯對接
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 border-2 border-dashed border-amber-800 rounded-xl flex flex-col items-center justify-center text-amber-600 space-y-4">
              <div className="w-20 h-20 bg-amber-900 rounded-full flex items-center justify-center text-4xl">
                🤖
              </div>
              <div className="text-center">
                <p className="text-lg font-medium">尚未載入遊戲</p>
                <p className="text-sm">請於左側輸入描述並點擊生成遊戲</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Rehab Log Modal */}
      {showRehabLog && (
        <div className="fixed inset-0 bg-amber-950/90 backdrop-blur-xl z-[300] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="w-full max-w-4xl bg-amber-900 border border-white/10 rounded-[2rem] shadow-2xl flex flex-col max-h-[85vh]">
            <div className="p-8 border-b border-white/5 flex justify-between items-center bg-amber-900/50">
              <div>
                <h2 className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
                  <ClipboardList className="w-8 h-8 text-cyan-400" />
                  個人康復日誌
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-amber-500 text-sm uppercase tracking-widest font-bold">Patient Recovery Records</p>
                  {selectedPatient && (
                    <span className="text-emerald-400 text-xs font-bold px-2 py-0.5 bg-emerald-400/10 border border-emerald-400/20 rounded">
                      正在顯示：{selectedPatient.name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleClearAllLogs}
                  className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-bold transition-all"
                >
                  🗑️ 清除所有日誌
                </button>
                <button
                  onClick={handleClearAllPrescriptions}
                  className="px-4 py-2 bg-amber-800 hover:bg-amber-700 text-amber-400 border border-amber-700 rounded-lg text-xs font-bold transition-all"
                >
                  🧹 清除團康模板
                </button>
                <button
                  onClick={() => setShowRehabLog(false)}
                  className="w-12 h-12 bg-white/5 hover:bg-white/10 rounded-full flex items-center justify-center text-amber-400 transition-all"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-4">
              {(() => {
                const filtered = savedPrescriptions.filter(rx =>
                  !!rx.metrics &&
                  (selectedPatientId ? rx.patientId === selectedPatientId : true)
                );

                const trendData = filtered
                  .map(rx => ({ timestamp: rx.timestamp, maxPressure: (rx.metrics as any).maxPressure || 0 }))
                  .filter(d => d.maxPressure > 0);

                if (filtered.length === 0) {
                  return (
                    <div className="h-64 flex flex-col items-center justify-center text-amber-700 bg-amber-950/20 rounded-3xl border-2 border-dashed border-white/5">
                      <Search className="w-12 h-12 mb-4 opacity-20" />
                      <p className="font-bold">{selectedPatient ? `尚無 ${selectedPatient.name} の康復紀錄` : '尚無康復紀錄'}</p>
                    </div>
                  );
                }
                return (
                  <>
                    {trendData.length >= 2 && <GripTrendLine data={trendData} />}
                    <div className="grid gap-3">
                      {filtered.map(rx => (
                        <div
                          key={rx.id}
                          onClick={() => {
                            handleLoadPrescription(rx);
                            if (rx.metrics) {
                              setSessionMetrics({ ...rx.metrics, isHistorical: true });
                              setShowSettlement(true);
                            }
                            setShowRehabLog(false);
                          }}
                          className="group bg-amber-950 hover:bg-amber-800 p-5 rounded-2xl border border-white/5 hover:border-cyan-500/30 transition-all cursor-pointer flex flex-col md:flex-row gap-4 items-start md:items-center justify-between"
                        >
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-amber-900 rounded-xl flex items-center justify-center text-2xl shadow-inner group-hover:bg-cyan-900/20 transition-colors">
                              <User className="w-6 h-6 text-amber-600 group-hover:text-cyan-400" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-white font-black text-lg">{rx.patientName || '未命名'}</span>
                                <span className="bg-amber-800 text-amber-500 text-[10px] px-2 py-0.5 rounded-full font-bold">{rx.game_name}</span>
                              </div>
                              <div className="flex items-center gap-3 text-amber-500 text-xs mt-1">
                                <span className="flex items-center gap-1.5 font-bold"><Calendar className="w-3 h-3" /> {new Date(rx.timestamp).toLocaleDateString()}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-6 w-full md:w-auto">
                            <div className="flex-1 md:flex-none flex flex-col items-end">
                              <span className="text-amber-500 text-[10px] font-black uppercase tracking-tighter">達成率</span>
                              <div className="flex items-center gap-1 text-emerald-400">
                                <span className="text-xl font-black">{rx.best_achievement_rate || 0}%</span>
                                <Star className="w-4 h-4 fill-current" />
                              </div>
                            </div>

                            <div className="flex-1 md:flex-none flex flex-col items-end min-w-[100px]">
                              <span className="text-amber-500 text-[10px] font-black uppercase tracking-tighter">代償校驗</span>
                              {rx.metrics?.compensationOccurred ? (
                                <span className="text-rose-400 text-xs font-bold bg-rose-400/10 px-2 py-0.5 rounded-lg border border-rose-400/20">偵測到代償</span>
                              ) : (
                                <span className="text-emerald-400 text-xs font-bold bg-emerald-400/10 px-2 py-0.5 rounded-lg border border-emerald-400/20 flex items-center gap-1">
                                  <ShieldCheck className="w-3 h-3" /> 通過
                                </span>
                              )}
                            </div>

                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-cyan-500 group-hover:text-black transition-all">
                              →
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeletePrescription(e, rx.id);
                              }}
                              className="w-8 h-8 rounded-full bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100"
                              title="刪除此紀錄"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Patient Management Modal */}
      {showPatientModal && (
        <PatientManagementModal
          patients={patients}
          selectedPatientId={selectedPatientId}
          onSelect={handlePatientSelect}
          onUpdate={handlePatientsUpdate}
          onClose={() => setShowPatientModal(false)}
        />
      )}

      {/* AI Suggestion Modal */}
      {aiSuggestion && selectedPatient && (
        <AISuggestionModal
          suggestion={aiSuggestion}
          patientName={selectedPatient.name}
          onAccept={handleAcceptSuggestion}
          onClose={() => setAiSuggestion(null)}
        />
      )}

      {/* Stage 1 玩法提案確認卡 */}
      {proposal && (
        <PlayProposalCard
          proposal={proposal}
          busy={proposing || loading}
          onConfirm={handleConfirmProposal}
          onRegenerate={handleRegenerateProposal}
          onEdit={handleEditPrompt}
        />
      )}

      {toast && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[2000] animate-in slide-in-from-bottom-5 duration-300">
          <div className={`px-6 py-3 rounded-full shadow-2xl flex items-center gap-2 font-bold text-sm ${toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-amber-800 text-amber-300 border border-amber-700'
            }`}>
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
