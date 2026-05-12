/**
 * AIGrip 引擎能力清單 (Engine Capability Manifest)
 *
 * 這個檔案是引擎能力的「單一事實來源」。所有 enum、規則、機制都集中在這裡。
 * 後續步驟會把以下檔案改成從這份 manifest derive：
 *   - types.ts                 (union types)
 *   - services/geminiService.ts (responseSchema enum + SYSTEM_INSTRUCTION 動態章節)
 *   - components/GameView.tsx  (switch / 驗證邏輯)
 *
 * Step 1 (本次): 純新增此檔，不改其他檔的行為。
 *
 * 命名原則：
 *   - 機制 (MECHANICS) 名稱描述「引擎做什麼」(例 TEAM_COOP_RACE)，
 *     而非某個特定團康活動 (例 DRAGON_BOAT)。划龍舟、扛轎、推車、登山賽
 *     都套用同一個 TEAM_COOP_RACE 機制，只是 activity_examples 不同。
 *   - 機制是引擎能力，活動是使用者表達 — 機制 N 個 × 活動主題 M 個 = N×M。
 */

// ─────────────────────────────────────────────────────────────
// Atomic Actions
// ─────────────────────────────────────────────────────────────
export const ATOMIC_ACTIONS = {
  DRIVE: {
    label: "推進",
    description: "壓力 P → Y 軸加速度（對抗重力）。氣球升空、火箭、潛艇升降。",
    supported_axes: ["Y", "SCALE"] as const,
    applies_to: ["controllable_pawn"] as const,
    notes: [
      "不支援水平 DRIVE，水平移動請改用 NAVIGATE。",
      "僅對 controllable_pawn 生效；target / obstacle 走自動掉落物理，DRIVE 不影響它們。",
      "team_*_all 綁定的 DRIVE 會自動切換為「划槳節奏」子模式（rising-edge impulse、無重力、水阻尼）。",
    ],
  },
  PULSE: {
    label: "擊發",
    description: "瞬間壓力 + require_reset → 衝量。打太鼓、擊壁球、擊石。",
    supported_axes: ["Y"] as const,
    applies_to: ["controllable_pawn"] as const,
    notes: [
      "對同 sector 的 target/obstacle 施加向上衝量（vy 負方向）。",
      "左手 PULSE 只影響 layout=left 的目標，右手只影響 layout=right。",
    ],
  },
  NAVIGATE: {
    label: "導航",
    description: "(Ball_R - Ball_L) 壓力差 → X 軸位移。左右移動球板、閃避、套圈圈。",
    supported_axes: ["X"] as const,
    applies_to: ["controllable_pawn"] as const,
    notes: ["引擎自動取 right - left 差，ball_binding 預設用 p{N}_both。"],
  },
  SEQUENCE: {
    label: "序列",
    description: "跨實體的特定時間順序觸發。接力、記憶訓練、依序輪替。",
    supported_axes: ["X", "Y"] as const,
    applies_to: ["controllable_pawn"] as const,
    notes: [
      "需在 metadata.sequence_pattern 提供輪替順序（玩家編號陣列）。",
      "entities 必須至少含 1 個 type=obstacle 並有非 NONE penalty，作為壓力陷阱。",
      "可選用「多重目標混淆」：≥2 個 type=target 各設 sector=p1/p2，引擎自動以 sector 匹配判分。",
    ],
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Interaction Types (top-level mode selector)
// ─────────────────────────────────────────────────────────────
export const INTERACTION_TYPES = ["DRIVE", "PULSE", "NAVIGATE", "SEQUENCE", "MIXED"] as const;

// ─────────────────────────────────────────────────────────────
// Axes — schema 開放這 5 個值，但只有部分組合有引擎實作。
// 詳細支援組合請查 ATOMIC_ACTIONS[*].supported_axes。
// ─────────────────────────────────────────────────────────────
export const AXES = ["X", "Y", "XY", "SCALE", "ROTATE"] as const;

// ─────────────────────────────────────────────────────────────
// Entity Types
// ─────────────────────────────────────────────────────────────
export const ENTITY_TYPES = ["controllable_pawn", "target", "obstacle", "static"] as const;

// ─────────────────────────────────────────────────────────────
// Entity Roles (顯式語意角色)
// ─────────────────────────────────────────────────────────────
export const ENTITY_ROLES = {
  paddle: {
    label: "球板/槌子",
    renders_as: "blue_rounded_rect",
    initial_y_factor: 0.82,
    notes: ["PULSE/NAVIGATE 模式的接物板。"],
  },
  basket: {
    label: "籃子",
    renders_as: "blue_hollow_rect_with_outline",
    initial_y_factor: 0.5,
    notes: [],
  },
  mushroom: {
    label: "蘑菇/紅圓",
    renders_as: "red_circle_outlined",
    initial_y_factor: 0.5,
    notes: [
      "渲染順序中 mushroom 比 type=target 先比對；若想要黃色 target 預設樣式，role 設為 decoration。",
    ],
  },
  obstacle: {
    label: "障礙物",
    renders_as: "dark_grey_circle_with_x",
    initial_y_factor: 0.5,
    notes: [],
  },
  decoration: {
    label: "裝飾",
    renders_as: "fallthrough_to_target_default_yellow",
    initial_y_factor: 0.5,
    notes: ["對 type=target 會 fallthrough 到「黃色圓形 target」預設渲染，TEAM_COOP_RACE 的 finish_line 用此。"],
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Layout Hints (語意位置)
// ─────────────────────────────────────────────────────────────
export const LAYOUT_HINTS = ["left", "right", "center", "top", "bottom"] as const;

// ─────────────────────────────────────────────────────────────
// Sectors (玩家分區)
// ─────────────────────────────────────────────────────────────
export const SECTORS = ["p1", "p2", "p3", "p4", "shared"] as const;

// ─────────────────────────────────────────────────────────────
// Layout Rule — 1~4 人共用同一條規則 (2026-05-08 統一)
// ─────────────────────────────────────────────────────────────
export const LAYOUT_RULE = {
  description:
    "依 sector 將螢幕等分為 player_count 欄（p1 在最左、pN 在最右）；layout 在欄內偏移 ±20% 欄寬。" +
    "0.2 偏移確保「同玩家左右手」距離 < 「鄰近玩家」距離,使每位玩家的兩手在視覺上配對。" +
    "每位玩家「左手 / 右手」各一個 entity 時，設 sector=p{N} + layout=left/right。",
  examples: {
    1: "p1 中心 50%，left/right = 30%/70%",
    2: "p1=25% (left/right=15%/35%)、p2=75% (left/right=65%/85%)",
    3: "p1≈16.7%、p2=50%、p3≈83.3%；每欄內 left/right 各偏移 ±~6.7%",
    4: "p1=12.5%、p2=37.5%、p3=62.5%、p4=87.5%；每欄內 left/right 各偏移 ±5%",
  },
  shared_sector_fallback:
    "sector=shared 不被切欄，直接依 layout 落在 25%/50%/75%（TEAM_COOP_RACE 的 finish_line 用此）。",
  not_supported: [
    "四角配置（2×2 grid）",
    "上下分排（top row / bottom row）",
    "隨機 grid pop-up（打地鼠定點隨機彈出）",
  ],
} as const;

// ─────────────────────────────────────────────────────────────
// Ball Binding Formats
// ─────────────────────────────────────────────────────────────
export const BALL_BINDINGS = {
  standard_format: "p{N}_{left|right|both}",
  standard_examples: ["p1_both", "p1_left", "p2_right", "p3_both", "p4_left"] as const,

  team_coop: ["team_a_all", "team_b_all"] as const,
  team_coop_partition: {
    2: "team_a=[P1], team_b=[P2]（一人一隊）",
    4: "team_a=[P1,P2], team_b=[P3,P4]（兩人合作一隊）",
  },
  team_coop_constraints: {
    only_with_atomic_action: "DRIVE",
    only_with_sector: "shared",
    layout_required: { team_a_all: "left", team_b_all: "right" },
    forbidden_with: ["PULSE", "NAVIGATE", "SEQUENCE"],
    rowing_threshold_high: 0.4,
    rowing_threshold_low: 0.15,
  },

  legacy_supported: ["ball_1", "ball_2", "left", "right", "both", "shared"] as const,
  legacy_note: "舊版處方仍可載入，引擎會自動 fallback。新處方請用 standard 或 team_coop 格式。",

  applies_to: "僅 controllable_pawn 需要 ball_binding；target / obstacle 留空。",
} as const;

// ─────────────────────────────────────────────────────────────
// Collision Logic
// ─────────────────────────────────────────────────────────────
export const COLLISION_LOGIC = {
  on_match: ["SCORE_HIT", "DODGE_PHASE", "RANDOM_RECOLOR", "GAME_WIN", "NONE"] as const,
  penalty: ["DEDUCT_SCORE", "HAPTIC_LONG_VIBRATE", "NONE"] as const,
  rules: [
    "between 陣列必須使用 entities 中真實存在的 id，不可寫 type 名稱（如 'controllable_pawn'）。",
    "GAME_WIN 自我累加 score 後檢查 target_score；target_score=1 時首次碰撞即勝。",
    "SEQUENCE 模式的輪替鎖只阻擋 pawn↔target，不阻擋 pawn↔obstacle，所以壓力陷阱 penalty 仍會觸發。",
  ],
} as const;

// ─────────────────────────────────────────────────────────────
// Render Modes
// ─────────────────────────────────────────────────────────────
export const RENDER_MODES = {
  geometric: {
    label: "幾何（預設）",
    description: "零延遲幾何渲染（厚黑邊框色塊），復健現場使用。",
    triggers_image_generation: false,
  },
  themed: {
    label: "主題化",
    description: "使用者明確要求視覺包裝 / 沉浸式 / demo 時才設。會載入 image_prompt 對應的 AI 生成圖。",
    triggers_image_generation: true,
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Metadata Flags (optional behavior modifiers)
// ─────────────────────────────────────────────────────────────
export const METADATA_FLAGS = {
  sequence_pattern: {
    type: "number[]",
    required_when: "interaction_type === 'SEQUENCE'",
    description: "SEQUENCE 模式記憶訓練順序，元素為玩家編號（1 或 2）。長度建議 4 或 8。",
    example: [1, 1, 2, 2],
  },
  taiko_sync_pattern: {
    type: "('left' | 'right' | 'both')[]",
    required_when: "GROUP_RHYTHM 機制（PULSE + 群體節奏）",
    description:
      "節奏同步 pattern。每元素為一拍：'left'=同步左組、'right'=同步右組、'both'=左右一起。" +
      "空陣列 → 各 target 獨立掉落（退化為一般 PULSE 接落物）。",
    example: ["left", "right", "left", "right", "both"],
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Player Count Constraints
// ─────────────────────────────────────────────────────────────
export const PLAYER_COUNT = {
  min: 1,
  max: 4,
  default: 1,
  hardware_balls_per_player: 2,
  total_pressure_channels: 8,
  inference_keywords: {
    1: ["單人", "我"],
    2: ["雙人", "兩人", "協力", "對戰"],
    3: ["三人"],
    4: ["四人", "兩隊"],
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Mechanics (引擎機制 — 通用模板)
//
// 命名原則：模板名是「引擎提供的機制」，不是某個特定團康活動。
// activity_examples 列出常見對應活動，照護師可隨時擴充而不用改引擎。
//
// 例：TEAM_COOP_RACE 機制可套用於划龍舟、扛轎、推車、登山賽等任何
// 「兩隊合力推進到終點」的活動，引擎都用同一條 team_*_all + DRIVE 路徑。
//
// Step 4/6 會把這些 render 成 prompt 中的 few-shot 範例段落。
// ─────────────────────────────────────────────────────────────
export const MECHANICS = [
  {
    id: "FREEZE_INHIBITION",
    name: "凍結抑制機制",
    mechanic_summary:
      "在序列中安插「凍結階段」step，玩家必須維持壓力 < 0.05（放鬆）才能安全穿透；誤動扣分。訓練抑制控制與專注力。",
    interaction_type: "SEQUENCE",
    player_count_range: [1, 4],
    default_duration_seconds: 90, // 精神耗能類短一點,長輩專注度有限
    engine_features: [
      "sequence_pattern 中部分 step 為凍結階段",
      "collision_handler 用 required_state: 'pressure < 0.05' 標記安全穿透",
      "誤動 penalty_logic: DEDUCT_SCORE 或 HAPTIC_LONG_VIBRATE",
    ],
    ball_binding_pattern: "p{N}_both",
    activity_examples: [
      { name: "木頭人", keywords: ["木頭人", "1-2-3 木頭人"] },
      { name: "紅綠燈", keywords: ["紅綠燈", "停看聽"] },
      { name: "Freeze Dance", keywords: ["freeze", "音樂停就停"] },
      { name: "Simon Says 反向", keywords: ["Simon Says 反向", "不准動"] },
    ],
  },

  {
    id: "FALL_CATCH",
    name: "落物擊發機制",
    mechanic_summary:
      "target 從畫面上方持續落下，玩家須在落地前用對應手 PULSE 擊中（成功會彈飛）。訓練反應力與手眼協調。",
    interaction_type_options: ["PULSE", "MIXED"] as const,
    player_count_range: [1, 4],
    default_duration_seconds: 120, // 接落物節奏感強,2 分鐘剛好
    engine_features: [
      "target 自動掉落物理",
      "PULSE 對同 sector 同 layout 的 target 施加向上衝量",
      "支援雙手獨立（p{N}_left / p{N}_right）或整體出力（p{N}_both）",
    ],
    activity_examples: [
      { name: "接糖果 / 接水果", keywords: ["接糖果", "接水果", "接落物"] },
      { name: "接氣球", keywords: ["接氣球"] },
      { name: "敲鐘 / 敲響", keywords: ["敲鐘", "敲響", "看到就敲"] },
      { name: "空中接球", keywords: ["接球", "空中飛物"] },
      {
        name: "打地鼠（改編為「接從上方落下的地鼠」）",
        keywords: ["打地鼠"],
        note: "原始活動為 grid pop-up，引擎不支援，請以接落物形式重新詮釋。",
      },
    ],
    do_not_use_for: [
      "需要「定點隨機 pop-up」的格網彈出活動（打地鼠原版、拍蒼蠅）— 請改編為接落物形式。",
    ],
  },

  {
    id: "SEQUENCE_TURN",
    name: "輪替序列機制",
    mechanic_summary:
      "依 sequence_pattern 輪流亮燈 / 出題，玩家須依序回應對應 sector。訓練短期記憶與輪次等待。",
    interaction_type: "SEQUENCE",
    player_count_range: [1, 4],
    default_duration_seconds: 120,
    engine_features: [
      "sequence_pattern 必填",
      "引擎自動處理燈號輪替與 target 位置切換",
      "可拆「左手接奇位、右手接偶位」",
      "可選用多重目標混淆（≥2 個 target 各綁 sector，引擎自動以 sector 匹配判分）",
    ],
    activity_examples: [
      { name: "撈金魚輪流", keywords: ["撈金魚"] },
      { name: "接龍", keywords: ["接龍"] },
      { name: "大風吹", keywords: ["大風吹"] },
      { name: "踩階梯", keywords: ["踩階梯"] },
      { name: "跟著做 / 依序", keywords: ["跟著做", "依序", "輪流"] },
    ],
  },

  {
    id: "NAVIGATE_AIM",
    name: "導航瞄準機制",
    mechanic_summary:
      "pawn 由左右手壓力差控制 X 軸位置，target 靜態或從上方落下，碰撞得分。訓練雙手協調與精準操控。",
    interaction_type: "NAVIGATE",
    player_count_range: [1, 4],
    default_duration_seconds: 120,
    engine_features: [
      "axis: 'X'，引擎自動計算 right - left 差",
      "ball_binding 用 p{N}_both",
      "碰撞 → SCORE_HIT",
    ],
    activity_examples: [
      { name: "套圈圈", keywords: ["套圈圈"] },
      { name: "丟沙包", keywords: ["丟沙包"] },
      { name: "投籃", keywords: ["投籃"] },
      { name: "瞄準靶心", keywords: ["瞄準", "對準"] },
      { name: "左右移動接物", keywords: ["左右移動接"] },
    ],
  },

  {
    id: "DUAL_TASK",
    name: "雙重任務機制",
    mechanic_summary:
      "畫面同時存在 obstacle（要躲）與 target（要接），玩家左手與右手各對應一邊。訓練分散注意力與雙重任務切換。",
    interaction_type: "MIXED",
    player_count_range: [1, 4],
    default_duration_seconds: 150, // 雙重任務認知負擔重,稍微長一點養注意力
    requires_metadata: [],
    engine_features: [
      "左手 paddle 綁 p{N}_left，atomic_action 必為 PULSE（不可用 NAVIGATE — NAVIGATE 預設 p{N}_both 綁定，單手綁定無效）",
      "右手 basket 綁 p{N}_right，atomic_action 必為 PULSE",
      "target 必設 layout=right、role=decoration（fallthrough 到預設 target 渲染並可被 themed 圖覆蓋）",
      "obstacle 必設 layout=left、role=decoration（同上）",
      "勿用 role=mushroom 或 role=obstacle — 這兩個 role 會跳過 themed 圖覆蓋，會固定渲染成紅圓/灰圈X",
      "碰撞: 右手 basket × target → SCORE_HIT；左手 paddle × obstacle → DEDUCT_SCORE",
      "依 player_count 複製本配置：N 位玩家 = 2N 個 controllable_pawn + 至少 2N 個 target/obstacle，sector 從 p1 編到 pN",
      "target/obstacle 不需 movement_logic（引擎用內建落物物理）",
    ],
    canonical_entities: [
      {
        id: "paddle_p1_left",
        type: "controllable_pawn",
        role: "paddle",
        sector: "p1",
        layout: "left",
        ball_binding: "p1_left",
      },
      {
        id: "basket_p1_right",
        type: "controllable_pawn",
        role: "basket",
        sector: "p1",
        layout: "right",
        ball_binding: "p1_right",
      },
      {
        id: "obstacle_p1",
        type: "obstacle",
        role: "decoration",
        sector: "p1",
        layout: "left",
      },
      {
        id: "target_p1",
        type: "target",
        role: "decoration",
        sector: "p1",
        layout: "right",
      },
    ],
    activity_examples: [
      { name: "老鷹捉小雞", keywords: ["老鷹捉小雞"] },
      { name: "邊走邊接", keywords: ["邊走邊接", "邊算邊動"] },
      { name: "躲避並收集", keywords: ["躲避並收集", "閃避收集"] },
      { name: "一邊…一邊…", keywords: ["一邊", "雙重任務"] },
    ],
  },

  {
    id: "TEAM_COOP_RACE",
    name: "團隊合作推進機制",
    mechanic_summary:
      "兩隊各自合力把 pawn 推進到終點，先碰到 finish_line 的隊伍獲勝。引擎自動套用「划槳節奏」 — rising-edge impulse（壓→放→壓→放才能持續推進），無重力，水阻尼。訓練雙側對稱、團隊協調。",
    interaction_type: "DRIVE",
    player_count_range: [2, 4],
    default_duration_seconds: 180, // 競速類靠 GAME_WIN 為主,timer 為兜底
    requires_metadata: [],
    engine_features: [
      "team_a_all / team_b_all binding 加總同隊全員雙手",
      "2 人 → 一人一隊；4 人 → 兩人一隊",
      "rising-edge impulse：壓力 > 0.4 觸發，須降到 < 0.15 才能再觸發",
      "無重力，僅水阻尼",
      "載具從畫面 92% 起步，先碰到 finish_line 的隊伍 GAME_WIN",
      "team_*_all 僅支援 DRIVE，勿用於 PULSE / NAVIGATE / SEQUENCE",
    ],
    canonical_entities: [
      {
        id: "vehicle_team_a",
        type: "controllable_pawn",
        role: "paddle",
        sector: "shared",
        layout: "left",
        ball_binding: "team_a_all",
      },
      {
        id: "vehicle_team_b",
        type: "controllable_pawn",
        role: "paddle",
        sector: "shared",
        layout: "right",
        ball_binding: "team_b_all",
      },
      {
        id: "finish_line_a",
        type: "target",
        role: "decoration",
        sector: "shared",
        layout: "left",
      },
      {
        id: "finish_line_b",
        type: "target",
        role: "decoration",
        sector: "shared",
        layout: "right",
      },
    ],
    activity_examples: [
      { name: "划龍舟", keywords: ["划龍舟", "龍舟賽", "划船競速", "合力划船"] },
      { name: "扛轎競速", keywords: ["扛轎", "抬轎", "迎神賽", "扛轎競速"] },
      { name: "推車競賽", keywords: ["推車", "推軌道車"] },
      { name: "登山競速", keywords: ["登山賽", "爬山競速"] },
      { name: "兩隊賽跑", keywords: ["兩隊賽跑", "雙隊競速"] },
      { name: "兩隊送貨", keywords: ["送貨競賽", "貨運比賽"] },
    ],
  },

  {
    id: "GROUP_RHYTHM",
    name: "群體節奏同步機制",
    mechanic_summary:
      "多位玩家同側的 target 被引擎同步從上方一起落下，依 taiko_sync_pattern 陣列輪流推進拍子。訓練群體協同、節奏感、左右手獨立反應。",
    interaction_type: "PULSE",
    player_count_range: [2, 4],
    default_duration_seconds: 120,
    requires_metadata: ["taiko_sync_pattern"],
    engine_features: [
      "taiko_sync_pattern 每元素為一拍：'left'=同步左組、'right'=同步右組、'both'=左右同時",
      "同 layout target 跨 sector 共享 Y 位置，形成同步落下視覺",
      "consumedThisBeat 集合避免單拍重複計分，下一拍重置",
      "建議 8 個 controllable_pawn（4 人 × 左右手）+ 8 個 target",
      "勿混用 sector=shared（會脫離同步分組）",
    ],
    activity_examples: [
      { name: "太鼓節拍", keywords: ["太鼓", "打鼓", "四人打太鼓"] },
      { name: "節奏遊戲", keywords: ["節奏", "節拍", "左右節拍"] },
      { name: "群體合奏", keywords: ["合奏", "齊奏", "同步打鼓"] },
      { name: "左右拍手節奏", keywords: ["左右左右", "拍手節拍"] },
    ],
  },
] as const;

// ─────────────────────────────────────────────────────────────
// Unsupported / Out-of-scope (請避免生成或以替代邏輯近似)
// ─────────────────────────────────────────────────────────────
export const UNSUPPORTED = [
  {
    category: "對抗類",
    examples: ["拔河", "爭奪戰", "推鐵餅", "蹺蹺板"],
    reason: "引擎尚未支援團隊力量加總與 X 軸對抗推動。",
  },
  {
    category: "同步協力（其他形式）",
    examples: ["兩人三腳", "鼓掌歌"],
    reason: "引擎尚未支援「同隊時間窗 < 200ms 同步」判定。請改用 TEAM_COOP_RACE 機制（team_*_all DRIVE）。",
  },
  {
    category: "持續耐力類",
    examples: ["跳繩", "踩高蹺", "氣球升空", "舉重"],
    reason: "引擎尚未支援「達 X 秒後才計分」的時間窗修飾子。",
  },
  {
    category: "模仿類",
    examples: ["Simon Says 正向", "你比我猜"],
    reason: "引擎尚未支援「demo 階段 → 玩家輸入階段」狀態機。",
  },
  {
    category: "格網彈出類",
    examples: ["打地鼠", "拍蒼蠅", "敲打多孔"],
    reason: "引擎只支援「從上方落下」的 target 軌道，不支援「定點隨機 pop-up」。",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// Behavioral Rules (AI 行為規範 — 留在 prompt 的 prose，但這裡集中索引)
//
// 這些是條件式行為，不是能力宣告，所以仍由 prompt prose 描述。
// 列在這裡只是為了日後維護時方便定位。
// ─────────────────────────────────────────────────────────────
export const BEHAVIORAL_RULES = {
  hardware: "目前版本僅使用壓力感測（PRESSURE），暫不使用陀螺儀。",
  inhibition_required: "必須包含「錯誤顏色扣分」與「障礙物閃避」邏輯；閃避模式須維持壓力 < 0.05。",
  visual_style_foreground: "前景需包含 'thick black bold outline'。",
  visual_style_background: "背景需為 'washed out holiday atmosphere'。",
  clinical_tag_required: "每個動作必須帶 clinical_tag（如 inhibition_control, bilateral_symmetry, reaction_time）。",
  pawn_binding_uniqueness: "每個 pawn 必須綁定明確的單一壓力來源，不可一個 pawn 同時影響多個玩家。",
  id_naming_singleplayer: "1 人時實體 id 直接用 paddle / ball / basket，禁止加 _1 後綴。",
  id_naming_multiplayer: "≥2 人時用 paddle_1 ~ paddle_N（單手獨立型用 paddle_p1_left）。",
  no_semantic_in_id:
    "禁止把 role/layout/sector 藏在 id 字串中（例如 'left_picker'、'hole_target'），引擎只讀顯式欄位。",
  collision_id_strictness: "collision_handlers[*].between 必須使用真實 entity id，禁用 type 名稱或 wildcard。",
  prescription_summary_required: "必須產出 prescription_summary 欄位，供使用者確認任務內容。",
} as const;

// ─────────────────────────────────────────────────────────────
// Engine Validation Hooks (供 GameView.tsx 使用)
// ─────────────────────────────────────────────────────────────

/** 檢查 atomic_action + axis 組合是否為引擎支援。 */
export const isAtomicActionAxisValid = (
  action: keyof typeof ATOMIC_ACTIONS,
  axis: typeof AXES[number],
): boolean => {
  const spec = ATOMIC_ACTIONS[action];
  if (!spec) return false;
  return (spec.supported_axes as readonly string[]).includes(axis);
};

/** 檢查 ball_binding 字串格式是否被引擎接受。 */
export const isBallBindingValid = (binding: string): boolean => {
  if (!binding) return false;
  if ((BALL_BINDINGS.team_coop as readonly string[]).includes(binding)) return true;
  if ((BALL_BINDINGS.legacy_supported as readonly string[]).includes(binding)) return true;
  if (/^p[1-4]_(left|right|both)$/.test(binding)) return true;
  return false;
};

/** 整體 manifest 入口（給未來步驟的 prompt builder / schema builder 用）。 */
export const ENGINE_CAPABILITIES = {
  version: "1.0",
  atomic_actions: ATOMIC_ACTIONS,
  interaction_types: INTERACTION_TYPES,
  axes: AXES,
  entity_types: ENTITY_TYPES,
  entity_roles: ENTITY_ROLES,
  layout_hints: LAYOUT_HINTS,
  sectors: SECTORS,
  layout_rule: LAYOUT_RULE,
  ball_bindings: BALL_BINDINGS,
  collision_logic: COLLISION_LOGIC,
  render_modes: RENDER_MODES,
  metadata_flags: METADATA_FLAGS,
  player_count: PLAYER_COUNT,
  mechanics: MECHANICS,
  unsupported: UNSUPPORTED,
  behavioral_rules: BEHAVIORAL_RULES,
} as const;

export type EngineCapabilities = typeof ENGINE_CAPABILITIES;
