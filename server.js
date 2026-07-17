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
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const MAX_CONTEXT_CHARS = Number(
  process.env.MAX_CONTEXT_CHARS || 12000
);

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "*"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const MESSENGER_URL =
  process.env.MESSENGER_URL ||
  "https://m.me/datxetaidailoan";

const VISA_URL =
  process.env.VISA_URL ||
  "https://m.me/VISADaiLoanKhongKho";

const app = express();

app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(
  express.json({
    limit: "128kb"
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        ALLOWED_ORIGINS.includes("*") ||
        ALLOWED_ORIGINS.includes(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(
        new Error("Origin không được phép bởi CORS.")
      );
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

function flattenJson(
  value,
  source = "database.json",
  output = []
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenJson(
        item,
        `${source}[${index}]`,
        output
      );
    });

    return output;
  }

  if (value && typeof value === "object") {
    const title =
      value.title ||
      value.name ||
      value.heading ||
      value.question ||
      source;

    const url =
      value.url ||
      value.link ||
      value.sourceUrl ||
      "";

    const content =
      value.content ||
      value.text ||
      value.answer ||
      value.description ||
      JSON.stringify(value);

    output.push({
      title: String(title),
      url: String(url),
      content: String(content)
    });

    return output;
  }

  if (value != null) {
    output.push({
      title: source,
      url: "",
      content: String(value)
    });
  }

  return output;
}

async function loadKnowledgeBase() {
  try {
    const raw = await readFile(
      path.join(__dirname, "database.json"),
      "utf8"
    );

    knowledgeBase = flattenJson(
      JSON.parse(raw)
    );

    console.log(
      `Loaded ${knowledgeBase.length} knowledge records.`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(
        "database.json not found; Gemini will answer without local context."
      );

      knowledgeBase = [];
      return;
    }

    console.error(
      "Cannot load database.json:",
      error
    );

    knowledgeBase = [];
  }
}

function tokenize(text) {
  return normalizeText(text)
    .split(
      /[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/i
    )
    .filter((token) => token.length >= 2);
}

function retrieveContext(query, limit = 5) {
  const tokens = [
    ...new Set(tokenize(query))
  ];

  if (
    !tokens.length ||
    !knowledgeBase.length
  ) {
    return [];
  }

  return knowledgeBase
    .map((item) => {
      const haystack = normalizeText(
        `${item.title} ${item.content}`
      );

      let score = 0;

      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += token.length >= 5 ? 3 : 1;
        }

        if (
          normalizeText(item.title).includes(token)
        ) {
          score += 3;
        }
      }

      if (
        haystack.includes(
          normalizeText(query)
        )
      ) {
        score += 8;
      }

      return {
        ...item,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildContext(items) {
  let used = 0;
  const blocks = [];

  for (
    const [index, item] of items.entries()
  ) {
    const block =
      `[Nguồn ${index + 1}]\n` +
      `Tiêu đề: ${item.title}\n` +
      `URL: ${item.url || "Không có"}\n` +
      `Nội dung: ${item.content}`;

    if (
      used + block.length >
      MAX_CONTEXT_CHARS
    ) {
      break;
    }

    blocks.push(block);
    used += block.length;
  }

  return blocks.join("\n\n");
}

function buildActions(
  message,
  actionFlags = {}
) {
  const text = normalizeText(message);
  const actions = [];

  /*
  Regex được giữ lại làm lớp dự phòng,
  phòng trường hợp Gemini trả actionFlags sai.
  */
  const fallbackCarIntent =
    /(dat xe|thue xe|can xe|muon xe|goi xe|dua don|don san bay|xe san bay|taxi|book xe)/.test(
      text
    );

  const fallbackVisaIntent =
    /(visa|thi thuc|xin visa|lam visa|tu van visa|ho so visa|gia han visa)/.test(
      text
    );

  const fallbackStaffIntent =
    /(ket noi.*nhan vien|gap nhan vien|noi chuyen.*nhan vien|noi chuyen.*nguoi that|lien he.*nhan vien|tu van vien|ho tro truc tiep)/.test(
      text
    );

  const shouldShowCar =
    actionFlags.carBooking === true ||
    fallbackCarIntent;

  const shouldShowVisa =
    actionFlags.visaConsultation === true ||
    fallbackVisaIntent;

  const shouldShowStaff =
    actionFlags.contactStaff === true ||
    fallbackStaffIntent;

  if (shouldShowCar) {
    actions.push({
      label: "Đặt xe qua Messenger",
      url: MESSENGER_URL
    });
  }

  if (shouldShowVisa) {
    actions.push({
      label: "Tư vấn visa",
      url: VISA_URL
    });
  }

  /*
  Chỉ thêm nút hỗ trợ chung nếu chưa có nút
  đặt xe hoặc tư vấn visa.
  */
  if (
    shouldShowStaff &&
    !shouldShowCar &&
    !shouldShowVisa
  ) {
    actions.push({
      label: "Kết nối với nhân viên",
      url: MESSENGER_URL
    });
  }

  return actions;
}

function sanitizeMemory(value) {
  const memory =
    value &&
    typeof value === "object"
      ? value
      : {};

  return {
    numberOfPeople:
      Number.isInteger(
        memory.numberOfPeople
      ) &&
      memory.numberOfPeople > 0
        ? memory.numberOfPeople
        : null,

    itinerary: Array.isArray(
      memory.itinerary
    )
      ? memory.itinerary
          .filter(
            (item) =>
              item &&
              typeof item === "object"
          )
          .map((item) => ({
            day: String(
              item.day || ""
            ).trim(),

            visits: Array.isArray(
              item.visits
            )
              ? item.visits
                  .filter(
                    (visit) =>
                      visit &&
                      typeof visit ===
                        "object"
                  )
                  .map((visit) => ({
                    location: String(
                      visit.location || ""
                    ).trim(),

                    time: String(
                      visit.time || ""
                    ).trim()
                  }))
                  .filter(
                    (visit) =>
                      visit.location
                  )
              : []
          }))
          .filter(
            (item) =>
              item.day &&
              item.visits.length
          )
      : [],

    specialRequests: Array.isArray(
      memory.specialRequests
    )
      ? [
          ...new Set(
            memory.specialRequests
              .map((item) =>
                String(item).trim()
              )
              .filter(Boolean)
          )
        ]
      : [],

    otherInformation: Array.isArray(
      memory.otherInformation
    )
      ? [
          ...new Set(
            memory.otherInformation
              .map((item) =>
                String(item).trim()
              )
              .filter(Boolean)
          )
        ]
      : []
  };
}

async function callGemini({
  message,
  language,
  context,
  memory
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY chưa được cấu hình trên máy chủ."
    );
  }

  const currentMemory = sanitizeMemory(
    memory || EMPTY_MEMORY
  );

  const systemInstruction = `
Bạn là trợ lý du lịch Đài Loan của website Ăn chơi Đài Loan.

QUY TẮC TRẢ LỜI:

- Trả lời chủ yếu bằng tiếng Việt tự nhiên, trừ khi người dùng yêu cầu ngôn ngữ khác.
- Chỉ dùng dữ liệu nguồn được cung cấp khi câu hỏi liên quan trực tiếp.
- Nếu nguồn không đủ, vẫn được dùng kiến thức tổng quát.
- Khi có nhiều ý, mỗi ý phải xuống dòng và bắt đầu bằng dấu "-".
- Không bịa giá, lịch trình, quy định, địa chỉ hoặc thông tin thời gian thực.
- Không tự ý nói về visa nếu người dùng không hỏi.
- Không chèn nút hoặc markdown link trong nội dung.
- Backend sẽ xử lý các nút riêng.
- Chỉ cảnh báo khi thông tin có thể thay đổi như giá vé, giờ mở cửa, lịch tàu hoặc quy định visa.
- Không hỏi lại thông tin đã có trong MEMORY HIỆN TẠI.

Bạn phải luôn trả về đúng hai biến:

1. answer:
Câu trả lời trực tiếp cho khách.

2. memory:
Bản tóm tắt đầy đủ sau khi cập nhật từ tin nhắn hiện tại.
3. actionFlags:
Các tín hiệu để backend hiển thị nút hành động.

actionFlags có form:

{
  "carBooking": false,
  "visaConsultation": false
}
QUY TẮC ACTION FLAGS:

- carBooking = true khi khách:
  - Muốn đặt xe.
  - Muốn thuê xe.
  - Muốn báo giá xe.
  - Muốn đặt xe đưa đón sân bay.
  - Muốn nhân viên tư vấn dịch vụ xe.

- visaConsultation = true khi khách:
  - Muốn tư vấn visa.
  - Muốn làm visa.
  - Muốn kiểm tra hồ sơ visa.
  - Muốn liên hệ nhân viên visa.

- Nếu khách chỉ hỏi thông tin chung về xe nhưng chưa muốn đặt hoặc liên hệ, carBooking = false.

- Nếu khách chỉ hỏi kiến thức chung về visa nhưng chưa muốn tư vấn trực tiếp, visaConsultation = false.

- Không được nói "tôi đã kết nối" hoặc "tôi sẽ chuyển bạn" nếu actionFlags đều là false.

- Khi một action flag là true, hãy nói tự nhiên rằng khách có thể bấm nút bên dưới để liên hệ.
FORM MEMORY CỐ ĐỊNH:

- numberOfPeople:
Tổng số người trong chuyến đi.
Nếu chưa biết thì trả về null.

- itinerary:
Danh sách địa điểm và thời gian theo từng ngày.

Mỗi phần tử itinerary có:
{
  "day": "Ngày 1",
  "visits": [
    {
      "location": "Cửu Phần",
      "time": "Buổi sáng"
    }
  ]
}

- specialRequests:
Các yêu cầu đặc biệt của khách.

Ví dụ:
- Cần ghế trẻ em.
- Có người lớn tuổi.
- Không ăn thịt bò.
- Cần xe lăn.
- Muốn lịch trình nhẹ nhàng.

- otherInformation:
Các thông tin hữu ích khác không thuộc những mục trên.

Ví dụ:
- Có một trẻ 3 tuổi.
- Khách đang ở Đài Bắc.
- Muốn thuê xe riêng.
- Muốn ưu tiên ngắm cảnh.

QUY TẮC CẬP NHẬT MEMORY:

- Memory trả về phải là bản đầy đủ, không chỉ là phần mới.
- Giữ nguyên thông tin cũ nếu tin nhắn mới không thay đổi thông tin đó.
- Chỉ thêm thông tin do chính khách nói rõ hoặc xác nhận.
- Không lưu thông tin do trợ lý tự suy đoán.
- Nếu khách sửa thông tin cũ, phải dùng thông tin mới nhất.
- Nếu khách nói bỏ một địa điểm hoặc yêu cầu, phải xóa thông tin đó khỏi memory.
- Không lưu lời chào.
- Không lưu lời cảm ơn.
- Không lưu câu hỏi kiến thức chung.
- Không lưu câu trả lời do trợ lý tạo ra.
- Không tự tạo số người, địa điểm, ngày hoặc thời gian nếu khách chưa nói.
- Không lưu mật khẩu.
- Không lưu OTP.
- Không lưu số thẻ ngân hàng.
- Không lưu dữ liệu thanh toán nhạy cảm.

Ví dụ:

MEMORY HIỆN TẠI:
{
  "numberOfPeople": 4,
  "itinerary": [],
  "specialRequests": [],
  "otherInformation": []
}

Khách nói:
"Ngày 1 tôi muốn đi Cửu Phần buổi sáng."

Memory mới phải là:
{
  "numberOfPeople": 4,
  "itinerary": [
    {
      "day": "Ngày 1",
      "visits": [
        {
          "location": "Cửu Phần",
          "time": "Buổi sáng"
        }
      ]
    }
  ],
  "specialRequests": [],
  "otherInformation": []
}

Ngôn ngữ giao diện:
${language || "vi-VN"}
`;

  const sourceText = context
    ? `Dữ liệu tham khảo nội bộ:\n${context}`
    : "Không tìm thấy dữ liệu nội bộ phù hợp.";

  const userText = `
${sourceText}

MEMORY HIỆN TẠI:
${JSON.stringify(
  currentMemory,
  null,
  2
)}

TIN NHẮN HIỆN TẠI CỦA KHÁCH:
${message}
`;

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent`;

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    40000
  );

  try {
    const response = await fetch(
      endpoint,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            GEMINI_API_KEY
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemInstruction
              }
            ]
          },

          contents: [
            {
              role: "user",

              parts: [
                {
                  text: userText
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.25,
            topP: 0.9,
            maxOutputTokens: 1800,
            responseMimeType:
              "application/json",
            responseSchema:
              GEMINI_RESPONSE_SCHEMA
          }
        }),

        signal: controller.signal
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      const detail =
        data?.error?.message ||
        `Gemini HTTP ${response.status}`;

      throw new Error(detail);
    }

    const rawText =
      data?.candidates?.[0]?.content
        ?.parts
        ?.map(
          (part) => part.text || ""
        )
        .join("")
        .trim();

    if (!rawText) {
      throw new Error(
        "Gemini không trả về nội dung."
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(
        "Gemini trả về JSON không hợp lệ."
      );
    }

    const answer = String(
      parsed.answer || ""
    ).trim();

    if (!answer) {
      throw new Error(
        "Gemini không trả về câu trả lời."
      );
    }

    return {
      answer,
      memory: sanitizeMemory(
        parsed.memory
      ),
      actionFlags: {
        contactStaff:
          parsed.actionFlags?.contactStaff === true,
    
        carBooking:
          parsed.actionFlags?.carBooking === true,
    
        visaConsultation:
          parsed.actionFlags?.visaConsultation === true
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/", (_req, res) => {
  res.json({
    service:
      "taiwan-travel-chatbot",
    status: "ok"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    knowledgeRecords:
      knowledgeBase.length,
    apiKeyConfigured: Boolean(
      GEMINI_API_KEY
    )
  });
});

app.post(
  "/chat",
  async (req, res) => {
    const message = String(
      req.body?.message || ""
    ).trim();

    const language = String(
      req.body?.language || "vi-VN"
    ).trim();

    const memory = sanitizeMemory(
      req.body?.memory
    );

    if (!message) {
      res.status(400).json({
        error: "Thiếu trường message."
      });

      return;
    }

    if (message.length > 4000) {
      res.status(400).json({
        error:
          "Câu hỏi quá dài. Tối đa 4.000 ký tự."
      });

      return;
    }

    try {
      const matches =
        retrieveContext(message);

      const context =
        buildContext(matches);

      const result =
        await callGemini({
          message,
          language,
          context,
          memory
        });

      res.json({
        answer: result.answer,
      
        memory: result.memory,
      
        actionFlags:
          result.actionFlags,
      
        actions: buildActions(
          message,
          result.actionFlags
        ),

        sources: matches
          .filter((item) => item.url)
          .map((item) => ({
            title: item.title,
            url: item.url
          }))
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error
      );

      const regionError =
        /location is not supported|region/i.test(
          error.message
        );

      res.status(502).json({
        error: regionError
          ? "Gemini từ chối vị trí máy chủ. Hãy kiểm tra khu vực triển khai máy chủ."
          : error.message ||
            "Không thể tạo câu trả lời."
      });
    }
  }
);

app.use(
  (error, _req, res, _next) => {
    console.error(error);

    res.status(500).json({
      error:
        error.message ||
        "Lỗi máy chủ."
    });
  }
);

await loadKnowledgeBase();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server listening on port ${PORT}`
    );
  }
);
