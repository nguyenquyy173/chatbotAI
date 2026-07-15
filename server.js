import express from "express";
import cors from "cors";
import helmet from "helmet";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 12000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const MESSENGER_URL = process.env.MESSENGER_URL || "https://m.me/datxetaidailoan";
const HOTEL_URL = process.env.HOTEL_URL || "https://www.datxetaidailoan.com/";

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "128kb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin không được phép bởi CORS."));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

let knowledgeBase = [];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function flattenJson(value, source = "database.json", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJson(item, `${source}[${index}]`, output));
    return output;
  }

  if (value && typeof value === "object") {
    const title = value.title || value.name || value.heading || value.question || source;
    const url = value.url || value.link || value.sourceUrl || "";
    const content = value.content || value.text || value.answer || value.description || JSON.stringify(value);
    output.push({ title: String(title), url: String(url), content: String(content) });
    return output;
  }

  if (value != null) output.push({ title: source, url: "", content: String(value) });
  return output;
}

async function loadKnowledgeBase() {
  try {
    const raw = await readFile(path.join(__dirname, "database.json"), "utf8");
    knowledgeBase = flattenJson(JSON.parse(raw));
    console.log(`Loaded ${knowledgeBase.length} knowledge records.`);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("database.json not found; Gemini will answer without local context.");
      knowledgeBase = [];
      return;
    }
    console.error("Cannot load database.json:", error);
    knowledgeBase = [];
  }
}

function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/i)
    .filter((token) => token.length >= 2);
}

function retrieveContext(query, limit = 5) {
  const tokens = [...new Set(tokenize(query))];
  if (!tokens.length || !knowledgeBase.length) return [];

  return knowledgeBase
    .map((item) => {
      const haystack = normalizeText(`${item.title} ${item.content}`);
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += token.length >= 5 ? 3 : 1;
        if (normalizeText(item.title).includes(token)) score += 3;
      }
      if (haystack.includes(normalizeText(query))) score += 8;
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildContext(items) {
  let used = 0;
  const blocks = [];

  for (const [index, item] of items.entries()) {
    const block = `[Nguồn ${index + 1}]\nTiêu đề: ${item.title}\nURL: ${item.url || "Không có"}\nNội dung: ${item.content}`;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    blocks.push(block);
    used += block.length;
  }

  return blocks.join("\n\n");
}

function buildActions(message, answer) {
  const text = normalizeText(`${message} ${answer}`);
  const bookingIntent = /(muon|can|dat|book|thue|don|dua|cho)/.test(text);
  const actions = [];

  if (bookingIntent && /(xe|taxi|san bay|dua don|jiufen|cuu phan)/.test(text)) {
    actions.push({ label: "Đặt xe qua Messenger", url: MESSENGER_URL });
  }
  if (bookingIntent && /(khach san|hotel|phong|住宿)/.test(text)) {
    actions.push({ label: "Xem khách sạn", url: HOTEL_URL });
  }
  return actions;
}

async function callGemini({ message, language, context }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY chưa được cấu hình trên Cloud Run.");
  }

  const systemInstruction = `Bạn là trợ lý du lịch Đài Loan của website Ăn chơi Đài Loan.
- Trả lời chủ yếu bằng tiếng Việt tự nhiên, trừ khi người dùng yêu cầu ngôn ngữ khác.
- Chỉ dùng dữ liệu nguồn được cung cấp khi câu hỏi liên quan trực tiếp. Nếu nguồn không đủ, vẫn được dùng kiến thức tổng quát.
- Khi có nhiều ý, mỗi ý phải xuống dòng và bắt đầu bằng dấu "-".
- Không bịa giá, lịch trình, quy định, địa chỉ hoặc thông tin thời gian thực.
- Không tự ý nói về visa nếu người dùng không hỏi.
- Không chèn nút hoặc markdown link trong nội dung; backend sẽ xử lý nút riêng.
- Chỉ cảnh báo khi thông tin có thể thay đổi như giá vé, giờ mở cửa, lịch tàu, quy định visa.
Ngôn ngữ giao diện: ${language || "vi-VN"}.`;

  const userText = context
    ? `Dữ liệu tham khảo nội bộ:\n${context}\n\nCâu hỏi của khách:\n${message}`
    : `Không tìm thấy dữ liệu nội bộ phù hợp. Hãy trả lời bằng kiến thức tổng quát và nói rõ khi thông tin cần kiểm tra mới.\n\nCâu hỏi của khách:\n${message}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          temperature: 0.35,
          topP: 0.9,
          maxOutputTokens: 4096
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || `Gemini HTTP ${response.status}`;
      throw new Error(detail);
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) throw new Error("Gemini không trả về nội dung.");
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/", (_req, res) => {
  res.json({ service: "taiwan-travel-chatbot", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    knowledgeRecords: knowledgeBase.length,
    apiKeyConfigured: Boolean(GEMINI_API_KEY)
  });
});

app.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const language = String(req.body?.language || "vi-VN").trim();

  if (!message) {
    res.status(400).json({ error: "Thiếu trường message." });
    return;
  }
  if (message.length > 4000) {
    res.status(400).json({ error: "Câu hỏi quá dài. Tối đa 4.000 ký tự." });
    return;
  }

  try {
    const matches = retrieveContext(message);
    const context = buildContext(matches);
    const answer = await callGemini({ message, language, context });

    res.json({
      answer,
      actions: buildActions(message, answer),
      sources: matches
        .filter((item) => item.url)
        .map((item) => ({ title: item.title, url: item.url }))
    });
  } catch (error) {
    console.error("Chat error:", error);
    const regionError = /location is not supported|region/i.test(error.message);
    res.status(502).json({
      error: regionError
        ? "Gemini từ chối vị trí máy chủ. Hãy kiểm tra Cloud Run đang triển khai tại asia-southeast1 (Singapore)."
        : error.message || "Không thể tạo câu trả lời."
    });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Lỗi máy chủ." });
});

await loadKnowledgeBase();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
