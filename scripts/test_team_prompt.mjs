import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8")
  .split("\n").filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const i = l.indexOf("="); a[l.slice(0,i)] = l.slice(i+1).replace(/^["']|["']$/g, ""); return a; }, {});
const apiKey = env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY;
if (!apiKey) { console.error("no api key"); process.exit(1); }

const src = fs.readFileSync("services/geminiService.ts", "utf8");
const sysMatch = src.match(/const SYSTEM_INSTRUCTION = `((?:\\`|[^`])*)`;/);
if (!sysMatch) { console.error("could not extract SYSTEM_INSTRUCTION"); process.exit(1); }
const SYSTEM_INSTRUCTION = sysMatch[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");

const ai = new GoogleGenAI({ apiKey });
const prompt = "四人打太鼓反應練習，左右手獨立，鼓會從上方落下到各自欄位的左或右側";

const resp = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: `請設計復健任務：${prompt}\n新玩家首次訓練。`,
  config: {
    systemInstruction: SYSTEM_INSTRUCTION,
    responseMimeType: "application/json",
    temperature: 0.7,
  },
});

const text = (resp.text || "").trim();
console.log(text);
