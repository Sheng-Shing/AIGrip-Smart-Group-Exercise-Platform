/**
 * Stage 1: 機制提案 (Mechanic Proposal)
 *
 * 照護師輸入活動描述後，這個服務會回傳一個結構化提案：
 *   - 匹配到哪個引擎機制 (來自 engineCapabilities.MECHANICS)
 *   - 友善的玩法說明 (給照護師看的)
 *   - 推測的人數 + 推測依據
 *   - 注意事項 (例如原始活動引擎不支援已改編)
 *   - 替代選項 (有歧義時)
 *
 * 流程：
 *   照護師輸入 → proposeMechanic() → 顯示 PlayProposalCard
 *               → 照護師按「確定生成」 → 進入 Stage 2 (generateGame with confirmedMechanic)
 *
 * 為什麼是兩階段而不是一次到位：
 *   1. 一次到位 AI 容易猜錯機制，照護師等了 5 秒才看到不對的遊戲。
 *   2. 兩階段把「選機制」這個高失誤點拆出來，先用 1 秒小呼叫拿到提案，照護師確認後才花
 *      時間生成完整 AUGP。
 *   3. 提案階段也教育照護師「引擎能做什麼」，下次描述會更精確。
 */

import { GoogleGenAI, Type } from "@google/genai";
import { MECHANICS, PLAYER_COUNT } from "./engineCapabilities";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ConfidenceLevel = "high" | "medium" | "low";

export interface MechanicAlternative {
  /** 替代機制的 ID。必須是 MECHANICS 中存在的 id。 */
  mechanic_id: string;
  /** 機制顯示名稱（從 manifest 帶過來，方便 UI 顯示）。 */
  mechanic_name: string;
  /** 為什麼這個也算合理選項（給照護師看）。 */
  reason: string;
}

export interface MechanicProposal {
  /** 匹配到的機制 ID（必為 MECHANICS 中存在的 id）。 */
  matched_mechanic_id: string;

  /** 機制顯示名稱（從 manifest 對照後填入）。 */
  matched_mechanic_name: string;

  /** AI 對匹配的信心。high = 用戶描述明確且機制完全吻合；low = 用戶描述模糊或屬於 fallback。 */
  confidence: ConfidenceLevel;

  /** 給照護師看的活動標題（例 "推火箭到月球"），保留使用者的活動主題。 */
  proposed_title: string;

  /** 一兩句友善的玩法說明，避開引擎術語。 */
  proposed_summary: string;

  /** 推測的人數，1~4。 */
  player_count: number;

  /** 為什麼這個人數（給照護師看，例 "你提到『兩隊』，每隊建議 2 人共 4 人"）。 */
  player_count_reasoning: string;

  /**
   * 注意事項：
   * - 引擎不支援的活動已改編 (例 "原版打地鼠是隨機彈出，已改成從上方落下")
   * - 機制限制 (例 "team_*_all 只支援 DRIVE")
   * - 其他需要照護師知道的取捨
   */
  caveats: string[];

  /** 替代選項，有歧義時 AI 提供。空陣列代表沒有合適替代。 */
  alternatives: MechanicAlternative[];

  /**
   * 活動主題字串，給 Stage 2 做主題包裝用。
   * 不含人數 / 機制 / 規則描述，只是「這個遊戲在故事上是什麼」。
   * 例 "推火箭到月球"、"夜市撈金魚"、"收割稻穗"。
   */
  activity_theme: string;

  /**
   * 建議遊戲時長（秒）。AI 根據機制 default_duration_seconds 與使用者偏好調整。
   * 照護師可在 PlayProposalCard 微調後再生成。
   * 範圍 30~600（半分鐘到 10 分鐘）。
   */
  recommended_duration_seconds: number;
}

// ─────────────────────────────────────────────────────────────
// Prompt Construction
// ─────────────────────────────────────────────────────────────

/**
 * 把 MECHANICS 壓縮成 AI 提示詞用的精簡描述。
 * 不放 canonical_entities / engine_features 的細節，提案階段只需機制概念。
 */
