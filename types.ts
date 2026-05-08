
export type InteractionType = 'DRIVE' | 'PULSE' | 'NAVIGATE' | 'SEQUENCE' | 'MIXED';
export type AtomicAction = 'DRIVE' | 'PULSE' | 'NAVIGATE' | 'SEQUENCE';
export type AxisType = 'X' | 'Y' | 'XY' | 'SCALE' | 'ROTATE';
export type EntityType = 'controllable_pawn' | 'target' | 'obstacle' | 'static';
export type RenderMode = 'geometric' | 'themed';
export type EntityRole = 'paddle' | 'basket' | 'mushroom' | 'obstacle' | 'decoration';
export type LayoutHint = 'left' | 'right' | 'center' | 'top' | 'bottom';
export type Sector = 'p1' | 'p2' | 'p3' | 'p4' | 'shared';
export type OnMatchLogic = 'SCORE_HIT' | 'DODGE_PHASE' | 'RANDOM_RECOLOR' | 'GAME_WIN' | 'NONE';
export type PenaltyLogic = 'DEDUCT_SCORE' | 'HAPTIC_LONG_VIBRATE' | 'NONE';

export interface Metadata {
  game_id?: string;
  game_name: string;
  player_count?: number;
  interaction_type: InteractionType;
  prescription_summary: string;
  render_mode?: RenderMode; // 預設 geometric（零延遲幾何模式）；themed 才載入 AI 主題圖片
  sequence_pattern?: number[]; // SEQUENCE 模式記憶訓練順序，元素為玩家編號 (1 或 2)，例如 [1,2,1,1,2]
  taiko_sync_pattern?: ('left' | 'right' | 'both')[]; // 太鼓節拍 pattern，每元素是一拍：'left'=同步左組、'right'=同步右組、'both'=左右一起。空/未填則各 target 獨立落下
}

export interface GlobalPhysics {
  gravity_vector?: number[];
  world_friction?: number;
  reset_threshold?: number;
}

export interface EntityVisual {
  model_type?: string;
  image_prompt?: string;
  bg_image_prompt?: string;
  alpha?: number;
  bg_alpha?: number;
  image_url?: string;
}

export interface MovementLogic {
  atomic_action?: AtomicAction;
  axis?: AxisType;
  multiplier?: number;
  clinical_tag?: string;
}

export interface Entity {
  id: string;
  type: EntityType;
  role?: EntityRole;
  layout?: LayoutHint;
  sector?: Sector;
  ball_binding?: string; // 'p{N}_{left|right|both}' | 'team_a_all' (P1+P2 合計) | 'team_b_all' (P3+P4 合計) | legacy 'ball_1'/'ball_2'/'both'
  visual: EntityVisual;
  movement_logic: MovementLogic;
}

export interface CollisionHandler {
  between?: string[];
  on_match_logic?: OnMatchLogic;
  penalty_logic?: PenaltyLogic;
  required_state?: string;
}

export interface ScoringMetrics {
  win_condition?: string;
  target_score?: number;
  data_logging?: string[];
}

export interface GameConfig {
  metadata: Metadata;
  global_physics?: GlobalPhysics;
  entities: Entity[];
  collision_handlers: CollisionHandler[];
  scoring_metrics: ScoringMetrics;
  clinical_advice?: string;
  
  // Appended by frontend logic
  image_url?: string;
  bg_image_url?: string;
}

export interface SessionMetrics {
  effectiveSeconds: number;
  totalSeconds: number;
  avgPressureL?: number;
  avgPressureR?: number;
  maxPressureL?: number;
  maxPressureR?: number;
  maxPressure?: number;
  compensationOccurred?: boolean;
  clinical_tags?: string[]; // 此次 session 訓練到的臨床標籤（去重）
}

export interface PressureData {
  left: number;
  right: number;
}

export interface Patient {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'other';
  birthYear: number;
  daily_mvc_l?: number; // New: Today's Left Hand MVC
  daily_mvc_r?: number; // New: Today's Right Hand MVC
  last_mvc_timestamp?: number; // New: When the current MVC was recorded
}

export interface SavedPrescription {
  id: string;             // Prescription ID
  timestamp: number;      // Saved time
  game_name: string;      // Game name
  config: GameConfig;     // The JSON Schema
  assets: {
    image_url?: string;    // Main object image
    bg_image_url?: string; // Background image
  };
  raw_prompt: string;     // The input prompt
  best_achievement_rate?: number; // New: Best achievement rate
  force_stability_data?: any;    // New: Force stability data
  patientName?: string;          // New: Patient/Subject name
  patientId?: string;            // New: Link to Patient profile
  metrics?: SessionMetrics;      // New: Detailed session metrics
}
