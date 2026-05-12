import React, { useEffect, useRef } from 'react';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { OutlineFilter } from 'pixi-filters';
import { GameConfig, SessionMetrics, PressureData, Entity, EntityRole, LayoutHint, Sector } from '../types';

interface GameViewProps {
  patientName?: string;
  config: GameConfig;
  pressure: PressureData;
  pressures?: Record<string, PressureData>;
  isActive: boolean;
  mvcL?: number;
  mvcR?: number;
  /** 遊戲時長(秒)。timer 到時自動觸發 onSessionEnd。undefined 代表無限時長(舊流程)。 */
  durationSeconds?: number;
  onSessionEnd: (metrics: SessionMetrics) => void;
}

const PIXI_GLOBAL_KEY = '__HOLOBALL_PIXI_APP__';
const PIXI_INIT_KEY = '__HOLOBALL_PIXI_INIT_PROMISE__';

const getOrInitApp = async (): Promise<PIXI.Application> => {
  const g = globalThis as any;
  if (g[PIXI_INIT_KEY]) return g[PIXI_INIT_KEY];
  const app = new PIXI.Application();
  g[PIXI_GLOBAL_KEY] = app;
  g[PIXI_INIT_KEY] = app.init({
    antialias: true,
    autoDensity: true,
    background: 0x000000,
    resolution: window.devicePixelRatio || 1,
    hello: false,
  }).then(() => app);
  return g[PIXI_INIT_KEY];
};

