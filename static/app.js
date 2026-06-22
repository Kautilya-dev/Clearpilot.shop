const modeAskBtn = document.getElementById("modeAskBtn");
const modePracticeBtn = document.getElementById("modePracticeBtn");
const askMode = document.getElementById("askMode");
const practiceMode = document.getElementById("practiceMode");

const micBtn = document.getElementById("micBtn");
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("askBtn");
const statusEl = document.getElementById("status");
const answerBox = document.getElementById("answerBox");
const answerStructuredEl = document.getElementById("answerStructured");
const historyList = document.getElementById("historyList");

const nextQBtn = document.getElementById("nextQBtn");
const revealBtn = document.getElementById("revealBtn");
const practiceQuestionEl = document.getElementById("practiceQuestion");
const practiceAnswerEl = document.getElementById("practiceAnswer");
const practiceStructuredEl = document.getElementById("practiceStructured");
const debugInfoEl = document.getElementById("debugInfo");
const practiceDebugInfoEl = document.getElementById("practiceDebugInfo");

let history = [];
let chatMemory = []; // Ask-mode conversational memory only (not practice mode)
let currentPracticeQuestion = null;
const MAX_MEMORY_TURNS = 4;
const STRUCTURED_SENTINEL = "<<<CLEARPILOT_STRUCTURED>>>";

function setMode(mode) {
  const isAsk = mode === "ask";
  modeAskBtn.classList.toggle("btn-primary", isAsk);
  modeAskBtn.classList.toggle("btn-outline-primary", !isAsk);
  modePracticeBtn.classList.toggle("btn-primary", !isAsk);
  modePracticeBtn.classList.toggle("btn-outline-primary", isAsk);
  askMode.classList.toggle("d-none", !isAsk);
  practiceMode.classList.toggle("d-none", isAsk);
}

modeAskBtn.addEventListener("click", () => setMode("ask"));
modePracticeBtn.addEventListener("click", () => setMode("practice"));

function renderHistory() {
  historyList.innerHTML = history
    .slice()
    .reverse()
    .map(
      (item) => `
      <div class="list-group-item bg-body-tertiary">
        <div class="history-item-q">${escapeHtml(item.question)}</div>
        <div class="history-item-a">${escapeHtml(item.answer)}</div>
      </div>`
    )
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderDebugInfo(debugEl, source, sources) {
  if (!source) {
    debugEl.classList.add("d-none");
    return;
  }
  const label = source === "cache" ? "instant cache hit" : source === "live" ? "live Claude call" : "error";
  debugEl.textContent = `Debug: ${label} | sources used: ${sources || "none"}`;
  debugEl.classList.remove("d-none");
}

function renderStructured(el, structured) {
  el.innerHTML = "";
  if (!structured) return;
  const points = structured.key_points || [];
  const evidence = structured.evidence || [];
  const confidence = structured.confidence;

  if (points.length) {
    const ul = document.createElement("ul");
    ul.className = "mb-2 ps-3";
    points.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  if (evidence.length) {
    const wrap = document.createElement("div");
    wrap.className = "d-flex flex-wrap gap-1 mb-2";
    evidence.forEach((e) => {
      const chip = document.createElement("span");
      chip.className = "badge text-bg-secondary";
      chip.title = e.snippet || "";
      chip.textContent = e.section ? `${e.source} — ${e.section}` : e.source;
      wrap.appendChild(chip);
    });
    el.appendChild(wrap);
  }

  if (confidence) {
    const variant = confidence === "high" ? "success" : confidence === "low" ? "danger" : "warning";
    const badge = document.createElement("span");
    badge.className = `badge text-bg-${variant}`;
    badge.textContent = `Confidence: ${confidence}`;
    el.appendChild(badge);
  }
}

// Splits a streamed/cached response into {prose, structured} on the in-band sentinel
// the server appends after the answer (see STRUCTURED_TRAILER_SENTINEL in server.py).
function splitStructured(full) {
  const idx = full.indexOf(STRUCTURED_SENTINEL);
  if (idx === -1) return { prose: full, structured: null };
  const prose = full.slice(0, idx).trim();
  let structured = null;
  try {
    structured = JSON.parse(full.slice(idx + STRUCTURED_SENTINEL.length).trim());
  } catch (e) {
    structured = null;
  }
  return { prose, structured };
}

async function streamAnswer(question, targetEl, onDone, { sendHistory = false, debugEl = null, structuredEl = null } = {}) {
  targetEl.textContent = "";
  if (structuredEl) structuredEl.innerHTML = "";
  const t0 = performance.now();
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      history: sendHistory ? chatMemory.slice(-MAX_MEMORY_TURNS) : [],
    }),
  });

  if (debugEl) {
    renderDebugInfo(debugEl, res.headers.get("X-Answer-Source"), res.headers.get("X-Sources"));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let firstChunk = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunk) {
      statusEl.textContent = `First response in ${Math.round(performance.now() - t0)}ms`;
      firstChunk = false;
    }
    full += decoder.decode(value, { stream: true });
    // Only ever display the part before the sentinel - the trailer is structured
    // data, not prose, and shouldn't flash on screen while still streaming in.
    const idx = full.indexOf(STRUCTURED_SENTINEL);
    targetEl.textContent = idx === -1 ? full : full.slice(0, idx);
  }

  const { prose, structured } = splitStructured(full);
  targetEl.textContent = prose;
  if (structuredEl) renderStructured(structuredEl, structured);

  if (onDone) onDone(prose, structured);
}