const renderMechanicsForPrompt = (): string => {
  return MECHANICS.map((m, idx) => {
    const examples = m.activity_examples.map((a) => a.name).join("、");
    const playerRange =
      m.player_count_range[0] === m.player_count_range[1]
        ? `${m.player_count_range[0]} 人`
        : `${m.player_count_range[0]}~${m.player_count_range[1]} 人`;
    return `${idx + 1}. **${m.id}** (${m.name})
   - 玩法概念: ${m.mechanic_summary}
   - 適用人數: ${playerRange}
   - 預設時長: ${m.default_duration_seconds} 秒
   - 已知活動範例: ${examples}`;
  }).join("\n\n");
};

const SYSTEM_INSTRUCTION = `你是復健團康活動的「玩法配對師」。

照護師會用自然語言描述他們想跟長輩玩的活動（可能是傳統團康、生活情境、自創主題）。
你的任務是從引擎內建的機制中，挑出最適合的一個，並給照護師一份**友善、可確認**的提案卡。

## 引擎可用機制（從中選一個）

${renderMechanicsForPrompt()}

## 推論規則

1. **機制是引擎能力，活動是使用者表達**：照護師說「划龍舟」、「推火箭到月球」、「兩隊送貨」這些都是同一個 TEAM_COOP_RACE 機制，差別只在 activity_theme。不要因為照護師沒說「划龍舟」就找不到 TEAM_COOP_RACE。

2. **人數推論**：
   - 「我」「單人」「一個人」 → 1
   - 「雙人」「兩人」「對戰」「協力」 → 2
   - 「三人」 → 3
   - 「四人」「兩隊」「分組」 → 4
   - 沒明說 → 預設 1
   - 機制有 player_count_range 限制時必須符合（例 TEAM_COOP_RACE 至少 2 人）。

3. **不支援的活動要改編**：如果使用者要求的原版活動引擎不支援（例 打地鼠原版需要 grid pop-up、跳繩需要時間窗），找最接近的機制改編，並在 caveats 中誠實告知「原版需要 X，已改成 Y」。

4. **confidence 判定**：
   - high: 使用者描述明確 + 機制完全吻合（例 「四人打太鼓」 → GROUP_RHYTHM）
   - medium: 機制可套用但有改編（例 「打地鼠」 → FALL_CATCH 改編）
   - low: 描述太模糊或屬於 fallback（例 「來個遊戲」）

5. **alternatives**：只有當另一個機制也合理時才填，最多 2 個。沒有就回空陣列。

6. **activity_theme**：抽取使用者描述中的「主題部分」，去掉人數和機制描述。
   例：「四個阿嬤一起打太鼓」 → activity_theme: "打太鼓"
   例：「我們想兩隊推火箭到月球競速」 → activity_theme: "推火箭到月球"

7. **proposed_title**：是 activity_theme + 人數的友善寫法，給卡片 UI 顯示。
   例：activity_theme="打太鼓"、player_count=4 → proposed_title: "四人合奏太鼓"

8. **proposed_summary**：1~2 句，避開引擎術語（不要提 PULSE / DRIVE / collision_handler），用照護師能懂的話描述玩法。

9. **caveats 範例**：
   - "原版打地鼠是隨機彈出，引擎已改編為從上方落下，仍可訓練反應力。"
   - "需要至少 2 人才能執行此機制；如果只有 1 人請改用 FALL_CATCH。"
   - "TEAM_COOP_RACE 需要持續『壓→放』的節奏，連續按住不會持續加速。"

10. **recommended_duration_seconds**：以選定機制的「預設時長」為基準，依使用者描述調整：
    - 使用者說「短一點 / 一分鐘」 → 60 秒左右
    - 使用者說「長一點 / 五分鐘」 → 300 秒左右
    - 使用者沒指定 → 用機制預設時長
    - 範圍鎖在 30~600 秒（半分鐘到 10 分鐘）。

## 輸出

嚴格遵守 JSON Schema，不要加任何 markdown / 註解 / 多餘文字。`;

