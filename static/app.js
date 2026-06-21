const modeAskBtn = document.getElementById("modeAskBtn");
const modePracticeBtn = document.getElementById("modePracticeBtn");
const askMode = document.getElementById("askMode");
const practiceMode = document.getElementById("practiceMode");

const micBtn = document.getElementById("micBtn");
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("askBtn");
const statusEl = document.getElementById("status");
const answerBox = document.getElementById("answerBox");
const historyList = document.getElementById("historyList");

const nextQBtn = document.getElementById("nextQBtn");
const revealBtn = document.getElementById("revealBtn");
const practiceQuestionEl = document.getElementById("practiceQuestion");
const practiceAnswerEl = document.getElementById("practiceAnswer");
const debugInfoEl = document.getElementById("debugInfo");
const practiceDebugInfoEl = document.getElementById("practiceDebugInfo");

let history = [];
let chatMemory = []; // Ask-mode conversational memory only (not practice mode)
let currentPracticeQuestion = null;
const MAX_MEMORY_TURNS = 4;

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

async function streamAnswer(question, targetEl, onDone, { sendHistory = false, debugEl = null } = {}) {
  targetEl.textContent = "";
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
    const text = decoder.decode(value, { stream: true });
    full += text;
    targetEl.textContent = full;
  }

  if (onDone) onDone(full);
}

async function askQuestion(question) {
  if (!question.trim()) return;
  statusEl.textContent = "Thinking...";
  await streamAnswer(
    question,
    answerBox,
    (full) => {
      history.push({ question, answer: full });
      chatMemory.push({ question, answer: full });
      renderHistory();
    },
    { sendHistory: true, debugEl: debugInfoEl }
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
    (full) => {
      history.push({ question: currentPracticeQuestion, answer: full });
      renderHistory();
    },
    { sendHistory: false, debugEl: practiceDebugInfoEl }
  );
});