async function askQuestion(question) {
  if (!question.trim()) return;
  statusEl.textContent = "Thinking...";
  await streamAnswer(
    question,
    answerBox,
    (answerText) => {
      history.push({ question, answer: answerText });
      chatMemory.push({ question, answer: answerText });
      renderHistory();
    },
    { sendHistory: true, debugEl: debugInfoEl, structuredEl: answerStructuredEl }
  );
}

askBtn.addEventListener("click", () => {
  const q = questionInput.value;
  askQuestion(q);
});

questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    askQuestion(questionInput.value);
  }
});

// --- Mic input (push-to-talk via Web Speech API, not continuous listening) ---
let recognition = null;
let isRecording = false;

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognitionImpl) {
  recognition = new SpeechRecognitionImpl();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    questionInput.value = transcript;
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove("recording");
    if (questionInput.value.trim()) {
      askQuestion(questionInput.value);
    }
  };

  recognition.onerror = (e) => {
    isRecording = false;
    micBtn.classList.remove("recording");
    statusEl.textContent = `Mic error: ${e.error}`;
  };

  micBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    questionInput.value = "";
    statusEl.textContent = "Listening...";
    isRecording = true;
    micBtn.classList.add("recording");
    recognition.start();
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition isn't supported in this browser - try Chrome";
}

// --- Practice mode ---
async function loadNextPracticeQuestion() {
  practiceAnswerEl.textContent = "";
  practiceStructuredEl.innerHTML = "";
  practiceDebugInfoEl.classList.add("d-none");
  revealBtn.disabled = true;
  const res = await fetch("/api/practice-question");
  const data = await res.json();
  currentPracticeQuestion = data.question;
  practiceQuestionEl.textContent = currentPracticeQuestion || "No practice questions available yet - run build_index.py first.";
  revealBtn.disabled = !currentPracticeQuestion;
}

nextQBtn.addEventListener("click", loadNextPracticeQuestion);

revealBtn.addEventListener("click", () => {
  if (!currentPracticeQuestion) return;
  revealBtn.disabled = true;
  streamAnswer(
    currentPracticeQuestion,
    practiceAnswerEl,
    (answerText) => {
      history.push({ question: currentPracticeQuestion, answer: answerText });
      renderHistory();
    },
    { sendHistory: false, debugEl: practiceDebugInfoEl, structuredEl: practiceStructuredEl }
  );
});

// --- Document upload ---
const uploadInput = document.getElementById("uploadInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatusEl = document.getElementById("uploadStatus");

uploadBtn.addEventListener("click", async () => {
  const file = uploadInput.files[0];
  if (!file) {
    uploadStatusEl.textContent = "Choose a file first.";
    return;
  }
  uploadBtn.disabled = true;
  uploadStatusEl.textContent = "Uploading and indexing...";

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) {
      uploadStatusEl.textContent = `Error: ${data.detail || "upload failed"}`;
    } else {
      uploadStatusEl.textContent = `Added "${data.filename}" - ${data.chunks_added} chunks (total ${data.total_chunks}).`;
      uploadInput.value = "";
    }
  } catch (e) {
    uploadStatusEl.textContent = `Error: ${e.message}`;
  } finally {
    uploadBtn.disabled = false;
  }
});