const proposalSchema = {
  type: Type.OBJECT,
  properties: {
    matched_mechanic_id: {
      type: Type.STRING,
      enum: MECHANICS.map((m) => m.id),
      description: "從引擎可用機制中選一個 id",
    },
    matched_mechanic_name: { type: Type.STRING },
    confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
    proposed_title: { type: Type.STRING },
    proposed_summary: { type: Type.STRING },
    player_count: { type: Type.NUMBER },
    player_count_reasoning: { type: Type.STRING },
    caveats: { type: Type.ARRAY, items: { type: Type.STRING } },
    alternatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          mechanic_id: { type: Type.STRING, enum: MECHANICS.map((m) => m.id) },
          mechanic_name: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ["mechanic_id", "mechanic_name", "reason"],
      },
    },
    activity_theme: { type: Type.STRING },
    recommended_duration_seconds: {
      type: Type.NUMBER,
      description: "建議遊戲時長(秒),範圍 30~600",
    },
  },
  required: [
    "matched_mechanic_id",
    "matched_mechanic_name",
    "confidence",
    "proposed_title",
    "proposed_summary",
    "player_count",
    "player_count_reasoning",
    "caveats",
    "alternatives",
    "activity_theme",
    "recommended_duration_seconds",
  ],
};

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * 把照護師的自然語言描述配對到一個引擎機制。
 *
 * @param userPrompt 照護師輸入的活動描述。可包含人數、主題、玩法偏好。
 * @returns 結構化提案，給 PlayProposalCard 顯示。
 * @throws 若 API key 缺失、AI 回傳格式錯誤、或機制 id 不在 manifest 中。
 */
export const proposeMechanic = async (
  userPrompt: string,
): Promise<MechanicProposal> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_GEMINI_API_KEY in environment variables");
  }
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `照護師描述：${userPrompt}`,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: proposalSchema,
      temperature: 0.3, // 提案階段降低溫度，求穩定不求發散
    },
  });

  const text = (response.text || "").trim();
  let parsed: MechanicProposal;
  try {
    parsed = JSON.parse(text) as MechanicProposal;
  } catch (e) {
    console.error("Mechanic proposer parse error:", text, e);
    throw new Error("AI 提案格式錯誤，請重試一次。");
  }

  // 驗證 mechanic_id 確實存在於 manifest 中（schema 應已限制，但雙保險）。
  const validIds = new Set(MECHANICS.map((m) => m.id));
  if (!validIds.has(parsed.matched_mechanic_id)) {
    throw new Error(
      `AI 回傳了未知的機制 id: ${parsed.matched_mechanic_id}。可能是 manifest 與 prompt 不同步。`,
    );
  }

  // 補齊 matched_mechanic_name（如果 AI 漏填或填錯，用 manifest 的權威值覆蓋）。
  const matchedSpec = MECHANICS.find((m) => m.id === parsed.matched_mechanic_id);
  if (matchedSpec) {
    parsed.matched_mechanic_name = matchedSpec.name;
  }

  // 同樣校正 alternatives 中的 mechanic_name。
  parsed.alternatives = (parsed.alternatives || [])
    .filter((alt) => validIds.has(alt.mechanic_id))
    .map((alt) => {
      const spec = MECHANICS.find((m) => m.id === alt.mechanic_id);
      return spec ? { ...alt, mechanic_name: spec.name } : alt;
    });

  // Clamp player_count 到合法範圍。
  parsed.player_count = Math.max(
    PLAYER_COUNT.min,
    Math.min(PLAYER_COUNT.max, Math.round(parsed.player_count)),
  );

  // Clamp duration 到 30~600 秒;若 AI 漏填或填爛,fallback 到機制預設。
  const fallbackDuration = matchedSpec?.default_duration_seconds ?? 120;
  const rawDuration = parsed.recommended_duration_seconds;
  parsed.recommended_duration_seconds =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.max(30, Math.min(600, Math.round(rawDuration)))
      : fallbackDuration;

  return parsed;
};

/**
 * 從 MECHANICS 取出指定機制的完整 spec（給 Stage 2 generateGame 使用）。
 * 找不到回 undefined。
 */
export const getMechanicSpec = (mechanicId: string) => {
  return MECHANICS.find((m) => m.id === mechanicId);
};
