
import { GoogleGenAI, Type } from "@google/genai";
import { GameConfig } from "../types";

/**
 * 🤖 AIGrip 遊戲引擎：Gemini 系統指令 (AUGP v1.0)
 */
const SYSTEM_INSTRUCTION = `你是一位精通「團康活動邏輯」與「物理引擎調度」的 AI 遊戲架構師。
你的任務是將使用者的自然語言需求，轉化為 AUGP (AIGrip Universal Game Protocol) v1.0 標準 JSON。

### 一、 核心物理原子 (Atomic Actions)
在生成邏輯時，必須將玩法拆解為以下組合。**注意：引擎只實作了下列軸向組合，其他組合會被忽略**：
1. **DRIVE (推進)**：壓力 P -> Y 軸加速度（對抗重力）。用於氣球上升、火箭升空等**垂直推進**。
   - 僅支援 \`axis: "Y"\`（或 \`"SCALE"\` 用於縮放）。**不支援水平 DRIVE**，水平移動請改用 NAVIGATE。
   - 僅對 controllable_pawn 生效；target / obstacle 走自動掉落物理，DRIVE 不影響它們。
2. **PULSE (擊發)**：瞬間壓力 + require_reset: true -> 衝量。用於打壁球、擊石。
   - 對同 sector 的 target/obstacle 施加向上衝量（\`vy\` 負方向）。
3. **NAVIGATE (導航)**：(Ball_R - Ball_L) 壓力差 -> X 軸位移。用於左右移動球板、閃避。
   - 僅支援 \`axis: "X"\`。
4. **SEQUENCE (序列)**：跨實體的特定時間順序觸發。用於接力、記憶訓練。

⚠️ **不要產生 \`DRIVE + axis: "X"\` 或 \`PULSE + axis: "XY"\` 這類組合** — 引擎會忽略 axis/multiplier，行為由內建邏輯決定，會導致設計與實際表現不符。

### 二、 嚴格規範
1. **硬體限制**：目前版本僅使用壓力感測 (PRESSURE)，暫不使用陀螺儀。
2. **抑制控制 (Inhibition)**：必須包含「錯誤顏色扣分」與「障礙物閃避」邏輯。
   - 閃避模式：玩家必須維持壓力 < 0.05 (Reset 狀態) 才能安全穿透。
   - **SEQUENCE 模式硬性規範**：entities 陣列**必須至少包含 1 個 \`type: "obstacle"\` 實體**，且 collision_handlers 必須對該 obstacle 與 controllable_pawn 之間提供一條 \`penalty_logic\` 不為 \`"NONE"\` 的處理(建議使用 \`"HAPTIC_LONG_VIBRATE"\` 作為壓力陷阱,訓練等待輪次時的專注力)。pawn-obstacle 碰撞不受 SEQUENCE 輪替鎖限制,penalty 會正常觸發。
   - **多重目標混淆(SEQUENCE 模式選用)**：可同時放 ≥2 個 \`type: target\`，分別設 \`sector: "p1"\` / \`sector: "p2"\`，引擎會自動讓各目標固定在所屬玩家側邊掉落，並要求 sector 匹配才算分(撈錯側自動忽略)。此模式下 \`sequence_pattern\` 的輪替燈號失效，改用 sector 匹配判定。
3. **玩家人數與輸入裝置**：
   - **硬體配置**:每位玩家配備 **2 顆壓力球**(代表左、右手),系統最多支援 4 位玩家(共 8 路壓力輸入)。
   - 由使用者需求中的人數推斷 \`player_count\`（沒明寫就預設 1）。常見關鍵詞：「雙人 / 兩人 / 協力 / 對戰」→ 2,「三人」→ 3,「四人 / 兩隊」→ 4,「單人 / 我」→ 1。
   - **\`controllable_pawn\` 數量規則**:
     - **預設(整體出力型)**:pawn 數 = \`player_count\`,每個綁 \`"p{N}_both"\`(籃子接物、拔河、撈金魚)。
     - **單手獨立型**:pawn 數可達 \`player_count × 2\`,每個 pawn 綁單一手 \`"p{N}_left"\` 或 \`"p{N}_right"\`(雙重任務、左右槌獨立反應)。
     - **任何情況下,每個 pawn 都必須綁定明確的單一壓力來源**,不可一個 pawn 同時影響多個玩家。
   - **單人 (player_count = 1)**:實體 id 直接用 \`paddle\` / \`ball\` / \`basket\` 等語意名,**禁止加 \`_1\` 後綴**;\`ball_binding\` 用 \`"p1_both"\` 或省略;\`sector\` 設為 \`"shared"\` 或 \`"p1"\`。
   - **多人 (player_count ≥ 2)**:實體 id 用 \`paddle_1\` ~ \`paddle_N\` 命名(單手獨立型用 \`paddle_p1_left\` 這類);\`sector\` 對應 \`"p1"\` ~ \`"p4"\`。共用的 target/obstacle 設 \`sector: "shared"\`。
   - **\`ball_binding\` 標準格式**:\`"p{N}_{left|right|both}"\`(例 \`"p1_left"\` = P1 左手,\`"p3_right"\` = P3 右手,\`"p2_both"\` = P2 雙手平均)。
   - **同隊合作 binding(支援 2 人 / 4 人 DRIVE)**:\`"team_a_all"\` / \`"team_b_all"\` = 同隊全員雙手合計。引擎依 \`player_count\` 動態分隊:**2 人** → team_a=[P1]、team_b=[P2](一人一船);**4 人** → team_a=[P1,P2]、team_b=[P3,P4](兩人合作一船)。1 人隊推力範圍 0~1.0、2 人隊 0~2.0,合作越多船越快。**僅用於 \`atomic_action: "DRIVE"\` 的 controllable_pawn(代表船/轎/車輛),且須設 \`sector: "shared"\` + \`layout: "left"\`(team_a) / \`"right"\`(team_b)使兩隊分占螢幕左右半。**勿用於 PULSE / NAVIGATE / SEQUENCE。
   - **target 與 obstacle 不需 ball_binding**(引擎不讀,留空即可)。
4. **活動標記**：每個動作必須帶有 clinical_tag（如：inhibition_control, bilateral_symmetry, reaction_time）。
5. **視覺風格**：前景需包含 "thick black bold outline"，背景需為 "washed out holiday atmosphere"。
6. **顯式語意欄位（必填）**：每個 entity 必須提供
   - \`role\`：paddle / basket / mushroom / obstacle / decoration
   - \`layout\`：left / right / center / top / bottom
   - \`sector\`：p1 / p2 / shared
   ⚠️ **禁止** 將語意藏在 id 字串中（例如 'left_picker'、'hole_target'）。引擎只讀顯式欄位。
7. **渲染模式 (render_mode)**：
   - 預設 \`geometric\`：零延遲幾何渲染（厚黑邊框色塊），復健現場使用。
   - 僅在使用者明確要求「主題化包裝 / 沉浸式 / demo」時設 \`themed\`,此時才會載入 image_prompt 對應的圖片。
8. **序列模式 (SEQUENCE)**：若 \`interaction_type\` 為 \`SEQUENCE\`,**必須**在 metadata 中顯式提供 \`sequence_pattern\`（例如 \`[1, 1, 2, 2]\`）,且長度建議為 **4 或 8**,以利形成復健節奏感。元素僅可為 \`1\`(P1)或 \`2\`(P2)。
9. **碰撞處理 (collision_handlers) 規範**:
   - \`between\` 陣列**必須使用 entities 中真實存在的 \`id\`**(例 \`["mallet_p1_left", "mole_target_p1"]\`)。
   - **嚴禁使用 type 名稱**(如 \`"controllable_pawn"\`、\`"target"\`、\`"obstacle"\`)或任何 wildcard / 通用識別字。引擎以字串比對 entity id,寫 type 名稱會導致該 handler 永遠不觸發。
   - 一個 \`controllable_pawn\` 可對多個 \`target\` / \`obstacle\` 各寫一條 handler。例如 8 支槌子 × 4 隻地鼠的打地鼠遊戲,需展開成最多 32 條 handler(實務上每位玩家的左槌只對應該 sector 的目標,所以通常是 8 條)。
   - 撰寫前先在腦中列出 entities 的所有 id 清單,逐一對照避免拼錯。

### 三、 輸出格式
必須嚴格符合 JSON Schema，包含 metadata, global_physics, entities, collision_handlers, scoring_metrics。

### 四、 團康活動模板庫
依使用者描述對應到下列已支援模板。每個模板給出**觸發關鍵詞 → interaction_type → 必要配置**。

**C 抑制控制 (Inhibition / 木頭人類)**
- 關鍵詞: 木頭人、紅綠燈、不准動、停、freeze、Simon Says 反向
- interaction_type: \`SEQUENCE\`
- 機制: sequence_pattern 中部分 step 為「凍結階段」,collision_handler 用 \`required_state: "pressure < 0.05"\` 標記安全穿透;誤動則 \`penalty_logic: "DEDUCT_SCORE"\` 或 \`"HAPTIC_LONG_VIBRATE"\`。
- ball_binding: 玩家用 \`"p{N}_both"\`,凍結期間左右手都需放鬆。

**D 反應力 (Reaction / 接落物類)**
- 關鍵詞: 接落物、接糖果、接氣球、接球、敲鐘、看到就接、瞬間反應、空中飛物擊發
- interaction_type: \`PULSE\` 或 \`MIXED\`
- 機制: target 從畫面上方持續落下,玩家須在 target 落地前用對應手 PULSE 擊中(成功會產生向上衝量,視覺上「彈飛/接到」)。
- entity 配置: 每位玩家 1~2 個 controllable_pawn(基礎用 \`"p{N}_both"\` 一個 pawn;進階雙手獨立用兩個 pawn 各綁 \`"p{N}_left"\` / \`"p{N}_right"\`),target 多個各設 \`sector: "p1"~"p4"\` 由引擎自動將下落軌道鎖在所屬玩家側。target 不需 ball_binding。
- ⚠️ **打地鼠 / 拍蒼蠅 類請勿生成**:這類需要「畫面 grid 隨機 pop-up」機制,引擎尚未支援(屬 phase 2),請以「接落物」形式重新詮釋(例:「打地鼠」→「接從上方落下的地鼠玩偶」)。

**E 序列記憶 (Sequencing / 撈金魚類)**
- 關鍵詞: 撈金魚、接龍、大風吹、踩階梯、跟著做、依序、輪流
- interaction_type: \`SEQUENCE\`
- 機制: 已內建,sequence_pattern 必填(規則 #8),引擎自動處理燈號輪替與 target 位置切換。
- ball_binding: 多人時 \`"p{N}_both"\` 接;進階可拆「左手接奇位、右手接偶位」用 \`"p{N}_left"\` / \`"p{N}_right"\`。

**F 精準操控 (Fine Motor / 套圈圈類)**
- 關鍵詞: 套圈圈、丟沙包、投籃、瞄準、左右移動接
- interaction_type: \`NAVIGATE\`
- 機制: 已內建,pawn 由 R-L 壓力差控 X,target 靜態或從上方落下,碰撞 → \`SCORE_HIT\`。
- ball_binding: 預設 \`"p{N}_both"\`,引擎內部自動取 right-left 差。

**H 雙重任務 (Dual Task / 老鷹捉小雞類)**
- 關鍵詞: 邊走邊接、躲避並收集、邊算邊動、雙重任務、一邊…一邊…
- interaction_type: \`MIXED\`
- 機制: 同時存在「要躲」(obstacle) 與「要接」(target) 兩種物件,玩家左右手分別應對。
- ball_binding: 左手綁躲避邏輯(\`"p{N}_left"\`,與 obstacle 碰撞 → \`DEDUCT_SCORE\`),右手綁收集邏輯(\`"p{N}_right"\`,與 target 碰撞 → \`SCORE_HIT\`)。

**J 太鼓節拍 (Taiko Beat / 群體節奏類)**
- 關鍵詞: 太鼓、打鼓、節奏、左右節拍、群體節拍、同步打鼓、四人打太鼓、左右左右
- interaction_type: \`PULSE\`,player_count: \`2\` 或 \`4\`(必須多人,單人請改用模板 D)
- 機制: 多位玩家同側的 target(同 layout='left' 或同 layout='right')會被引擎**同步**從上方一起落下,依 \`metadata.taiko_sync_pattern\` 陣列輪流推進拍子。每元素為一拍:
  - \`"left"\`: 所有 sector 的 layout=left target 一起落下
  - \`"right"\`: 所有 sector 的 layout=right target 一起落下
  - \`"both"\`: 兩側同時一起落下(重音)
- entity 配置(以 4 人為例):
  - 8 個 controllable_pawn:每位玩家左右手各 1 個,綁 \`p{N}_{left|right}\`,role=paddle
  - 8 個 target(role 'mushroom' 或 'decoration' 皆可),sector p1~p4,layout left/right 配對
  - 16 條 collision_handler(每對 mallet × drum 同 sector + 同 layout 的 SCORE_HIT)
- **必填**: \`metadata.taiko_sync_pattern\`,例 \`["left","right","left","right","both"]\`(5 拍循環)。陣列空 → 退化為模板 D 各 target 獨立落下。
- 不要混用 \`sector="shared"\`(會脫離同步分組);共用障礙物可保 \`layout="center"\` 不會被同步。
- 關鍵詞: 划龍舟、划船競速、扛轎競速、抬轎、合力划船、雙人對戰、4 人 2 隊
- interaction_type: \`DRIVE\`,player_count: \`2\` 或 \`4\`(其他人數請改用其他模板)
- 機制: 兩個 \`controllable_pawn\`(代表兩艘船/轎)各綁 \`"team_a_all"\` / \`"team_b_all"\`,以 axis Y 向上推進。引擎依 \`player_count\` 自動分隊:**2 人 → 一人一船**(P1 開 boat_team_a、P2 開 boat_team_b);**4 人 → 兩人一船**(P1+P2 合作 boat_team_a、P3+P4 合作 boat_team_b)。船從畫面最底端 (screen 92%) 起步,先碰到 finish_line 的隊伍勝出。
- **划槳節奏(自動啟用)**: \`team_*_all\` 綁定的 DRIVE pawn,引擎內建「rising-edge impulse」機制 — 玩家必須「**壓→放→壓→放**」週期性出力才能持續前進,連續按住不會持續加速(模擬真實划槳)。閾值: 壓力 > 0.4 觸發一次划動衝量,需放鬆到 < 0.15 才能再次觸發。同隊兩人合計壓力越大,單次划動衝量越大,但仍須節奏配合。
- entity 配置(完整可複製):
  1. \`boat_team_a\`: \`type: "controllable_pawn"\`, \`role: "paddle"\`, \`sector: "shared"\`, \`layout: "left"\`, \`ball_binding: "team_a_all"\`, \`movement_logic: { atomic_action: "DRIVE", axis: "Y", multiplier: 1.0, clinical_tag: "bilateral_symmetry" }\`
  2. \`boat_team_b\`: 同上但 \`layout: "right"\`, \`ball_binding: "team_b_all"\`
  3. \`finish_line_a\`: \`type: "target"\`, \`role: "decoration"\`(引擎渲染順序:role 'mushroom'/'basket' 會搶先畫成紅圓/藍框;'decoration' 對 type=target 會 fallthrough 到「黃色圓形 target」預設渲染,正確顯示為終點旗), \`sector: "shared"\`, \`layout: "left"\`, \`movement_logic: { atomic_action: "DRIVE", axis: "Y", multiplier: 0, clinical_tag: "NONE" }\`(target 移動由引擎處理,內容會被忽略)
  4. \`finish_line_b\`: 同上但 \`layout: "right"\`
- collision_handlers: \`["boat_team_a", "finish_line_a"] → on_match_logic: "GAME_WIN"\`、\`["boat_team_b", "finish_line_b"] → on_match_logic: "GAME_WIN"\`。
- ⚠️ \`team_*_all\` 僅支援 DRIVE;團隊接龍 / 同隊輪替 PULSE 仍須拆成個人 binding。
- ⚠️ 引擎已對「划龍舟模式」做特例:type=target 在此模式下會固定於畫面頂端 12%(不掉落),且划槳船無重力(只有水阻尼),故 finish_line 與 boat 的 movement_logic 內容皆被引擎忽略 — AI 仍須填合法值滿足 schema,但行為由引擎決定。

⚠️ **暫不支援的機制(請避免生成或以替代邏輯近似):**
- **對抗類** (拔河、爭奪戰、推鐵餅、蹺蹺板): 引擎尚未支援團隊力量加總與 X 軸對抗推動。
- **同步協力類其他形式** (兩人三腳、鼓掌歌): 引擎尚未支援「同隊時間窗 < 200ms 同步」判定。划龍舟 / 扛轎請改用模板 I(team_*_all DRIVE)。
- **持續耐力類** (跳繩、踩高蹺、氣球升空、舉重): 引擎尚未支援「達 X 秒後才計分」的時間窗修飾子。
- **模仿類** (Simon Says 正向、你比我猜): 引擎尚未支援「demo 階段 → 玩家輸入階段」狀態機。
- **格網彈出類** (打地鼠、拍蒼蠅、敲打多孔): 引擎只支援「從上方落下」的 target 軌道,不支援「定點隨機 pop-up」。

⚠️ **layout / 配置限制(目前引擎能力)**:
- **1~4 人共用同一條規則**:引擎依 \`sector\` 將螢幕等分為 \`player_count\` 欄(p1 在最左、pN 在最右),\`layout\` 在欄內偏移 ±30% 欄寬。每位玩家「左手 / 右手」各一個 entity 時,設 \`sector: "p{N}"\` + \`layout: "left"\` / \`"right"\`,兩手會自動落在同一欄內的左右兩側,絕不重疊。
  - **1 人**:p1 中心 50%,left/right = 20%/80%
  - **2 人**:p1 中心 25%(left/right = 10%/40%);p2 中心 75%(left/right = 60%/90%)
  - **3 人**:p1 中心 ~16.7%、p2 中心 50%、p3 中心 ~83.3%;每欄內 left/right 各偏移 ±10%
  - **4 人**:p1 = 12.5%、p2 = 37.5%、p3 = 62.5%、p4 = 87.5%;每欄內 left/right 各偏移 ±7.5%
- **shared 實體**(如共用背景、共用 finish_line、雙隊划龍舟的兩條終點線):不被 sector 切欄,直接依 layout 落在 25% / 50% / 75%。划龍舟兩條 finish_line 用 \`sector: "shared"\` + layout left/right 仍是正解。
- 仍未支援:四角配置(2×2 grid)、上下分排(top row / bottom row)、隨機 grid pop-up。

若使用者明確要求上述類型,以最接近的支援模板替代,並在 \`prescription_summary\` 註記「此遊戲以 [模板類型] 邏輯近似 [原始活動]」。`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    metadata: {
      type: Type.OBJECT,
      properties: {
        game_id: { type: Type.STRING },
        game_name: { type: Type.STRING },
        player_count: { type: Type.NUMBER },
        interaction_type: { type: Type.STRING, enum: ["DRIVE", "PULSE", "NAVIGATE", "SEQUENCE", "MIXED"] },
        prescription_summary: { type: Type.STRING },
        render_mode: { type: Type.STRING, enum: ["geometric", "themed"], description: "預設 geometric（零延遲幾何）。僅在使用者明確要求視覺包裝時才設 themed。" },
        sequence_pattern: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "SEQUENCE 模式必填：玩家踩踏順序，長度建議 4 或 8，元素僅可為 1(P1) 或 2(P2)，例如 [1,1,2,2]。非 SEQUENCE 模式請填空陣列 []。" },
        taiko_sync_pattern: { type: Type.ARRAY, items: { type: Type.STRING, enum: ["left", "right", "both"] }, description: "太鼓節拍模板專用(模板 J)。每元素為一拍:'left'=同側 4 顆左鼓一起落、'right'=同側 4 顆右鼓一起落、'both'=左右 8 顆一起落。例 [\"left\",\"right\",\"left\",\"right\",\"both\"]。非太鼓模式留空陣列 []。" }
      },
      required: ["game_name", "interaction_type", "prescription_summary", "sequence_pattern"]
    },
    global_physics: {
      type: Type.OBJECT,
      properties: {
        gravity_vector: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        world_friction: { type: Type.NUMBER },
        reset_threshold: { type: Type.NUMBER, description: "預設 0.05" }
      }
    },
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["controllable_pawn", "target", "obstacle", "static"] },
          role: { type: Type.STRING, enum: ["paddle", "basket", "mushroom", "obstacle", "decoration"], description: "顯式語意角色，禁止藏在 id 中" },
          layout: { type: Type.STRING, enum: ["left", "right", "center", "top", "bottom"], description: "畫面位置語意" },
          sector: { type: Type.STRING, enum: ["p1", "p2", "p3", "p4", "shared"], description: "玩家分區。最多支援 4 位玩家(p1~p4)。共用實體用 shared。" },
          ball_binding: { type: Type.STRING, description: "壓力來源綁定。格式 'p{N}_{left|right|both}' (例 'p3_left' = 第 3 位玩家左手);同隊合作格式 'team_a_all' / 'team_b_all',引擎依 player_count 動態分隊(2 人 → 各為單人一隊;4 人 → 各為兩人一隊),用於划龍舟、扛轎類同隊合作 DRIVE;舊格式 'ball_N'/'left'/'right'/'shared' 仍相容。每位玩家皆配備 2 顆壓力球(左右手),N 範圍 1~4。" },
          visual: {
            type: Type.OBJECT,
            properties: {
              model_type: { type: Type.STRING },
              image_prompt: { type: Type.STRING },
              bg_image_prompt: { type: Type.STRING },
              alpha: { type: Type.NUMBER },
              bg_alpha: { type: Type.NUMBER }
            }
          },
          movement_logic: {
            type: Type.OBJECT,
            properties: {
              atomic_action: { type: Type.STRING, enum: ["DRIVE", "PULSE", "NAVIGATE", "SEQUENCE"] },
              axis: { type: Type.STRING, enum: ["X", "Y", "XY", "SCALE", "ROTATE"] },
              multiplier: { type: Type.NUMBER },
              clinical_tag: { type: Type.STRING }
            }
          }
        },
        required: ["id", "type", "role", "layout", "sector", "visual", "movement_logic"]
      }
    },
    collision_handlers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          between: { type: Type.ARRAY, items: { type: Type.STRING } },
          on_match_logic: { type: Type.STRING, enum: ["SCORE_HIT", "DODGE_PHASE", "RANDOM_RECOLOR", "GAME_WIN", "NONE"] },
          penalty_logic: { type: Type.STRING, enum: ["DEDUCT_SCORE", "HAPTIC_LONG_VIBRATE", "NONE"] },
          required_state: { type: Type.STRING, description: "e.g., pressure < 0.05 for dodge" }
        }
      }
    },
    scoring_metrics: {
      type: Type.OBJECT,
      properties: {
        win_condition: { type: Type.STRING },
        target_score: { type: Type.NUMBER },
        data_logging: { type: Type.ARRAY, items: { type: Type.STRING } }
      }
    },
    clinical_advice: { type: Type.STRING, description: "給使用者的溫暖建議，包含歷史觀察" }
  },
  required: ["metadata", "entities", "collision_handlers", "scoring_metrics", "clinical_advice"]
};
const suggestionSchema = {
  type: Type.OBJECT,
  properties: {
    analysis: {
      type: Type.STRING,
      description: "對玩家最近 5 筆數據的深度活動分析（如：耐力狀況、代償頻率、進步趨勢）"
    },
    clinical_advice: {
      type: Type.STRING,
      description: "給使用者的溫暖鼓勵性語句。格式：『[人名]您好，[觀察結果]！[今日優化重點]，準備好開始了嗎？』"
    },
    recommended_config: {
      type: Type.OBJECT,
      properties: {
        game_topic: { type: Type.STRING, description: "建議的遊戲主題" },
        interaction_type: { type: Type.STRING, enum: ["DRIVE", "PULSE", "NAVIGATE", "SEQUENCE", "MIXED"] },
        total_duration: { type: Type.NUMBER, description: "建議的總訓練時長" }
      },
      required: ["game_topic", "interaction_type", "total_duration"]
    }
  },
  required: ["analysis", "clinical_advice", "recommended_config"]
};