const parseColor = (c?: string) => {
  if (!c) return 0xffffff;
  const hex = c.replace(/^0x|^#/, '');
  return parseInt(hex, 16) || 0xffffff;
};

// MIXED-mode paddle layout: P1 top / P2 bottom, distinct colors
const MIXED_PAWN_COLORS: Record<number, number> = { 1: 0x00BFFF, 2: 0xFF8C00 };
const MIXED_BALL_COLORS = { blue: 0x00BFFF, orange: 0xFF8C00 } as const;
type MixedBallColor = keyof typeof MIXED_BALL_COLORS;
const pawnSlotToBallColor = (slot: 1 | 2): MixedBallColor => (slot === 1 ? 'blue' : 'orange');
const flipBallColor = (c: MixedBallColor): MixedBallColor => (c === 'blue' ? 'orange' : 'blue');
const randomFallVx = () => (150 + Math.random() * 200) * (Math.random() > 0.5 ? 1 : -1);

// === Semantic field readers (with legacy id-string fallback) ===
type EntLike = { id: string; type?: string; role?: EntityRole; layout?: LayoutHint; sector?: Sector; ball_binding?: string };

const getEntityRole = (ent: EntLike): EntityRole => {
  if (ent.role) return ent.role;
  // legacy fallback for stored prescriptions
  if (ent.id.includes('hole') && ent.id.includes('target')) return 'mushroom';
  if (ent.id.includes('picker')) return 'basket';
  if (ent.type === 'controllable_pawn') return 'paddle';
  if (ent.type === 'target') return 'mushroom';
  if (ent.type === 'obstacle') return 'obstacle';
  return 'decoration';
};

const getEntityLayout = (ent: EntLike): LayoutHint => {
  if (ent.layout) return ent.layout;
  if (ent.id.includes('left')) return 'left';
  if (ent.id.includes('right')) return 'right';
  return 'center';
};

const getEntitySector = (ent: EntLike): Sector => {
  if (ent.sector) return ent.sector;
  const b = ent.ball_binding;
  // 新格式 p{N}_{left|right|both} 取 N
  const m = b?.match(/^p(\d+)_/);
  if (m) {
    const idx = parseInt(m[1], 10);
    if (idx === 1) return 'p1';
    if (idx === 2) return 'p2';
    if (idx === 3) return 'p3';
    if (idx === 4) return 'p4';
  }
  // 舊格式: ball_N / p{N} / player_N
  const legacy = b?.match(/^(?:ball|p|player)_?(\d+)$/);
  if (legacy) {
    const idx = parseInt(legacy[1], 10);
    if (idx === 1) return 'p1';
    if (idx === 2) return 'p2';
    if (idx === 3) return 'p3';
    if (idx === 4) return 'p4';
  }
  return 'shared';
};

// 依玩家人數動態決定 X 位置:
// - 1~4 人: sector 將螢幕等分為 N 欄(p1 最左、pN 最右), layout 在欄內偏移 ±20% 欄寬。
//   選用 0.2 而非 0.3 是為了讓「同玩家左右手 (intra-column)」距離 < 「鄰近玩家 (inter-column)」距離,
//   視覺上每位玩家的兩支槌子會配對在一起,不會跟鄰居錯位成群。
//   1P → 1 欄(整個畫面),left/right 落在 30%/70%。
// - sector === 'shared' 或無法解析時:layout 直接對應 25%/50%/75%(舊版 fallback)。
const getLayoutX = (ent: EntLike, screenW: number, playerCount: number = 1): number => {
  const layout = getEntityLayout(ent);
  const sector = getEntitySector(ent);

  if (playerCount >= 1 && sector !== 'shared') {
    const m = sector.match(/^p(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < playerCount) {
        const colWidth = screenW / playerCount;
        const colCenter = colWidth * (idx + 0.5);
        if (layout === 'left') return colCenter - colWidth * 0.2;
        if (layout === 'right') return colCenter + colWidth * 0.2;
        return colCenter;
      }
    }
  }

  if (layout === 'left') return screenW * 0.25;
  if (layout === 'right') return screenW * 0.75;
  return screenW / 2;
};

const getPawnPlayerSlot = (ent: EntLike): 1 | 2 => {
  const sector = getEntitySector(ent);
  if (sector === 'p2') return 2;
  if (sector === 'p1') return 1;
  // shared/unset → fallback to layout
  return getEntityLayout(ent) === 'right' ? 2 : 1;
};

const getMixedPawnY = (slot: 1 | 2, screenH: number) => screenH * (slot === 1 ? 0.85 : 0.95);

// Linear interpolation — 平滑感測器抖動，符合「度假感」入場
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// 入場動畫總時長
const ANTICIPATION_MS = 1500;

// 收集當次 session 訓練到的臨床標籤（去重），供 SessionMetrics 記錄
const collectClinicalTags = (cfg: GameConfig | undefined | null): string[] => {
  if (!cfg) return [];
  const set = new Set<string>();
  for (const ent of cfg.entities ?? []) {
    const tag = ent.movement_logic?.clinical_tag;
    if (tag) set.add(tag);
  }
  return Array.from(set);
};

const GameView: React.FC<GameViewProps> = ({ config, pressure, pressures, isActive, patientName, mvcL = 1.0, mvcR = 1.0, durationSeconds, onSessionEnd }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ config, pressure, pressures, isActive, durationSeconds });
  const appRef = useRef<PIXI.Application | null>(null);
  const sessionContainerRef = useRef<PIXI.Container | null>(null);
  const entitiesRef = useRef<{ [id: string]: PIXI.Container }>({});
  const entityPhysicsRef = useRef<{ [id: string]: { vy: number, lastY: number, hasFired: boolean } }>({});
  const collisionCooldownRef = useRef<{ [key: string]: number }>({});
  const ballColorRef = useRef<{ [id: string]: MixedBallColor }>({});
  const ballScaleRef = useRef<{ [id: string]: number }>({});
  const backgroundSpriteRef = useRef<PIXI.Sprite | null>(null);
  const sequenceStepRef = useRef<number>(1);
  const sequenceBulbsRef = useRef<PIXI.Graphics[]>([]);
  const sequenceBulbContainerRef = useRef<PIXI.Container | null>(null);
  const playerZonesRef = useRef<PIXI.Container | null>(null);
  // 記憶序列：AI 提供的踩踏 pattern，sequenceIndexRef 為當前位置
  const sequencePatternRef = useRef<number[]>([]);
  const sequenceIndexRef = useRef<number>(0);

  // 太鼓同步:左/右兩組共用座標,依 pattern 輪流/同時落下形成節拍。
  // pattern 元素:'left'=只左落、'right'=只右落、'both'=左右一起落
  // 預設 [L, R, L, R, B] 重複,類似真實鼓點(左右左右然後一拍兩邊一起)。
  const taikoSyncRef = useRef<{
    pattern: ('left' | 'right' | 'both')[];
    patternIndex: number;
    leftY: number;
    rightY: number;
    pauseUntil: number;
    initialized: boolean;
    consumedThisBeat: Set<string>; // 本拍已被擊中的 drum id,在本拍剩餘時間內隱藏
  }>({
    pattern: ['left', 'right', 'left', 'right', 'both'],
    patternIndex: 0,
    leftY: -200,
    rightY: -200,
    pauseUntil: 0,
    initialized: false,
    consumedThisBeat: new Set(),
  });

  // Session Tracking
  const sessionStartTimeRef = useRef<number>(0);
  const sessionEndedRef = useRef<boolean>(false);
  const totalEffectiveMSRef = useRef<number>(0);
  const totalPressureLRef = useRef<number>(0);
  const totalPressureRRef = useRef<number>(0);
  const totalSamplesRef = useRef<number>(0);
  const maxPressureRef = useRef<number>(0);
  const maxPressureLRef = useRef<number>(0);
  const maxPressureRRef = useRef<number>(0);
  const scoreRefs = useRef<{ global: number, p1: number, p2: number, p3: number, p4: number }>({ global: 0, p1: 0, p2: 0, p3: 0, p4: 0 });

  // UI elements
  const scoreTextRef = useRef<PIXI.Text | null>(null);
  const instructionTextRef = useRef<PIXI.Text | null>(null);
  const progressBarRef = useRef<PIXI.Graphics | null>(null);
  const timerTextRef = useRef<PIXI.Text | null>(null);

  // Ticker reference
  const tickerCbRef = useRef<(() => void) | null>(null);
  const applyThemeCountRef = useRef<number>(0);

  // 入場動畫狀態：物理在 entrance 期間暫停，避免 GSAP 動畫被 ticker 蓋掉
  const entranceCompleteRef = useRef<boolean>(false);

  useEffect(() => {
    stateRef.current = { config, pressure, pressures, isActive, durationSeconds };
  }, [config, pressure, pressures, isActive, durationSeconds]);

  useEffect(() => {
    if (isActive) {
      sessionStartTimeRef.current = performance.now();
      totalEffectiveMSRef.current = 0;
      sessionEndedRef.current = false;
      totalPressureLRef.current = 0;
      totalPressureRRef.current = 0;
      totalSamplesRef.current = 0;
      maxPressureRef.current = 0;
      maxPressureLRef.current = 0;
      maxPressureRRef.current = 0;
      scoreRefs.current = { global: 0, p1: 0, p2: 0, p3: 0, p4: 0 };

      // 重置物理狀態，讓入場動畫從乾淨狀態起跑
      entityPhysicsRef.current = {};
      entranceCompleteRef.current = false;
      playEntranceAnimation();
    } else {
      entranceCompleteRef.current = false;
    }
  }, [isActive]);

  // 入場動畫：物件從畫面底部緩慢升起，提供視覺追蹤訓練與心理預備時間
  const playEntranceAnimation = () => {
    const app = appRef.current;
    if (!app || !sessionContainerRef.current) {
      // app 尚未初始化 → 直接放行物理，避免卡住整個 session
      entranceCompleteRef.current = true;
      return;
    }
    const cfg = stateRef.current.config;
    if (!cfg) {
      entranceCompleteRef.current = true;
      return;
    }

    const entityIds = Object.keys(entitiesRef.current);
    if (entityIds.length === 0) {
      // 尚未建立實體 → 跳過入場
      entranceCompleteRef.current = true;
      return;
    }

    const screenH = app.screen.height;
    const entryDur = ANTICIPATION_MS / 1000;
    let maxDelay = 0;

    for (const ent of cfg.entities) {
      const c = entitiesRef.current[ent.id];
      if (!c) continue;
      const role = getEntityRole(ent);

      // 紀錄目標位置，從底部升起到該位置
      const targetX = c.x;
      const targetY = (role === 'mushroom' || role === 'obstacle')
        ? screenH * 0.2  // 升到指示燈下方等待掉落
        : c.y;           // basket / paddle / decoration 升到原本就位

      const delay = Math.random() * 0.4;
      maxDelay = Math.max(maxDelay, delay);

      c.x = targetX;
      c.y = screenH + 120;
      c.alpha = 0;

      gsap.to(c, {
        y: targetY,
        alpha: 1,
        duration: entryDur,
        ease: 'power2.out',
        delay,
      });
    }

    const totalMs = ANTICIPATION_MS + maxDelay * 1000 + 100;
    setTimeout(() => {
      entranceCompleteRef.current = true;
    }, totalMs);
  };

  const applyTheme = async (app: PIXI.Application, cfg: GameConfig) => {
    if (!sessionContainerRef.current) return;
    const currentCount = ++applyThemeCountRef.current;

    try {
      // Render mode: geometric (default, zero-latency) vs themed (load AI images)
      const renderMode = cfg.metadata.render_mode ?? 'geometric';
      const isThemed = renderMode === 'themed';

      // Background Image setup based on the first visually defined entity or config.bg_image_url
      const bgUrl = cfg.bg_image_url;
      let targetBgAlpha = 0.5;

      const bgEntity = cfg.entities.find(e => e.visual?.bg_alpha !== undefined);
      if (bgEntity && bgEntity.visual?.bg_alpha !== undefined) {
          targetBgAlpha = bgEntity.visual.bg_alpha;
      }

      if (isThemed && bgUrl) {
        // Themed mode：非同步載入背景，失敗自動 fallback 到深色底
        PIXI.Assets.load(bgUrl).then((bgTexture) => {
          if (currentCount !== applyThemeCountRef.current) return;
          if (!sessionContainerRef.current) return;

          if (!backgroundSpriteRef.current) {
            backgroundSpriteRef.current = new PIXI.Sprite(bgTexture);
            sessionContainerRef.current.addChildAt(backgroundSpriteRef.current, 0);
          } else {
            backgroundSpriteRef.current.texture = bgTexture;
          }
          const bg = backgroundSpriteRef.current;
          bg.anchor.set(0.5);
          bg.x = app.screen.width / 2;
          bg.y = app.screen.height / 2;
          const scale = Math.max(app.screen.width / bg.texture.width, app.screen.height / bg.texture.height);
          bg.scale.set(scale);
          bg.alpha = targetBgAlpha;
        }).catch((e) => {
          console.warn('[Theme] BG load failed, keeping dark background:', e);
          app.renderer.background.color = 0x111111;
        });
      } else {
        // Geometric mode 或無 bgUrl：使用深色背景，移除既有 BG sprite
        if (bgEntity && bgEntity.visual?.bg_alpha) {
          app.renderer.background.color = 0x111111;
        }
        if (backgroundSpriteRef.current) {
          sessionContainerRef.current.removeChild(backgroundSpriteRef.current);
          backgroundSpriteRef.current.destroy();
          backgroundSpriteRef.current = null;
        }
      }

      // Clear existing entities
      Object.keys(entitiesRef.current).forEach(id => {
        const c = entitiesRef.current[id];
        sessionContainerRef.current?.removeChild(c);
        c.destroy({ children: true });
      });
      entitiesRef.current = {};
      entityPhysicsRef.current = {};
      collisionCooldownRef.current = {};

      // Initialize Entities UI
      for (const ent of cfg.entities) {
        const container = new PIXI.Container() as any;
        container.id = ent.id;
        container.type = ent.type;
        container.role = ent.role;
        container.layout = ent.layout;
        container.sector = ent.sector;
        container.ball_binding = ent.ball_binding;
        
        const isMixedMode = cfg.metadata.interaction_type === 'MIXED';
        const isPawnEnt = ent.type === 'controllable_pawn';

        if (isMixedMode && isPawnEnt) {
          // MIXED: stack paddles vertically, P1 top / P2 bottom
          container.x = app.screen.width / 2;
          container.y = getMixedPawnY(getPawnPlayerSlot(ent), app.screen.height);
        } else if (cfg.metadata.interaction_type === 'SEQUENCE' && isPawnEnt) {
          // SEQUENCE: 所有 controllable_pawn(籃子/網/接物器)放在螢幕下方 75%、X 鎖在 sector 欄位中心,
          // 與落下的 target 共線(target 在 ticker 中也 snap 到欄位中心),確保視覺對齊。
          // 不分 role=basket/paddle/mushroom — AI 在 SEQUENCE_TURN 場景下這幾種 role 都被當接物器使用。
          container.x = getLayoutX({ ...ent, layout: 'center' }, app.screen.width, cfg.metadata.player_count ?? 1);
          container.y = app.screen.height * 0.75;
        } else {
          container.x = getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
          // 划龍舟船(team_*_all 綁定)從畫面最底端起步,入場動畫的 targetY 也跟著用 0.92
          // PULSE/NAVIGATE 等 pawn(打太鼓槌子、套圈圈球板) 放在 0.82 等鼓/物件落下;DRIVE 走自己的物理 init
          // SEQUENCE target 從上方 -200 起算,讓金魚明顯「從上往下掉」而非從中間出現
          const isTeamBoatInit = isPawnEnt && (ent.ball_binding || '').startsWith('team_');
          const isCatcherPawn = isPawnEnt && !isTeamBoatInit &&
            (ent.movement_logic?.atomic_action === 'PULSE' || ent.movement_logic?.atomic_action === 'NAVIGATE');
          const isSequenceFallTarget = cfg.metadata.interaction_type === 'SEQUENCE' && ent.type === 'target';
          container.y = isTeamBoatInit
            ? app.screen.height * 0.92
            : (isCatcherPawn ? app.screen.height * 0.82
              : (isSequenceFallTarget ? -200 : app.screen.height / 2));
        }
        container.visible = true;

        const shape = new PIXI.Graphics();
        const alpha = ent.visual?.alpha ?? 1.0;
        const role = getEntityRole(ent);

        if (role === 'mushroom') {
           // 紅色圓形 (蘑菇)
           shape.circle(0, 0, 45);
           shape.fill({ color: 0xFF0000, alpha });
           shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
        } else if (role === 'basket') {
           // 藍色中空矩形 (籃子) — 尺寸放大到能視覺包住 target 黃球 (直徑 100)，
           // 對齊邏輯依賴 container.y 一致即可（兩者都中心對稱繪製）。
           shape.rect(-70, -55, 140, 110);
           shape.fill({ color: 0x0000FF, alpha: 0.2 });
           shape.stroke({ width: 6, color: 0x0000FF, alpha: 1.0 });
        } else if (ent.type === 'controllable_pawn') {
           // 圓角矩形球板：MIXED 模式下兩位玩家用不同顏色
           const pawnColor = isMixedMode
             ? MIXED_PAWN_COLORS[getPawnPlayerSlot(ent)]
             : 0x00BFFF;
           // 球板寬度依玩家人數縮放,避免 4 人各帶左右手時兩支同欄槌子在窄欄寬下視覺重疊。
           // 同欄左右手距離 = 螢幕寬 / player_count × 0.6,paddle 寬須小於這個距離才不重疊。
           const playerCount = cfg.metadata.player_count ?? 1;
           const paddleWidth = playerCount >= 4 ? 110
                             : playerCount >= 3 ? 130
                             : 150;
           shape.roundRect(-paddleWidth / 2, -20, paddleWidth, 40, 20);
           shape.fill({ color: pawnColor, alpha });
           shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
        } else if (ent.type === 'obstacle' || role === 'obstacle') {
           // 障礙物:深灰色圓 + 白色 X 標記,與紅色 mushroom / 黃色 target 都明顯區別
           shape.circle(0, 0, 50);
           shape.fill({ color: 0x333333, alpha });
           shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
           shape.moveTo(-22, -22);
           shape.lineTo(22, 22);
           shape.moveTo(22, -22);
           shape.lineTo(-22, 22);
           shape.stroke({ width: 5, color: 0xFFFFFF, alpha: 1.0 });
        } else if (ent.type === 'target') {
           // MIXED 模式下用白底,於 ticker 中以 tint 動態切換藍/橘;其他模式維持黃色
           shape.circle(0, 0, 50);
           shape.fill({ color: isMixedMode ? 0xFFFFFF : 0xFFFF00, alpha });
           shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
        } else if (ent.type === 'static') {
           // role: decoration 視為背景占位,不產生幾何形狀(背景請走 metadata.bg_image_url)
           if (role !== 'decoration') {
              shape.rect(-200, -20, 400, 40);
              shape.fill({ color: 0x333333, alpha });
              shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
           }
        } else {
           shape.roundRect(-60, -60, 120, 120, 20);
           shape.fill({ color: 0xFF33CC, alpha });
           shape.stroke({ width: 6, color: 0x000000, alpha: 1.0 });
        }

        container.addChild(shape);

        // Themed mode：幾何打底已就位，async 換成 AI 主題圖片（含厚黑邊框 OutlineFilter）
        if (isThemed && ent.visual?.image_url) {
          const imageUrl = ent.visual.image_url;
          const themeAtAttempt = currentCount;
          PIXI.Assets.load(imageUrl).then((tex) => {
            if (themeAtAttempt !== applyThemeCountRef.current) return; // theme 已重置
            if (!entitiesRef.current[ent.id]) return; // entity 已被清除
            const sprite = new PIXI.Sprite(tex);
            sprite.anchor.set(0.5);
            // 配合幾何 placeholder 尺寸
            const role2 = getEntityRole(ent);
            if (role2 === 'paddle') { sprite.width = 150; sprite.height = 50; }
            else if (role2 === 'basket') { sprite.width = 140; sprite.height = 80; }
            else if (role2 === 'mushroom' || role2 === 'obstacle') { sprite.width = 100; sprite.height = 100; }
            else { sprite.width = 120; sprite.height = 120; }
            sprite.alpha = ent.visual?.alpha ?? 1.0;
            sprite.filters = [new OutlineFilter({ thickness: 4, color: 0x000000 })];
            container.removeChildren();
            container.addChild(sprite);
          }).catch((e) => {
            console.warn(`[Theme] image load failed for ${ent.id}, keeping geometric:`, e);
          });
        }

        // MIXED 模式：球初始為藍色、半徑縮一半，由 ticker 同步 tint/scale
        if (isMixedMode && (ent.type === 'target' || ent.type === 'obstacle')) {
          ballColorRef.current[ent.id] = 'blue';
          ballScaleRef.current[ent.id] = 0.5;
        }

        entitiesRef.current[ent.id] = container;
        sessionContainerRef.current.addChild(container);
      }

      // MIXED 模式：一次只出現 1 顆球，其餘隱藏
      if (cfg.metadata.interaction_type === 'MIXED') {
        let firstSeen = false;
        for (const ent of cfg.entities) {
          if (ent.type !== 'target' && ent.type !== 'obstacle') continue;
          const c = entitiesRef.current[ent.id];
          if (!c) continue;
          if (!firstSeen) { c.visible = true; firstSeen = true; }
          else c.visible = false;
        }
      }

      if (cfg.metadata.interaction_type === 'SEQUENCE') {
        for (const ent of cfg.entities) {
          const container = entitiesRef.current[ent.id];
          if (!container) continue;
          const layout = getEntityLayout(ent);
          if (layout === 'left' || layout === 'right') {
            container.x = getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
          }
        }
      }

      // Setup UI Text
      const instructionStr = `[${cfg.metadata.game_name}] 模式: ${cfg.metadata.interaction_type}`;
      if (!instructionTextRef.current) {
        instructionTextRef.current = new PIXI.Text({
          text: instructionStr,
          style: { fill: 0xffffff, fontSize: 20, fontWeight: 'bold' }
        });
        instructionTextRef.current.anchor.set(0.5, 0);
        sessionContainerRef.current.addChild(instructionTextRef.current);
      }
      instructionTextRef.current.text = instructionStr;
      instructionTextRef.current.x = app.screen.width / 2;
      instructionTextRef.current.y = 10;

      // 倒數計時文字(右上角),只在有 durationSeconds 時顯示
      if (!timerTextRef.current) {
        timerTextRef.current = new PIXI.Text({
          text: "",
          style: { fill: 0xffffff, fontSize: 22, fontWeight: 'bold' },
        });
        timerTextRef.current.anchor.set(1, 0); // 右上對齊
        sessionContainerRef.current.addChild(timerTextRef.current);
      }
      timerTextRef.current.x = app.screen.width - 16;
      timerTextRef.current.y = 10;
      timerTextRef.current.visible = !!durationSeconds;
      
      // Sequence Bulbs UI — 先清除上一次的 bulb container 避免疊加
      if (sequenceBulbContainerRef.current) {
        sessionContainerRef.current.removeChild(sequenceBulbContainerRef.current);
        sequenceBulbContainerRef.current.destroy({ children: true });
        sequenceBulbContainerRef.current = null;
        sequenceBulbsRef.current = [];
      }

      if (playerZonesRef.current) {
        sessionContainerRef.current.removeChild(playerZonesRef.current);
        playerZonesRef.current.destroy({ children: true });
        playerZonesRef.current = null;
      }

      if (cfg.metadata.interaction_type === 'SEQUENCE') {
        const zones = new PIXI.Container();
        const halfW = app.screen.width / 2;
        const fullH = app.screen.height;

        const leftZone = new PIXI.Graphics()
          .rect(0, 0, halfW, fullH)
          .fill({ color: 0x0066FF, alpha: 0.08 });
        const rightZone = new PIXI.Graphics()
          .rect(halfW, 0, halfW, fullH)
          .fill({ color: 0x00CC66, alpha: 0.08 });

        const leftLabel = new PIXI.Text({
          text: '玩家 1',
          style: { fill: 0x66B3FF, fontSize: 16, fontWeight: 'bold' }
        });
        leftLabel.anchor.set(0.5, 0);
        leftLabel.x = app.screen.width * 0.25;
        leftLabel.y = 90;

        const rightLabel = new PIXI.Text({
          text: '玩家 2',
          style: { fill: 0x66E699, fontSize: 16, fontWeight: 'bold' }
        });
        rightLabel.anchor.set(0.5, 0);
        rightLabel.x = app.screen.width * 0.75;
        rightLabel.y = 90;

        zones.addChild(leftZone, rightZone, leftLabel, rightLabel);
        sessionContainerRef.current.addChildAt(zones, 0);
        playerZonesRef.current = zones;

        const bulbLeft = new PIXI.Graphics().circle(-40, 0, 15).fill(0xFFFF00).stroke({width: 4, color: 0x000000});
        const bulbRight = new PIXI.Graphics().circle(40, 0, 15).fill(0xFFFF00).stroke({width: 4, color: 0x000000});

        const bulbContainer = new PIXI.Container();
        bulbContainer.addChild(bulbLeft, bulbRight);
        bulbContainer.x = app.screen.width / 2;
        bulbContainer.y = 50;
        sessionContainerRef.current.addChild(bulbContainer);

        sequenceBulbContainerRef.current = bulbContainer;
        sequenceBulbsRef.current = [bulbLeft, bulbRight];

        // 初始化記憶 pattern：AI 未提供時 fallback 到 1↔2 交替
        const pattern = cfg.metadata.sequence_pattern;
        sequencePatternRef.current = (pattern && pattern.length > 0)
          ? pattern.map(n => (n === 2 ? 2 : 1))
          : [1, 2];
        sequenceIndexRef.current = 0;
        sequenceStepRef.current = sequencePatternRef.current[0];
        bulbLeft.alpha = sequenceStepRef.current === 1 ? 1.0 : 0.2;
        bulbRight.alpha = sequenceStepRef.current === 2 ? 1.0 : 0.2;
      }

      // Ensure background is always at index 0
      if (backgroundSpriteRef.current && sessionContainerRef.current) {
        if (sessionContainerRef.current.children.includes(backgroundSpriteRef.current)) {
          sessionContainerRef.current.setChildIndex(backgroundSpriteRef.current, 0);
        }
      }
      
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const setup = async () => {
      const app = await getOrInitApp();
      if (!isMounted || !containerRef.current) return;

      if (app.canvas.parentNode !== containerRef.current) {
        containerRef.current.appendChild(app.canvas);
        app.resizeTo = containerRef.current;
        app.resize();
      }
      appRef.current = app;

      if (!sessionContainerRef.current) {
        const sessionContainer = new PIXI.Container();
        app.stage.addChild(sessionContainer);
        sessionContainerRef.current = sessionContainer;
      }

      const tickerCb = () => {
        const { config: cfg, pressure: prs, pressures: allPrs, isActive: active, durationSeconds: dur } = stateRef.current;
        if (!sessionContainerRef.current || !app) return;

        const isCalibration = cfg.metadata.game_id === 'calibration';
        const normalizedPrs = isCalibration ? prs : {
          left: prs.left / (mvcL || 1.0),
          right: prs.right / (mvcR || 1.0)
        };

        if (!active) {
            return;
        }

        // 入場期間暫停物理與計分，讓 GSAP 動畫順暢、長輩有預備時間
        if (!entranceCompleteRef.current) {
            return;
        }

        // --- 倒數計時 ---
        if (dur && dur > 0 && !sessionEndedRef.current) {
            const elapsedSec = (performance.now() - sessionStartTimeRef.current) / 1000;
            const remainingSec = Math.max(0, dur - elapsedSec);

            if (timerTextRef.current) {
                const m = Math.floor(remainingSec / 60);
                const s = Math.floor(remainingSec % 60);
                timerTextRef.current.text = `⏱ ${m}:${s.toString().padStart(2, '0')}`;
                // 最後 10 秒紅色警示
                timerTextRef.current.style.fill = remainingSec <= 10 ? 0xff5555 : 0xffffff;
            }

            if (remainingSec <= 0) {
                // 時間到 → 觸發 session end(同 GAME_WIN 流程)
                if (instructionTextRef.current) {
                    instructionTextRef.current.text = `⏱ 時間到!最終分數: ${scoreRefs.current.global}`;
                }
                sessionEndedRef.current = false;
                const totalDuration = (performance.now() - sessionStartTimeRef.current) / 1000;
                onSessionEnd({
                    effectiveSeconds: totalEffectiveMSRef.current / 1000,
                    totalSeconds: totalDuration,
                    avgPressureL: totalPressureLRef.current / Math.max(1, totalSamplesRef.current),
                    avgPressureR: totalPressureRRef.current / Math.max(1, totalSamplesRef.current),
                    maxPressure: maxPressureRef.current,
                    maxPressureL: maxPressureLRef.current,
                    maxPressureR: maxPressureRRef.current,
                    compensationOccurred: false,
                    clinical_tags: collectClinicalTags(cfg),
                });
                sessionEndedRef.current = true;
                return;
            }
        }

        // Data Collection
        totalPressureLRef.current += prs.left;
        totalPressureRRef.current += prs.right;
        totalSamplesRef.current += 1;

        const currentMax = Math.max(prs.left, prs.right);
        if (currentMax > maxPressureRef.current) maxPressureRef.current = Math.min(1.0, currentMax);
        if (prs.left > maxPressureLRef.current) maxPressureLRef.current = Math.min(1.0, prs.left);
        if (prs.right > maxPressureRRef.current) maxPressureRRef.current = Math.min(1.0, prs.right); // Timer has been removed; session lasts indefinitely until user stops it manually.

        // --- 太鼓同步節拍計算 ---
        // 顯式 opt-in:metadata.taiko_sync_pattern 為 ['left'|'right'|'both'] 陣列且非空 → 啟用同步
        const taikoUserPattern = (cfg.metadata.taiko_sync_pattern ?? []).filter(
            (p): p is 'left' | 'right' | 'both' => p === 'left' || p === 'right' || p === 'both'
        );
        const isTaikoMode = taikoUserPattern.length > 0;

        if (isTaikoMode) {
            const sync = taikoSyncRef.current;
            if (!sync.initialized) {
                sync.pattern = taikoUserPattern;
                sync.patternIndex = 0;
                sync.leftY = -200;
                sync.rightY = -200;
                sync.pauseUntil = 0;
                sync.initialized = true;
            }
            const nowMs = performance.now();
            if (nowMs >= sync.pauseUntil) {
                const taikoFallSpeed = 170; // px/s,放慢以拉長反應窗口
                const dtSec = app.ticker.deltaMS / 1000;
                const beat = sync.pattern[sync.patternIndex];
                if (beat === 'left' || beat === 'both') sync.leftY += taikoFallSpeed * dtSec;
                if (beat === 'right' || beat === 'both') sync.rightY += taikoFallSpeed * dtSec;
                // 當前拍是否完成(active 那一邊已通過底)
                const checkY = beat === 'right' ? sync.rightY : sync.leftY;
                if (checkY > app.screen.height + 100) {
                    sync.patternIndex = (sync.patternIndex + 1) % sync.pattern.length;
                    sync.leftY = -200;
                    sync.rightY = -200;
                    sync.consumedThisBeat.clear(); // 換拍 → 重新讓所有 drum 可被擊中
                    // 'both' 拍後給較長休止讓玩家換氣
                    sync.pauseUntil = nowMs + (beat === 'both' ? 700 : 400);
                }
            }
        }

        // --- Execute Atomic Actions ---
        for (const ent of cfg.entities) {
             const container = entitiesRef.current[ent.id];
             if (!container) continue;

             // MIXED 模式：隱藏的球完全跳過 (一次只出現 1 顆)
             if (cfg.metadata.interaction_type === 'MIXED'
                 && (ent.type === 'target' || ent.type === 'obstacle')
                 && !container.visible) {
                 continue;
             }

             const isPawn = ent.type === 'controllable_pawn';
             const action = ent.movement_logic?.atomic_action;

             if (getEntityRole(ent) === 'basket') {
                 // 從 ball_binding(而非 layout)解析該 basket 對應的玩家壓力 — 新版 SEQUENCE_TURN 用 layout: center,
                 // 不能再靠 layout==='left/right' 取 pIds[0/1]。直接複用 binding resolver 邏輯(支援 p{N}_both/left/right)。
                 const pIds = Object.keys(allPrs || {});
                 let playerPrs = { left: 0, right: 0 };
                 const binding = ent.ball_binding;
                 const bMatch = binding ? binding.match(/^p(\d+)_(left|right|both)$/) : null;
                 if (bMatch) {
                     const idx = parseInt(bMatch[1], 10) - 1;
                     if (idx >= 0 && idx < pIds.length) {
                         const pId = pIds[idx];
                         playerPrs = {
                             left: (allPrs![pId]?.left ?? 0) / (mvcL || 1.0),
                             right: (allPrs![pId]?.right ?? 0) / (mvcR || 1.0)
                         };
                     }
                 }

                 const threshold = 0.2;
                 const leftActive = playerPrs.left > threshold;
                 const rightActive = playerPrs.right > threshold;
                 const avgActVal = (playerPrs.left + playerPrs.right) / 2;

                 // SEQUENCE 模式:設 hasFired 旗標讓 SCORE_HIT 碰撞防呆生效(必須握壓才算撈到)
                 // hasFired 在握壓 >= 0.2 時設 true,放鬆 < 0.08 重置(配合 SEQUENCE atomic_action 設計)
                 if (cfg.metadata.interaction_type === 'SEQUENCE') {
                     if (!entityPhysicsRef.current[ent.id]) {
                         entityPhysicsRef.current[ent.id] = { vy: 0, vx: 0, lastY: container.y, lastX: container.x, hasFired: false };
                     }
                     const bp = entityPhysicsRef.current[ent.id];
                     if (avgActVal >= 0.2 && !bp.hasFired) {
                         bp.hasFired = true;
                         gsap.killTweensOf(container.scale);
                         gsap.to(container.scale, { x: 1.5, y: 1.5, duration: 0.15, yoyo: true, repeat: 1, overwrite: 'auto', onComplete: () => container.scale.set(1, 1) });
                     } else if (avgActVal < 0.08 && bp.hasFired) {
                         bp.hasFired = false;
                     }
                     continue; // basket 在 SEQUENCE 模式不需走 atomic_action,只需 hasFired
                 }

                 // 非 SEQUENCE 模式:沿用原本的 scale/rotation 視覺回饋
                 if (leftActive && rightActive) {
                     container.scale.set(1 + avgActVal * 0.8);
                     container.rotation += (0 - container.rotation) * 0.2;
                 } else if (leftActive) {
                     container.scale.set(1 + (container.scale.x - 1) * 0.8);
                     container.rotation += (-playerPrs.left * 0.5 - container.rotation) * 0.2;
                 } else if (rightActive) {
                     container.scale.set(1 + (container.scale.x - 1) * 0.8);
                     container.rotation += (playerPrs.right * 0.5 - container.rotation) * 0.2;
                 } else {
                     container.scale.set(1 + (container.scale.x - 1) * 0.8);
                     container.rotation += (0 - container.rotation) * 0.2;
                 }
                 continue;
             }

             if (!action) continue;

             if (!entityPhysicsRef.current[ent.id]) {
                 let initY = app.screen.height / 2;
                 let initX = getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
                 const initLayout = getEntityLayout(ent);

                 if (action === 'DRIVE' || ent.type === 'obstacle' || ent.type === 'target') {
                     // 入場動畫已將 target/obstacle 升到 screen*0.2，從該位置接續掉落以避免閃跳
                     // 划龍舟船(team_*_all 綁定)從畫面最底端起步,符合「終點線在頂、船從岸邊出發」的語意
                     const isTeamBoatStart = ent.type === 'controllable_pawn' && (ent.ball_binding || '').startsWith('team_');
                     initY = (ent.type === 'obstacle' || ent.type === 'target')
                         ? container.y
                         : (isTeamBoatStart ? app.screen.height * 0.92 : app.screen.height * 0.8);
                     if (ent.type === 'obstacle' || ent.type === 'target') {
                         if (initLayout === 'right' && cfg.metadata.interaction_type === 'SEQUENCE') {
                             initY = -600; // SEQUENCE 模式右邊錯開掉落時間
                         } else if (initLayout === 'center') {
                             initX = app.screen.width / 2;
                         }
                     }
                 }
                 
                 let vy: number;
                 let vx: number;
                 if (ent.type === 'target') {
                     vy = 120; // Constant downward speed
                     vx = 0;
                 } else if (isPawn) {
                     vy = 0;
                     vx = 0;
                 } else {
                     vy = (200 + Math.random() * 200) * (Math.random() > 0.5 ? 1 : -1);
                     vx = (200 + Math.random() * 200) * (Math.random() > 0.5 ? 1 : -1);
                 }

                 entityPhysicsRef.current[ent.id] = { vy, vx, lastY: initY, lastX: initX, hasFired: false };
             }
             const phys = entityPhysicsRef.current[ent.id];

             if (ent.movement_logic) {
                 // SEQUENCE 模式下強制 controllable_pawn 使用 SEQUENCE atomic_action,
                 // 避免 AI 誤寫 PULSE 導致 basket 對同 sector target 施加向上衝量(視覺上 target 會被彈飛/亂跳)。
                 const isSequencePawn = cfg.metadata.interaction_type === 'SEQUENCE' && ent.type === 'controllable_pawn';
                 const action = isSequencePawn ? 'SEQUENCE' : ent.movement_logic.atomic_action;
                 const axis = ent.movement_logic.axis;

                 // --- Binding resolver ---
                 // 新格式: "p{N}_{left|right|both}" 例: "p3_left" = 第 3 位玩家左手
                 // 舊格式相容: "ball_1"/"p1"/"player_1" → 該玩家雙手平均;
                 //            "left"/"right" → 全域 fallback 的單手;
                 //            "shared"/未填 → 全域平均
                 let actVal = 0;
                 let entPrs = normalizedPrs;
                 let handMode: 'left' | 'right' | 'both' = 'both';

                 const binding = ent.ball_binding;
                 const pIds = Object.keys(allPrs || {});

                 if (binding) {
                     // team_a_all / team_b_all 依 player_count 動態分隊:
                     //   2 人 → team_a=[P1]、team_b=[P2](一人一船)
                     //   4 人 → team_a=[P1,P2]、team_b=[P3,P4](兩人一船)
                     //   3 人 → team_a=[P1,P2]、team_b=[P3](lopsided 但可運行)
                     // 採 raw sum 語意:1 人隊 max=1.0,2 人隊 max=2.0,合作越多船越快。
                     const teamMatch = binding.match(/^team_([ab])_all$/);
                     const m = teamMatch ? null : binding.match(/^p(\d+)_(left|right|both)$/);
                     if (teamMatch) {
                         const splitIdx = Math.ceil(pIds.length / 2);
                         const from = teamMatch[1] === 'a' ? 0 : splitIdx;
                         const to = teamMatch[1] === 'a' ? splitIdx : pIds.length;
                         let teamSum = 0;
                         let memberCount = 0;
                         for (let i = from; i < to; i++) {
                             const pId = pIds[i];
                             const pAvg = ((allPrs![pId].left / (mvcL || 1.0)) + (allPrs![pId].right / (mvcR || 1.0))) / 2;
                             teamSum += pAvg;
                             memberCount++;
                         }
                         if (memberCount > 0) {
                             entPrs = { left: teamSum, right: teamSum };
                             handMode = 'both';
                         }
                         // 沒有玩家 → 沿用 fallback
                     } else if (m) {
                         const idx = parseInt(m[1], 10) - 1;
                         if (idx >= 0 && idx < pIds.length) {
                             const pId = pIds[idx];
                             entPrs = {
                                 left: allPrs![pId].left / (mvcL || 1.0),
                                 right: allPrs![pId].right / (mvcR || 1.0),
                             };
                             handMode = m[2] as 'left' | 'right' | 'both';
                         } else {
                             // 索引超界(綁定指向未連線玩家) → 顯式給 0 壓力,
                             // 避免 fallback 到 normalizedPrs 讓 P2 basket 偷讀 P1 sensor 造成「P2 壓 → 兩框都變大」。
                             entPrs = { left: 0, right: 0 };
                             handMode = m[2] as 'left' | 'right' | 'both';
                         }
                     } else {
                         // 舊格式: 玩家編號(ball_N / p{N} / player_N)
                         const legacyP = binding.match(/^(?:ball|p|player)_?(\d+)$/);
                         if (legacyP) {
                             const idx = parseInt(legacyP[1], 10) - 1;
                             if (idx >= 0 && idx < pIds.length) {
                                 const pId = pIds[idx];
                                 entPrs = {
                                     left: allPrs![pId].left / (mvcL || 1.0),
                                     right: allPrs![pId].right / (mvcR || 1.0),
                                 };
                             }
                         } else if (binding === 'left' || binding === 'right') {
                             handMode = binding;
                         }
                         // 'shared' 或未識別 → 維持 fallback(全域平均)
                     }
                 }

                 if (handMode === 'left') actVal = entPrs.left;
                 else if (handMode === 'right') actVal = entPrs.right;
                 else actVal = (entPrs.left + entPrs.right) / 2;

                 if (action === 'DRIVE') {
                     // Map pressure to Y-axis acceleration (against gravity)
                     const gravity = (cfg.global_physics?.gravity_vector?.[1] !== undefined) ? cfg.global_physics.gravity_vector[1] : 1500; // px/s^2 down
                     const multiplier = ent.movement_logic?.multiplier ?? 1.0;

                     // 如果是障礙物且沒有綁定，就給 0 推力 (使其如水母般純靠重力或預設速度飄落)
                     const isAutonomousObstacle = (ent.type === 'obstacle' || ent.type === 'target') && !ent.ball_binding && !ent.sector;
                     // 划槳模式:team_*_all binding 的 pawn 改用 rising-edge impulse(不能一直握),模擬划槳節奏。
                     // 連續按住不會持續加速 — 必須放鬆到 reset 閾值才能再次划動。
                     const isRowing = isPawn && (ent.ball_binding || '').startsWith('team_');
                     let thrust = isAutonomousObstacle ? 0 : actVal * 3500 * multiplier; // px/s^2 up
                     if (isRowing) {
                         thrust = 0; // 划槳模式不吃連續推力
                         const strokeThreshold = 0.4;
                         const requireResetThreshold = 0.15;
                         if (actVal > strokeThreshold && !phys.hasFired) {
                             phys.hasFired = true;
                             // 一次划動 → 直接修改 vy 給向上衝量;配合下方的 damping 會自然減速,需要持續划才能前進。
                             phys.vy -= 700 * actVal * multiplier;
                             gsap.to(container.scale, { x: 1.15, y: 1.15, duration: 0.15, yoyo: true, repeat: 1 });
                         } else if (actVal < requireResetThreshold && phys.hasFired) {
                             phys.hasFired = false;
                         }
                     }
                     
                     const deltaSec = app.ticker.deltaMS / 1000;
                     
                     if (ent.type !== 'target' && ent.type !== 'obstacle') {
                         if (isRowing) {
                             // 划槳模式無重力,只有水阻尼讓 vy 自然衰減,船不會下沉
                             phys.vy *= 0.92;
                         } else {
                             phys.vy += (gravity - thrust) * deltaSec;
                             phys.vy *= 0.95; // air resistance damping
                         }
                         phys.lastY += phys.vy * deltaSec;

                         if (phys.lastY > app.screen.height + 150) {
                             phys.lastY = app.screen.height - 100;
                             phys.vy = 0;
                         }
                         if (phys.lastY < 100) {
                             phys.lastY = 100;
                             phys.vy = 0;
                         }
                         
                         if (cfg.metadata.interaction_type === 'MIXED' && isPawn) {
                             // MIXED: lock paddle to assigned top/bottom slot, centered horizontally (lerp 平滑感測器抖動)
                             container.x = lerp(container.x, app.screen.width / 2, 0.25);
                             container.y = lerp(container.y, getMixedPawnY(getPawnPlayerSlot(ent), app.screen.height), 0.25);
                         } else {
                             // 平滑插值：避免壓力跳動造成畫面閃爍
                             container.y = lerp(container.y, phys.lastY, 0.25);
                             container.x = lerp(container.x, getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1), 0.25);
                         }
                     }
                     
                     if (axis === 'SCALE') {
                         container.scale.set(1 + actVal * 2);
                     }
                 } else if (action === 'PULSE') {
                     const threshold = 0.4;
                     const requireResetThreshold = 0.1;

                     // Require Reset Logic for Burst
                     if (actVal > threshold && !phys.hasFired) {
                         phys.hasFired = true;
                         // overwrite + onComplete 強制收斂回 (1,1)。額外預先 reset 一次,避免上一輪 onComplete
                         // 被 killTweensOf 切掉時 scale 卡在 2.0 不還原。
                         gsap.killTweensOf(container.scale);
                         container.scale.set(1, 1);
                         gsap.to(container.scale, {
                             x: 2.0, y: 2.0, duration: 0.15, yoyo: true, repeat: 1,
                             overwrite: 'auto',
                             onComplete: () => container.scale.set(1, 1),
                         });

                         // 真正打出衝量：對同 sector + 同 layout 的 target/obstacle 施加初速
                         // (左手只彈左、右手只彈右;layout='center' 視為共享,雙手皆可影響)
                         const multiplier = ent.movement_logic?.multiplier ?? 1.0;
                         const impulseY = -1200 * actVal * multiplier; // 負號 = 向上飛
                         const pawnSector = getEntitySector(ent);
                         const pawnLayout = getEntityLayout(ent);
                         for (const otherEnt of cfg.entities) {
                             if (otherEnt.type !== 'target' && otherEnt.type !== 'obstacle') continue;
                             const otherSector = getEntitySector(otherEnt);
                             // sector 不匹配且雙方都不是 shared → 不影響別人的球
                             if (pawnSector !== 'shared' && otherSector !== 'shared' && pawnSector !== otherSector) continue;
                             // layout 都明確且不同 → skip(左手不彈右側鼓)
                             const otherLayout = getEntityLayout(otherEnt);
                             const pawnSideExplicit = pawnLayout === 'left' || pawnLayout === 'right';
                             const otherSideExplicit = otherLayout === 'left' || otherLayout === 'right';
                             if (pawnSideExplicit && otherSideExplicit && pawnLayout !== otherLayout) continue;
                             const otherPhys = entityPhysicsRef.current[otherEnt.id];
                             if (otherPhys) {
                                 otherPhys.vy = impulseY;
                                 // 視覺回饋：被擊中物件閃爍縮放
                                 const otherC = entitiesRef.current[otherEnt.id];
                                 if (otherC) {
                                     gsap.killTweensOf(otherC.scale);
                                     otherC.scale.set(1, 1); // 預先 reset,避免上輪 onComplete 被切掉時鼓卡在 1.3
                                     gsap.to(otherC.scale, {
                                         x: 1.3, y: 1.3, duration: 0.1, yoyo: true, repeat: 1,
                                         overwrite: 'auto',
                                         onComplete: () => otherC.scale.set(1, 1),
                                     });
                                 }
                             }
                         }
                     } else if (actVal < requireResetThreshold && phys.hasFired) {
                         phys.hasFired = false; // Reset complete
                     }
                 } else if (action === 'NAVIGATE') {
                     const diff = entPrs.right - entPrs.left;
                     if (isNaN(diff)) continue;
                     const rawTargetX = app.screen.width / 2 + (diff * (app.screen.width * 0.4));
                     // 球板半寬（含描邊）+ 邊緣裕度，避免移動過快超出畫面
                     const halfPawn = 75 + 6;
                     const minX = halfPawn;
                     const maxX = app.screen.width - halfPawn;
                     const targetX = Math.max(minX, Math.min(maxX, rawTargetX));
                     // Smooth interpolation for X-axis mapping
                     container.x += (targetX - container.x) * 0.2;
                     container.x = Math.max(minX, Math.min(maxX, container.x));

                     if (cfg.metadata.interaction_type === 'MIXED' && isPawn) {
                         // MIXED: lock paddle to its assigned top/bottom slot (lerp 平滑度假感)
                         container.y = lerp(container.y, getMixedPawnY(getPawnPlayerSlot(ent), app.screen.height), 0.25);
                     } else if (cfg.metadata.interaction_type === 'SEQUENCE' && isPawn && getEntityRole(ent) === 'basket') {
                         container.y = lerp(container.y, app.screen.height * 0.75, 0.25);
                     } else {
                         container.y = lerp(container.y, app.screen.height / 2, 0.25);
                     }
                 } else if (action === 'SEQUENCE' && isPawn) {
                     // 長輩握力較弱,門檻 0.2 + 用 >= 確保最低握壓也能觸發。
                     const threshold = 0.2;
                     const requireResetThreshold = 0.08;
                     if (actVal >= threshold && !phys.hasFired) {
                         phys.hasFired = true;
                         gsap.to(container.scale, { x: 1.5, y: 1.5, duration: 0.15, yoyo: true, repeat: 1 });
                     } else if (actVal < requireResetThreshold && phys.hasFired) {
                         phys.hasFired = false;
                     }
                 }
                 
                 // --- Unified Target Drop Logic ---
                 // 強制所有 target / obstacle 啟動掉落物理，忽略 AI 錯誤配置的 fallback
                 if (ent.type === 'target' || ent.type === 'obstacle') {
                     const deltaSec = app.ticker.deltaMS / 1000;
                     const isMixedDrop = cfg.metadata.interaction_type === 'MIXED';

                     // 划龍舟模式:DRIVE + 有 team_*_all 綁定的船 → finish_line 固定在頂端不掉落
                     const isTeamRace = cfg.metadata.interaction_type === 'DRIVE' &&
                         (cfg.entities ?? []).some(e => e.type === 'controllable_pawn' && (e.ball_binding || '').startsWith('team_'));
                     if (isTeamRace && ent.type === 'target') {
                         const targetY = app.screen.height * 0.12;
                         phys.lastY = targetY;
                         phys.vy = 0;
                         container.y = lerp(container.y, targetY, 0.15);
                         container.x = lerp(container.x, getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1), 0.25);
                         continue;
                     }

                     // 太鼓同步:同 layout 的 target 共用 sync.leftY/rightY,X 仍照 sector+layout 各自分欄
                     if (isTaikoMode && ent.type === 'target') {
                         const lay = getEntityLayout(ent);
                         if (lay === 'left' || lay === 'right') {
                             const sync = taikoSyncRef.current;
                             // 被 PULSE 衝量擊中後 vy < 0,讓物理迴圈處理彈跳(向上飛 + 重力落回),不鎖 Y。
                             // 待 vy 回正(衝量耗盡)後,若已標記 consumedThisBeat 才隱藏;否則回歸同步落下。
                             const isBouncing = phys.vy !== undefined && phys.vy < 0;
                             if (isBouncing) {
                                 container.visible = true;
                                 // X 仍鎖在欄位,Y 留給下方 fall logic 處理(套重力後會自然落回 baseFallSpeed)
                                 container.x = getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
                                 // 不 continue,讓下方等速下墜邏輯接管 vy 與 phys.lastY
                             } else if (sync.consumedThisBeat.has(ent.id)) {
                                 // 本拍已擊中且彈跳結束 → 隱藏(下一拍重置時 consumedThisBeat 會 clear)
                                 container.visible = false;
                                 continue;
                             } else {
                                 container.visible = true;
                                 const groupY = lay === 'left' ? sync.leftY : sync.rightY;
                                 phys.lastY = groupY;
                                 phys.vy = 0;
                                 container.y = groupY;
                                 container.x = getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
                                 continue;
                             }
                         }
                     }

                     if (isMixedDrop) {
                         // 平面玩：2D 等速運動，四面牆反彈，不重生
                         const speed = 320;
                         if (phys.vx === undefined || phys.vy === undefined || (phys.vx === 0 && phys.vy === 0)) {
                             // 避開 0.5π 附近（純垂直）造成的「上下狂跳、水平龜速」
                             // 兩段區間：[0.1π, 0.4π] ∪ [0.6π, 0.9π]，水平分量保證 ≥ sin(0.1π)·speed ≈ 99 px/s
                             const half = Math.random() * 0.3 + 0.1; // 0.1 ~ 0.4
                             const angle = (Math.random() < 0.5 ? half : 1 - half) * Math.PI;
                             phys.vx = Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1);
                             phys.vy = Math.sin(angle) * speed;
                         }
                         phys.lastX += phys.vx * deltaSec;
                         phys.lastY += phys.vy * deltaSec;

                         const radius = 50 * (ballScaleRef.current[ent.id] ?? 0.5);
                         if (phys.lastX < radius) { phys.lastX = radius; phys.vx = Math.abs(phys.vx); }
                         else if (phys.lastX > app.screen.width - radius) { phys.lastX = app.screen.width - radius; phys.vx = -Math.abs(phys.vx); }
                         if (phys.lastY < radius) { phys.lastY = radius; phys.vy = Math.abs(phys.vy); }
                         else if (phys.lastY > app.screen.height - radius) { phys.lastY = app.screen.height - radius; phys.vy = -Math.abs(phys.vy); }

                         container.x = phys.lastX;
                         container.y = phys.lastY;

                         // 同步球顏色與大小（碰球板不變大小，僅反彈與變色）
                         const tint = MIXED_BALL_COLORS[ballColorRef.current[ent.id] || 'blue'];
                         container.children.forEach((c: any) => { if ('tint' in c) c.tint = tint; });
                         container.scale.set(ballScaleRef.current[ent.id] ?? 0.5);
                     } else {
                         // 其他模式：等速下墜 + 從上方重生
                         const isSequenceTarget = cfg.metadata.interaction_type === 'SEQUENCE' && ent.type === 'target';
                         const targetCount = cfg.entities.filter(e => e.type === 'target').length;
                         const targetSector = getEntitySector(ent);
                         const hasOwnSector = targetSector === 'p1' || targetSector === 'p2' || targetSector === 'p3' || targetSector === 'p4';
                         const seqPlayerCount = cfg.metadata.player_count ?? 2;
                         const isMultiTargetSequence = isSequenceTarget && targetCount > 1 && hasOwnSector;

                         // 計算欄位 X(下方落下邏輯與顯示都需要)
                         let sequenceTargetX: number;
                         if (isMultiTargetSequence) {
                             if (seqPlayerCount >= 3) {
                                 sequenceTargetX = getLayoutX({ ...ent, layout: 'center' }, app.screen.width, seqPlayerCount);
                             } else {
                                 sequenceTargetX = targetSector === 'p2'
                                     ? app.screen.width * 0.75
                                     : app.screen.width * 0.25;
                             }
                         } else {
                             sequenceTargetX = sequenceStepRef.current === 2
                                 ? app.screen.width * 0.75
                                 : app.screen.width * 0.25;
                         }

                         // 輪替顯示:多目標 SEQUENCE 模式下,只顯示與當前 step 匹配 sector 的 target,
                         // 不在輪次的金魚停在頂端待機(避免「同時掉下、同時搶接」的混亂視覺)。
                         if (isMultiTargetSequence) {
                             const currentStepSector = `p${sequenceStepRef.current}`;
                             const isMyTurn = targetSector === currentStepSector;
                             container.visible = isMyTurn;
                             if (!isMyTurn) {
                                 phys.lastY = -200;
                                 phys.vy = 0;
                                 phys.lastX = sequenceTargetX;
                                 container.y = phys.lastY;
                                 container.x = phys.lastX;
                                 continue;
                             }
                         }

                         // SEQUENCE 模式刻意放慢,給玩家足夠時間看清楚下一步該誰接
                         const baseFallSpeed = cfg.metadata.interaction_type === 'SEQUENCE' ? 100 : 180;
                         // PULSE 衝量會把 vy 設為負(向上)。若仍是負,套重力讓它自然落回;
                         // 落回 baseFallSpeed 後就回到等速下墜,避免無限加速。
                         if (phys.vy === undefined || phys.vy >= 0) {
                             phys.vy = baseFallSpeed;
                         } else {
                             const gravity = 600;
                             phys.vy = Math.min(phys.vy + gravity * deltaSec, baseFallSpeed);
                         }
                         phys.lastY += phys.vy * deltaSec;

                         if (phys.lastY > app.screen.height + 150) {
                             phys.lastY = -200;
                             phys.lastX = isSequenceTarget ? sequenceTargetX : getLayoutX(ent, app.screen.width, cfg.metadata.player_count ?? 1);
                         }

                         if (isSequenceTarget) {
                             phys.lastX = lerp(phys.lastX, sequenceTargetX, 0.08);
                         }

                         container.y = phys.lastY;
                         container.x = phys.lastX;
                     }
                 }
                 
                 // Sync physics X/Y for pawns
                 if (isPawn) {
                     phys.lastX = container.x;
                     phys.lastY = container.y;
                 }
             }

             // --- Generic Physics (Bouncing) for non-pawns ---
             const isFallingObject = ent.type === 'target' || ent.type === 'obstacle';
             if (!isPawn && ent.movement_logic?.atomic_action !== 'DRIVE' && !isFallingObject) {
                 const dt = app.ticker.deltaMS / 1000;
                 phys.lastX += (phys.vx || 0) * dt;
                 phys.lastY += (phys.vy || 0) * dt;
                 
                 const halfW = (container.width || 100) / 2;
                 const halfH = (container.height || 100) / 2;
                 
                 // Screen bounds bounce
                 if (phys.lastX < halfW) { phys.lastX = halfW; phys.vx *= -1; }
                 if (phys.lastX > app.screen.width - halfW) { phys.lastX = app.screen.width - halfW; phys.vx *= -1; }
                 if (phys.lastY < halfH) { phys.lastY = halfH; phys.vy *= -1; }
                 if (phys.lastY > app.screen.height - halfH) { phys.lastY = app.screen.height - halfH; phys.vy *= -1; }
                 
                 container.x = phys.lastX;
                 container.y = phys.lastY;
             }

             // Handle calibration UI override
             if (isCalibration) {
                 container.x = app.screen.width / 2;
                 container.scale.set(1 + ((normalizedPrs.left + normalizedPrs.right) / 2) * 2);
             }
        }
        
        // Update Sequence Bulbs globally
        if (sequenceBulbsRef.current.length === 2) {
            const currentStep = sequenceStepRef.current;
            sequenceBulbsRef.current[0].alpha = currentStep === 1 ? 1.0 : 0.2;
            sequenceBulbsRef.current[1].alpha = currentStep === 2 ? 1.0 : 0.2;
        }
        
        // --- MIXED 模式專用碰撞 (球板 vs 球，依顏色匹配計分) ---
        if (cfg.metadata.interaction_type === 'MIXED') {
            const now = performance.now();
            const allEnts = Object.values(entitiesRef.current) as any[];
            const pawns = allEnts.filter(c => c.type === 'controllable_pawn' && c.visible);
            const balls = allEnts.filter(c => (c.type === 'target' || c.type === 'obstacle') && c.visible);

            const updateMixedScoreText = () => {
                if (!instructionTextRef.current) return;
                const actPIds = Object.keys(allPrs || {});
                let scoreStr = `分數: ${Math.max(0, scoreRefs.current.global)}`;
                if (actPIds.length > 1) {
                    const playerN = Math.min(4, Math.max(actPIds.length, cfg.metadata.player_count ?? 2));
                    const parts: string[] = [];
                    for (let i = 1; i <= playerN; i++) {
                        const key = ('p' + i) as 'p1' | 'p2' | 'p3' | 'p4';
                        parts.push(`P${i}: ${Math.max(0, scoreRefs.current[key])}`);
                    }
                    scoreStr = `多人分數 - ${parts.join(' | ')}`;
                }
                instructionTextRef.current.text = `[${cfg.metadata.game_name}] 模式: ${cfg.metadata.interaction_type} | ${scoreStr}`;
            };

            pawns.forEach(pawn => {
                balls.forEach(ball => {
                    const key = `mixed_${pawn.id}_${ball.id}`;
                    const last = collisionCooldownRef.current[key] || 0;
                    if (now - last < 500) return;

                    // 圓 (球) vs AABB (球板) 精確碰撞
                    const pb = pawn.getBounds();
                    const ballRadius = 50 * (ballScaleRef.current[ball.id] ?? 0.5);
                    const nearestX = Math.max(pb.x, Math.min(ball.x, pb.x + pb.width));
                    const nearestY = Math.max(pb.y, Math.min(ball.y, pb.y + pb.height));
                    const dx = ball.x - nearestX;
                    const dy = ball.y - nearestY;
                    if (dx * dx + dy * dy >= ballRadius * ballRadius) return;

                    collisionCooldownRef.current[key] = now;

                    const pawnCol = pawnSlotToBallColor(getPawnPlayerSlot(pawn));
                    const ballCol = ballColorRef.current[ball.id] || 'blue';
                    const ballPhys = entityPhysicsRef.current[ball.id];

                    const pawnSector = getEntitySector(pawn);
                    if (pawnCol === ballCol) {
                        // 接到對的顏色：+1，球變另一色
                        scoreRefs.current.global += 1;
                        if (pawnSector === 'p1') scoreRefs.current.p1 += 1;
                        else if (pawnSector === 'p2') scoreRefs.current.p2 += 1;
                        else if (pawnSector === 'p3') scoreRefs.current.p3 += 1;
                        else if (pawnSector === 'p4') scoreRefs.current.p4 += 1;
                        ballColorRef.current[ball.id] = flipBallColor(ballCol);
                        gsap.to(pawn.scale, { x: 1.25, y: 1.25, duration: 0.12, yoyo: true, repeat: 1 });
                    } else {
                        // 接到錯的顏色：-1（碰到球板不改變球大小）
                        scoreRefs.current.global -= 1;
                        if (pawnSector === 'p1') scoreRefs.current.p1 -= 1;
                        else if (pawnSector === 'p2') scoreRefs.current.p2 -= 1;
                        else if (pawnSector === 'p3') scoreRefs.current.p3 -= 1;
                        else if (pawnSector === 'p4') scoreRefs.current.p4 -= 1;
                        gsap.to(ball, { rotation: '+=0.8', duration: 0.18, yoyo: true, repeat: 1 });
                    }

                    // 反彈：依球與球板相對位置反射 vy，並小幅擾動 vx (球大小維持)
                    if (ballPhys) {
                        if (ball.y < pawn.y) ballPhys.vy = -Math.abs(ballPhys.vy);
                        else ballPhys.vy = Math.abs(ballPhys.vy);
                        ballPhys.vx += (Math.random() - 0.5) * 120;
                    }

                    updateMixedScoreText();
                });
            });
        }

        // --- Collision Handling (非 MIXED 模式) ---
        if (cfg.metadata.interaction_type !== 'MIXED' && cfg.collision_handlers) {
            const now = performance.now();
            cfg.collision_handlers.forEach(handler => {
               if (!handler.between || handler.between.length < 2) return;
               const idA = handler.between[0];
               const idB = handler.between[1];
               const entA = entitiesRef.current[idA];
               const entB = entitiesRef.current[idB];
               
               if (!entA || !entB || !entA.visible || !entB.visible) return;
               
               const avgPressure = (normalizedPrs.left + normalizedPrs.right) / 2;

               // --- 針對接物籃 (basket) 的專門壓力檢查：若未出力，則不觸發接取！ ---
               // 改用 ball_binding 解析(layout: center 已不再帶資訊),配合 basket 區塊維護的 phys.hasFired
               const pawnEnt = entA.type === 'controllable_pawn' ? entA : (entB.type === 'controllable_pawn' ? entB : null);
               const pawnEntLayout = pawnEnt ? getEntityLayout(pawnEnt) : 'center';
               if (pawnEnt && getEntityRole(pawnEnt) === 'basket') {
                   const pIds = Object.keys(allPrs || {});
                   const pawnBinding = pawnEnt.ball_binding;
                   const bm = pawnBinding ? pawnBinding.match(/^p(\d+)_(left|right|both)$/) : null;
                   let pickerPrs = { left: 0, right: 0 };
                   if (bm) {
                       const idx = parseInt(bm[1], 10) - 1;
                       if (idx >= 0 && idx < pIds.length) {
                           const pId = pIds[idx];
                           pickerPrs = {
                               left: (allPrs![pId]?.left ?? 0) / (mvcL || 1.0),
                               right: (allPrs![pId]?.right ?? 0) / (mvcR || 1.0)
                           };
                       }
                   }
                   // 任一手或雙手皆可觸發接取
                   const maxHand = Math.max(pickerPrs.left, pickerPrs.right);
                   if (maxHand < 0.2) {
                       return;
                   }
               }

               // --- PULSE-mode paddle 必須處於「已擊發」狀態才算碰撞 ---
               // 不擋的話,鼓自然落到槌子位置就會觸發 SCORE_HIT(球都不握分數也增加)。
               // phys.hasFired 由 PULSE 分支管理:壓力 > 0.4 設 true,< 0.1 重置為 false。
               if (pawnEnt && getEntityRole(pawnEnt) === 'paddle' &&
                   cfg.metadata.interaction_type === 'PULSE') {
                   const pawnPhys = entityPhysicsRef.current[pawnEnt.id];
                   if (!pawnPhys?.hasFired) {
                       return; // 槌子沒按下 → 鼓飄過去不算擊中
                   }
               }

               // --- 強制 SEQUENCE 輪替防呆機制 ---
               // 只阻擋對 target 的「錯方接取」，但允許 obstacle 觸發懲罰(壓力陷阱設計)
               const otherEnt = pawnEnt === entA ? entB : entA;
               const isTargetCollision = otherEnt?.type === 'target';
               if (pawnEnt && isTargetCollision && cfg.metadata.interaction_type === 'SEQUENCE') {
                   const seqTargetCount = cfg.entities.filter(e => e.type === 'target').length;
                   if (seqTargetCount > 1) {
                       // 多重目標：要求 sector 匹配。撈到別人的魚不予計分
                       const pawnSec = getEntitySector(pawnEnt);
                       const targetSec = otherEnt ? getEntitySector(otherEnt) : 'shared';
                       if (pawnSec !== 'shared' && targetSec !== 'shared' && pawnSec !== targetSec) {
                           return;
                       }
                   } else {
                       // 單一目標：依輪替燈號限制 — 用 sector 判定(不再靠 layout,因為新版 AI 都用 layout: center)
                       const pawnSec = getEntitySector(pawnEnt);
                       if (sequenceStepRef.current === 1 && pawnSec === 'p2') {
                           return; // P1 燈亮時,P2 basket 不能接金魚
                       }
                       if (sequenceStepRef.current === 2 && pawnSec === 'p1') {
                           return; // P2 燈亮時,P1 basket 不能接金魚
                       }
                   }

                   // SEQUENCE 模式必須「主動握壓」才算撈到 — 由 SEQUENCE atomic_action 維護的 phys.hasFired 旗標(>0.5 觸發、<0.15 重置)。
                   // 沒按壓就掉到框上不予計分,讓玩家真的「撈」而不是被動接住。
                   const pawnPhys = entityPhysicsRef.current[pawnEnt.id];
                   if (!pawnPhys?.hasFired) {
                       return;
                   }
               }

               // DODGE_PHASE early-exit penetration lock
               if (handler.on_match_logic === 'DODGE_PHASE' && avgPressure < 0.05) {
                   return; // Do not trigger collision logic; objects bypass natively
               }
               
               const pad = 10;
               const b1 = entA.getBounds();
               const b2 = entB.getBounds();
               const isOverlapping = (b1.x - pad) < (b2.x + b2.width + pad) && 
                                     (b1.x + b1.width + pad) > (b2.x - pad) &&
                                     (b1.y - pad) < (b2.y + b2.height + pad) && 
                                     (b1.y + b1.height + pad) > (b2.y - pad);
                                     
               if (isOverlapping) {
                   const collisionKey = `${idA}_${idB}`;
                   const lastTime = collisionCooldownRef.current[collisionKey] || 0;
                   if (now - lastTime > 500) { // 500ms cooldown for responsive bounces
                       collisionCooldownRef.current[collisionKey] = now;

                       // Collision visual feedback:對「靜止方」打 scale 閃爍取代 y 偏移,
                       // 避免 gsap.to(.y, yoyo) 多次連發時 yoyo 起點漂移、累積成 pawn 緩慢下沉/上飄。
                       const flashScale = (c: any) => {
                           if (!c) return;
                           gsap.killTweensOf(c.scale);
                           gsap.to(c.scale, {
                               x: 1.15, y: 1.15, duration: 0.05, yoyo: true, repeat: 1,
                               overwrite: 'auto',
                               onComplete: () => c.scale.set(1, 1),
                           });
                       };
                       if (!entityPhysicsRef.current[idA] || entityPhysicsRef.current[idA].vy === 0) flashScale(entA);
                       if (!entityPhysicsRef.current[idB] || entityPhysicsRef.current[idB].vy === 0) flashScale(entB);
                                            if (handler.on_match_logic === 'DODGE_PHASE') {
                            // If reached here, pressure is >= 0.05 (hit occurred)
                            const sA = getEntitySector(entA);
                            scoreRefs.current.global -= 1;
                            if (sA === 'p1') scoreRefs.current.p1 -= 1;
                            else if (sA === 'p2') scoreRefs.current.p2 -= 1;
                            else if (sA === 'p3') scoreRefs.current.p3 -= 1;
                            else if (sA === 'p4') scoreRefs.current.p4 -= 1;
                            gsap.to(entA.scale, { x: 1.1, y: 1.1, duration: 0.1, yoyo: true, repeat: 1 });
                        } else if (handler.on_match_logic === 'SCORE_HIT') {
                            const sectors = new Set([getEntitySector(entA), getEntitySector(entB)]);
                            scoreRefs.current.global += 1;
                            if (sectors.has('p1')) scoreRefs.current.p1 += 1;
                            if (sectors.has('p2')) scoreRefs.current.p2 += 1;
                            if (sectors.has('p3')) scoreRefs.current.p3 += 1;
                            if (sectors.has('p4')) scoreRefs.current.p4 += 1;
                            gsap.to(entA.scale, { x: 1.1, y: 1.1, duration: 0.1, yoyo: true, repeat: 1 });
                            gsap.to(entB.scale, { x: 1.1, y: 1.1, duration: 0.1, yoyo: true, repeat: 1 });

                            // SEQUENCE 模式撈到後,target 立刻重生回頂端(避免「一魚兩吃」— 同一條魚在
                            // 視覺上 lerp 到對方欄位繼續被撈)。多目標模式由 visibility 邏輯接手隱藏。
                            if (cfg.metadata.interaction_type === 'SEQUENCE') {
                                const targetEntInScore = entA.type === 'target' ? entA : (entB.type === 'target' ? entB : null);
                                if (targetEntInScore && entityPhysicsRef.current[targetEntInScore.id]) {
                                    entityPhysicsRef.current[targetEntInScore.id].lastY = -200;
                                    entityPhysicsRef.current[targetEntInScore.id].vy = 0;
                                }
                            }
                            // 太鼓同步:擊中即標記 consumed,本拍剩餘時間隱藏該 drum
                            if (taikoSyncRef.current.initialized) {
                                const targetEntInPair = entA.type === 'target' ? entA : (entB.type === 'target' ? entB : null);
                                if (targetEntInPair) taikoSyncRef.current.consumedThisBeat.add(targetEntInPair.id);
                            }
                         } else if (handler.on_match_logic === 'RANDOM_RECOLOR') {
                             const sectors = new Set([getEntitySector(entA), getEntitySector(entB)]);
                             scoreRefs.current.global += 1;
                             if (sectors.has('p1')) scoreRefs.current.p1 += 1;
                             if (sectors.has('p2')) scoreRefs.current.p2 += 1;
                             if (sectors.has('p3')) scoreRefs.current.p3 += 1;
                             if (sectors.has('p4')) scoreRefs.current.p4 += 1;
                             const newColor = Math.random() * 0xFFFFFF;
                             const basketEnt = getEntityRole(entA) === 'basket' ? entA : (getEntityRole(entB) === 'basket' ? entB : null);

                             // 籃子閃一下新色，0.25s 後還原（蘑菇不變色）
                             if (basketEnt) {
                                 const originalTints: number[] = basketEnt.children.map((c: any) => ('tint' in c ? c.tint : 0xFFFFFF));
                                 basketEnt.children.forEach((c: any) => { if ('tint' in c) c.tint = newColor; });
                                 gsap.delayedCall(0.25, () => {
                                     basketEnt.children.forEach((c: any, i: number) => {
                                         if ('tint' in c) c.tint = originalTints[i];
                                     });
                                 });

                                 // 碰撞回饋強化：basket 大幅跳躍 + 縮放，讓長輩明確知道接到
                                 const baseY = basketEnt.y;
                                 gsap.fromTo(basketEnt, { y: baseY }, { y: baseY - 80, duration: 0.18, ease: 'power2.out', yoyo: true, repeat: 1 });
                                 gsap.fromTo(basketEnt.scale, { x: 1, y: 1 }, { x: 1.3, y: 1.3, duration: 0.18, yoyo: true, repeat: 1 });
                             }
                             
                             // 將被接到的香菇瞬間移到畫面最下方，觸發重生，避免在籃子內停留多次觸發換燈
                             const targetEnt = entA.type === 'target' ? entA : (entB.type === 'target' ? entB : null);
                             if (targetEnt && entityPhysicsRef.current[targetEnt.id]) {
                                 entityPhysicsRef.current[targetEnt.id].lastY = app.screen.height + 200;
                             }
                         } else if (handler.on_match_logic === 'GAME_WIN') {
                             // GAME_WIN 觸發時先計分,再判定是否達標 — 否則 target_score >= 1 永遠卡住(因為碰撞前分數還是 0)
                             const winSectors = new Set([getEntitySector(entA), getEntitySector(entB)]);
                             scoreRefs.current.global += 1;
                             if (winSectors.has('p1')) scoreRefs.current.p1 += 1;
                             if (winSectors.has('p2')) scoreRefs.current.p2 += 1;
                             if (winSectors.has('p3')) scoreRefs.current.p3 += 1;
                             if (winSectors.has('p4')) scoreRefs.current.p4 += 1;
                             const targetScore = cfg.scoring_metrics?.target_score;
                             if (targetScore === undefined || scoreRefs.current.global >= targetScore) {
                                 if (instructionTextRef.current) {
                                     instructionTextRef.current.text = `🏆 達成目標！最終分數：${scoreRefs.current.global}`;
                                 }
                                 sessionEndedRef.current = false;
                                 const totalDuration = (performance.now() - sessionStartTimeRef.current) / 1000;
                                 onSessionEnd({
                                     effectiveSeconds: totalEffectiveMSRef.current / 1000,
                                     totalSeconds: totalDuration,
                                     avgPressureL: totalPressureLRef.current / Math.max(1, totalSamplesRef.current),
                                     avgPressureR: totalPressureRRef.current / Math.max(1, totalSamplesRef.current),
                                     maxPressure: maxPressureRef.current,
                                     maxPressureL: maxPressureLRef.current,
                                     maxPressureR: maxPressureRRef.current,
                                     compensationOccurred: false,
                                     clinical_tags: collectClinicalTags(cfg),
                                 });
                                 sessionEndedRef.current = true;
                             }
                         }

                         // SEQUENCE 模式：成功接取後依 pattern 推進（記憶訓練）
                         if (cfg.metadata.interaction_type === 'SEQUENCE' && pawnEnt &&
                             handler.on_match_logic !== 'DODGE_PHASE' && handler.on_match_logic !== 'NONE') {
                             const pattern = sequencePatternRef.current;
                             if (pattern.length > 0) {
                                 sequenceIndexRef.current = (sequenceIndexRef.current + 1) % pattern.length;
                                 sequenceStepRef.current = pattern[sequenceIndexRef.current];
                             }
                         }
                         
                         if (handler.penalty_logic === 'DEDUCT_SCORE') {
                            const penaltySectors = new Set([getEntitySector(entA), getEntitySector(entB)]);
                            scoreRefs.current.global -= 1;
                            if (penaltySectors.has('p1')) scoreRefs.current.p1 -= 1;
                            if (penaltySectors.has('p2')) scoreRefs.current.p2 -= 1;
                            if (penaltySectors.has('p3')) scoreRefs.current.p3 -= 1;
                            if (penaltySectors.has('p4')) scoreRefs.current.p4 -= 1;
                         } else if (handler.penalty_logic === 'HAPTIC_LONG_VIBRATE') {
                            console.log(`[HAPTIC] 觸發強烈震動回饋！來自物件碰撞：${idA} 與 ${idB}`);
                            if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
                         }
                         
                         if (instructionTextRef.current) {
                             const actPIds = Object.keys(allPrs || {});
                             let scoreStr = `分數: ${Math.max(0, scoreRefs.current.global)}`;
                             if (actPIds.length > 1) {
                                 const playerN = Math.min(4, Math.max(actPIds.length, cfg.metadata.player_count ?? 2));
                                 const parts: string[] = [];
                                 for (let i = 1; i <= playerN; i++) {
                                     const key = ('p' + i) as 'p1' | 'p2' | 'p3' | 'p4';
                                     parts.push(`P${i}: ${Math.max(0, scoreRefs.current[key])}`);
                                 }
                                 scoreStr = `多人分數 - ${parts.join(' | ')}`;
                             }
                             instructionTextRef.current.text = `[${cfg.metadata.game_name}] 模式: ${cfg.metadata.interaction_type} | ${scoreStr}`;
                         }
                    }
                }
             });
         }
        
      };

      app.ticker.add(tickerCb);
      tickerCbRef.current = tickerCb;

      if (stateRef.current.config) {
        applyTheme(app, stateRef.current.config);
      }
    };
    setup();

    return () => {
      isMounted = false;
      const g = globalThis as any;
      const app = g[PIXI_GLOBAL_KEY] as PIXI.Application;
      if (app) {
        if (tickerCbRef.current) {
          app.ticker.remove(tickerCbRef.current);
          tickerCbRef.current = null;
        }
        if (sessionContainerRef.current) {
          app.stage.removeChild(sessionContainerRef.current);
          sessionContainerRef.current.destroy({ children: true });
        }
        if (app.renderer && app.canvas && app.canvas.parentNode === containerRef.current) {
          containerRef.current?.removeChild(app.canvas);
        }
      }
    };
  }, []);

  useEffect(() => {
    const g = globalThis as any;
    const app = g[PIXI_GLOBAL_KEY];
    if (app && config) {
      applyTheme(app, config);
    }

    // --- 設定健檢:警告 collision_handlers 參考到不存在的 entity id ---
    if (config?.collision_handlers && config?.entities) {
      const validIds = new Set(config.entities.map(e => e.id));
      const issues: string[] = [];
      config.collision_handlers.forEach((h, idx) => {
        if (!h.between || h.between.length < 2) {
          issues.push(`handler[${idx}] between 缺少兩個 id`);
          return;
        }
        const [a, b] = h.between;
        if (!validIds.has(a)) issues.push(`handler[${idx}] between[0]="${a}" 在 entities 中找不到(疑似誤用 type 名稱)`);
        if (!validIds.has(b)) issues.push(`handler[${idx}] between[1]="${b}" 在 entities 中找不到`);
      });
      if (issues.length > 0) {
        console.warn(`[AUGP 設定健檢] collision_handlers 有 ${issues.length} 個問題,以下 handler 不會生效:\n  - ` + issues.join('\n  - '));
      }
    }
  }, [config]);

  // Automatically submit metrics when isActive toggles from true to false
  useEffect(() => {
    if (!isActive && totalSamplesRef.current > 0 && !sessionEndedRef.current) {
      sessionEndedRef.current = true;
      const totalDuration = (performance.now() - sessionStartTimeRef.current) / 1000;
      onSessionEnd({
        effectiveSeconds: totalEffectiveMSRef.current / 1000,
        totalSeconds: totalDuration,
        avgPressureL: totalPressureLRef.current / Math.max(1, totalSamplesRef.current),
        avgPressureR: totalPressureRRef.current / Math.max(1, totalSamplesRef.current),
        maxPressure: maxPressureRef.current,
        maxPressureL: maxPressureLRef.current,
        maxPressureR: maxPressureRRef.current,
        compensationOccurred: false,
        clinical_tags: collectClinicalTags(stateRef.current.config),
      });
    }
  }, [isActive, onSessionEnd]);

  return (
    <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden bg-amber-950 flex items-center justify-center">
      <div className="text-amber-800 animate-pulse">
        {isActive ? '運作中...' : '渲染引擎就緒'}
      </div>
    </div>
  );
};

export default GameView;
