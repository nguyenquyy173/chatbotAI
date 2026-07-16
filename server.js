(() => {
  "use strict";

  const config = {
    apiUrl: window.APP_CONFIG?.apiUrl || "",
    language: window.APP_CONFIG?.language || "vi-VN",
    messengerUrl:
      window.APP_CONFIG?.messengerUrl ||
      "https://m.me/datxetaidailoan",
    VISAUrl:
      window.APP_CONFIG?.VISAUrl ||
      "https://m.me/VISADaiLoanKhongKho"
  };

  const form = document.getElementById("chat-form");
  const input = document.getElementById("prompt-input");
  const messages = document.getElementById("messages");
  const statusPill = document.getElementById("status-pill");
  const micButton = document.getElementById("mic-button");
  const assistantCore = document.getElementById("assistant-core");
  const assistantGif = document.getElementById("assistant-gif");
  const assistantFallback = document.getElementById("assistant-fallback");
  const sendButton = form.querySelector(".send-button");

  let conversationId = getConversationId();
  let recognition = null;
  let isListening = false;
  let requestController = null;

  function getConversationId() {
    const key = "taiwan-travel-chatbot-session";
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(key, value);
    }
    return value;
  }

  function setStatus(text, state = "ready") {
    statusPill.textContent = text;
    statusPill.dataset.state = state;
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendButton.disabled = busy;
    micButton.disabled = busy;
    assistantCore.classList.toggle("is-thinking", busy);
    setStatus(busy ? "Đang trả lời..." : "Sẵn sàng", busy ? "busy" : "ready");
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function addMessage(role, text, actions = []) {
    const article = document.createElement("article");
    article.className = `message ${role}`;

    const label = document.createElement("span");
    label.className = "message-role";
    label.textContent = role === "user" ? "Bạn" : "Trợ lý";

    const content = document.createElement("div");
    content.className = "message-content";
    renderText(content, text);

    article.append(label, content);

    if (actions.length) {
      const actionRow = document.createElement("div");
      actionRow.className = "message-actions";
      for (const action of actions) {
        const link = document.createElement("a");
        link.className = "action-button";
        link.href = action.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = action.label;
        actionRow.appendChild(link);
      }
      article.appendChild(actionRow);
    }

    messages.appendChild(article);
    article.scrollIntoView({ behavior: "smooth", block: "end" });
    return article;
  }

  function renderText(container, text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      const p = document.createElement("p");
      p.textContent = "Mình chưa nhận được nội dung trả lời.";
      container.appendChild(p);
      return;
    }

    const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    let list = null;

    for (const line of lines) {
      const bullet = line.match(/^[-•]\s+(.+)/);
      if (bullet) {
        if (!list) {
          list = document.createElement("ul");
          container.appendChild(list);
        }
        const li = document.createElement("li");
        li.textContent = bullet[1];
        list.appendChild(li);
      } else {
        list = null;
        const p = document.createElement("p");
        p.textContent = line;
        container.appendChild(p);
      }
    }
  }

  function inferActions(question, apiActions = []) {
    if (Array.isArray(apiActions) && apiActions.length) {
      return apiActions;
    }

    const text = String(question || "").toLocaleLowerCase("vi");
    const actions = [];

    const carIntent =
      /(đặt xe|thuê xe|cần xe|muốn xe|gọi xe|đưa đón|đón sân bay|xe sân bay|taxi|book xe)/i.test(
        text
      );

    const visaIntent =
      /(visa|thị thực|xin visa|làm visa|tư vấn visa|hồ sơ visa|gia hạn visa)/i.test(
        text
      );

    if (carIntent) {
      actions.push({
        label: "Đặt xe qua Messenger",
        url: config.messengerUrl
      });
    }

    if (visaIntent) {
      actions.push({
        label: "Tư vấn visa",
        url: config.visaUrl
      });
    }

    return actions;
  }

  async function sendMessage(question) {
    if (!config.apiUrl || config.apiUrl.includes("YOUR-CLOUD-RUN-URL")) {
      throw new Error("Bạn chưa thay apiUrl trong index.html bằng URL Cloud Run thật.");
    }

    requestController?.abort();
    requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), 45000);

    try {
      const response = await fetch(config.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          language: config.language,
          sessionId: conversationId
        }),
        signal: requestController.signal
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Máy chủ trả lỗi ${response.status}.`);
      }

      return {
        answer: payload.answer || payload.reply || "",
        actions: payload.actions || []
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Yêu cầu mất quá nhiều thời gian. Bạn hãy thử lại.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    addMessage("user", question);
    input.value = "";
    autoResize();
    setBusy(true);

    try {
      const result = await sendMessage(question);
      addMessage("assistant", result.answer, inferActions(question, result.actions));
    } catch (error) {
      console.error(error);
      setStatus("Có lỗi", "error");
      addMessage("assistant", `Không thể kết nối chatbot.\n- ${error.message}`);
    } finally {
      setBusy(false);
      input.focus();
    }
  });

  input.addEventListener("input", autoResize);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      micButton.hidden = true;
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = config.language;
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      isListening = true;
      micButton.classList.add("is-listening");
      setStatus("Đang nghe...", "busy");
    };

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      input.value = transcript.trim();
      autoResize();
    };

    recognition.onend = () => {
      isListening = false;
      micButton.classList.remove("is-listening");
      setStatus("Sẵn sàng", "ready");
      input.focus();
    };

    recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);
      setStatus("Không nghe rõ", "error");
    };

    micButton.addEventListener("click", () => {
      if (isListening) recognition.stop();
      else recognition.start();
    });
  }

  assistantGif.addEventListener("error", () => {
    assistantGif.hidden = true;
    assistantFallback.setAttribute("aria-hidden", "false");
  });

  function createActionButtons(actions = []) {
    if (!Array.isArray(actions) || actions.length === 0) {
      return null;
    }

    const container = document.createElement("div");
    container.className = "action-buttons";

    actions.forEach((action) => {
      if (!action?.url || !action?.label) return;

      const button = document.createElement("a");
      button.className = "action-button";
      button.href = action.url;
      button.target = "_blank";
      button.rel = "noopener noreferrer";
      button.textContent = action.label;

      container.appendChild(button);
    });

    return container;
  }

  const actionsElement = createActionButtons(data.actions);

  if (actionsElement) {
    messageElement.appendChild(actionsElement);
  }
  setupSpeechRecognition();
  autoResize();
})();