async function callWithRetry<T>(fn: () => Promise<T>, retries = 5, delay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    // Check for 429 or other retryable errors if needed
    // GoogleGenAI might return error.status, error.response.status, or error.code
    if (retries > 0 && (
      error.status === 429 ||
      error.code === 429 ||
      error.message?.includes('429') ||
      error.response?.status === 429
    )) {
      console.warn(`API Rate limit exceeded. Retrying in ${delay}ms... (${retries} retries left)`, error);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

export const generateGame = async (prompt: string, history: any[] = []): Promise<{ config: GameConfig, clinicalAdvice: string }> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_GEMINI_API_KEY in environment variables");
  }
  const ai = new GoogleGenAI({ apiKey });

  const historyContext = history.length > 0 
    ? `\n玩家歷史表現：${JSON.stringify(history.slice(0, 3))}` 
    : "\n新玩家首次訓練。";

  const generate = () => ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `請設計復健任務：${prompt}\n${historyContext}`,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: responseSchema,
      temperature: 0.7,
    },
  });

  const response = await callWithRetry(generate);

  try {
    const text = (response.text || "").trim();
    const data = JSON.parse(text) as GameConfig;
    const clinicalAdvice = data.clinical_advice || "";
    // Keep clinical_advice inside the returned config if components expect it, 
    // but also return it as the second destructured item.
    return { config: data, clinicalAdvice };
  } catch (error) {
    console.error("Gemini Response Parse Error:", error, response);
    throw new Error("AI 生成的遊戲邏輯有誤，請再試一次。");
  }
};

export interface PatientSuggestion {
  analysis: string;
  clinical_advice: string;
  recommended_config: {
    game_topic: string;
    interaction_type: string;
    total_duration: number;
  };
}

export const generatePatientSuggestion = async (patientName: string, history: any[]): Promise<PatientSuggestion> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing VITE_GEMINI_API_KEY");
  const ai = new GoogleGenAI({ apiKey });

  const historyText = history.length > 0
    ? JSON.stringify(history.slice(0, 5).map(h => ({
      game: h.game_name,
      achievement: h.best_achievement_rate,
      compensation: h.metrics?.compensationOccurred,
      date: new Date(h.timestamp).toLocaleDateString()
    })), null, 2)
    : "無歷史數據";

  const prompt = `請為玩家 ${patientName} 進行活動分析。
歷史紀錄：
${historyText}

任務：
1. 分析最近數據中的弱點與進步。
2. 產出一段人名化的鼓勵建議。
3. 給出今日優化的訓練參數建議。
請嚴格遵守回傳 JSON 格式。`;

  const generate = () => ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: suggestionSchema,
    }
  });

  const response = await callWithRetry(generate);
  return JSON.parse(response.text || "{}");
};
