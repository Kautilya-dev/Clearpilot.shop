const navAskBtn = document.getElementById("navAskBtn");
const navPracticeBtn = document.getElementById("navPracticeBtn");
const askMode = document.getElementById("askMode");
const practiceMode = document.getElementById("practiceMode");
const pageTitleEl = document.getElementById("pageTitle");

const micBtn = document.getElementById("micBtn");
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("askBtn");
const statusEl = document.getElementById("status");
const conversationTranscriptEl = document.getElementById("conversationTranscript");
const debugInfoEl = document.getElementById("debugInfo");

const newConversationBtn = document.getElementById("newConversationBtn");
const conversationListEl = document.getElementById("conversationList");

const nextQBtn = document.getElementById("nextQBtn");
const revealBtn = document.getElementById("revealBtn");
const practiceQuestionEl = document.getElementById("practiceQuestion");
const practiceStatusEl = document.getElementById("practiceStatus");
const practiceAnswerEl = document.getElementById("practiceAnswer");
const practiceStructuredEl = document.getElementById("practiceStructured");
const practiceDebugInfoEl = document.getElementById("practiceDebugInfo");
const practiceHistorySectionEl = document.getElementById("practiceHistorySection");
const practiceHistoryListEl = document.getElementById("practiceHistoryList");

let practiceHistory = []; // Practice mode only - ephemeral, this page-load only.
let currentPracticeQuestion = null;
let activeConversationId = null; // Ask mode's persisted conversation (server-side history).
const STRUCTURED_SENTINEL = "<<<CLEARPILOT_STRUCTURED>>>";

marked.setOptions({ breaks: true, gfm: true });

// Renders model output as formatted markdown (bold/headers/lists/tables) instead of
// raw "**text**" syntax. DOMPurify strips any HTML the model's answer might contain -
// answers are grounded in uploaded documents, which are untrusted input.
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

function icon(name, className) {
  const i = document.createElement("i");
  i.setAttribute("data-lucide", name);
  if (className) i.className = className;
  return i;
}

function toggleSidebar(show) {
  document.getElementById("sidebar").classList.toggle("-translate-x-full", !show);
  document.getElementById("sidebarOverlay").classList.toggle("hidden", !show);
}

function setMode(mode) {
  const isAsk = mode === "ask";
  navAskBtn.classList.toggle("active", isAsk);
  navPracticeBtn.classList.toggle("active", !isAsk);
  askMode.classList.toggle("hidden", !isAsk);
  practiceMode.classList.toggle("hidden", isAsk);
  practiceHistorySectionEl.classList.toggle("hidden", isAsk);
  pageTitleEl.textContent = isAsk ? "Ask" : "Practice";
  if (window.innerWidth < 1024) toggleSidebar(false);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderDebugInfo(debugEl, source, sources) {
  if (!source) {
    debugEl.classList.add("hidden");
    return;
  }
  const label = source === "cache" ? "instant cache hit" : source === "live" ? "live Claude call" : "error";
  debugEl.textContent = `Debug: ${label} | sources used: ${sources || "none"}`;
  debugEl.classList.remove("hidden");
}

function renderStructured(el, structured) {
  el.innerHTML = "";
  if (!structured) return;
  const points = structured.key_points || [];
  const evidence = structured.evidence || [];
  const confidence = structured.confidence;

  if (points.length) {
    const ul = document.createElement("ul");
    ul.className = "list-disc ml-4 space-y-1 text-sm text-slate-600 mb-3";
    points.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  if (evidence.length) {
    const wrap = document.createElement("div");
    wrap.className = "flex flex-wrap gap-1.5 mb-3";
    evidence.forEach((e) => {
      const chip = document.createElement("span");
      chip.className = "citation-chip";
      chip.title = e.snippet || "";
      chip.textContent = e.section ? `${e.source} — ${e.section}` : e.source;
      wrap.appendChild(chip);
    });
    el.appendChild(wrap);
  }

  if (confidence) {
    const styles = {
      high: "bg-emerald-50 text-emerald-600",
      medium: "bg-amber-50 text-amber-600",
      low: "bg-red-50 text-red-600",
    };
    const badge = document.createElement("span");
    badge.className = `inline-flex text-xs font-semibold px-2.5 py-1 rounded-full ${styles[confidence] || styles.medium}`;
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

function formatDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function streamAnswer(question, targetEl, onDone, { conversationId = null, debugEl = null, structuredEl = null, statusTarget = statusEl } = {}) {
  targetEl.innerHTML = "";
  if (structuredEl) structuredEl.innerHTML = "";
  statusTarget.classList.remove("text-emerald-600");
  statusTarget.classList.add("text-slate-400");
  const t0 = performance.now();
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      conversation_id: conversationId,
    }),
  });

  if (debugEl) {
    renderDebugInfo(debugEl, res.headers.get("X-Answer-Source"), res.headers.get("X-Sources"));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let firstChunkAt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkAt === null) {
      firstChunkAt = performance.now();
      statusTarget.textContent = `Started responding in ${formatDuration(firstChunkAt - t0)}...`;
    }
    full += decoder.decode(value, { stream: true });
    // Only ever display the part before the sentinel - the trailer is structured
    // data, not prose, and shouldn't flash on screen while still streaming in.
    const idx = full.indexOf(STRUCTURED_SENTINEL);
    targetEl.innerHTML = renderMarkdown(idx === -1 ? full : full.slice(0, idx));
  }

  const finishedAt = performance.now();
  const startedIn = (firstChunkAt ?? finishedAt) - t0;
  statusTarget.textContent = `Started in ${formatDuration(startedIn)} · finished in ${formatDuration(finishedAt - t0)}`;
  statusTarget.classList.remove("text-slate-400");
  statusTarget.classList.add("text-emerald-600");

  const { prose, structured } = splitStructured(full);
  targetEl.innerHTML = renderMarkdown(prose);
  if (structuredEl) renderStructured(structuredEl, structured);

  if (onDone) onDone(prose, structured);
}

// --- Ask mode: conversation transcript ---

function buildTranscriptCard(question) {
  const card = document.createElement("div");
  card.className = "bg-white border border-slate-200 rounded-xl p-4";

  const qEl = document.createElement("div");
  qEl.className = "history-item-q text-sm mb-2";
  qEl.textContent = question;

  const answerEl = document.createElement("div");
  answerEl.className = "markdown-body text-sm leading-relaxed";

  const structuredEl = document.createElement("div");
  structuredEl.className = "mt-3";

  card.appendChild(qEl);
  card.appendChild(answerEl);
  card.appendChild(structuredEl);
  return { card, answerEl, structuredEl };
}

function renderTranscript(conversation) {
  conversationTranscriptEl.innerHTML = "";
  conversation.messages.forEach((msg) => {
    const { card, answerEl, structuredEl } = buildTranscriptCard(msg.question);
    answerEl.innerHTML = renderMarkdown(msg.answer);
    renderStructured(structuredEl, msg);
    conversationTranscriptEl.appendChild(card);
  });
  conversationTranscriptEl.scrollTop = conversationTranscriptEl.scrollHeight;
}

function appendLiveCard(question) {
  const { card, answerEl, structuredEl } = buildTranscriptCard(question);
  conversationTranscriptEl.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
  return { answerEl, structuredEl };
}

async function askQuestion(question) {
  if (!question.trim() || !activeConversationId) return;
  statusEl.textContent = "Thinking...";
  const { answerEl, structuredEl } = appendLiveCard(question);
  await streamAnswer(
    question,
    answerEl,
    () => {
      // Title may have just auto-set from this question, and updated_at changed -
      // refresh the sidebar order/label without re-fetching the whole transcript.
      loadConversations();
    },
    { conversationId: activeConversationId, debugEl: debugInfoEl, structuredEl, statusTarget: statusEl }
  );
}

askBtn.addEventListener("click", () => {
  const q = questionInput.value;
  questionInput.value = "";
  askQuestion(q);
});

questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = questionInput.value;
    questionInput.value = "";
    askQuestion(q);
  }
});

// --- Conversations sidebar ---

async function loadConversations() {
  const res = await fetch("/api/conversations");
  const conversations = await res.json();
  renderConversationList(conversations);
  return conversations;
}

function renderConversationList(conversations) {
  conversationListEl.innerHTML = "";
  conversations.forEach((conv) => {
    const row = document.createElement("div");
    row.className = "nav-item w-full cursor-pointer justify-between" + (conv.id === activeConversationId ? " active" : "");
    row.addEventListener("click", () => selectConversation(conv.id));

    const titleSpan = document.createElement("span");
    titleSpan.className = "flex-1 truncate text-left";
    titleSpan.textContent = conv.title;

    const actions = document.createElement("div");
    actions.className = "flex items-center gap-1 flex-shrink-0";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.title = "Rename";
    renameBtn.className = "text-slate-400 hover:text-white";
    renameBtn.appendChild(icon("pencil", "w-3.5 h-3.5"));
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(row, titleSpan, conv);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.title = "Delete";
    deleteBtn.className = "text-slate-400 hover:text-red-300";
    deleteBtn.appendChild(icon("trash-2", "w-3.5 h-3.5"));
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversationHandler(conv.id);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(titleSpan);
    row.appendChild(actions);
    conversationListEl.appendChild(row);
  });
  lucide.createIcons();
}

function startRename(row, titleSpan, conv) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = conv.title;
  input.className = "flex-1 bg-slate-800 text-white text-sm rounded px-1.5 py-0.5 border border-brand-500 focus:outline-none";

  const commitRename = () => {
    const title = input.value.trim() || conv.title;
    if (row.contains(input)) row.replaceChild(titleSpan, input);
    titleSpan.textContent = title;
    if (title !== conv.title) {
      fetch(`/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then(() => loadConversations());
    }
  };
  const cancelRename = () => {
    if (row.contains(input)) row.replaceChild(titleSpan, input);
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") cancelRename();
  });
  input.addEventListener("blur", commitRename);

  row.replaceChild(input, titleSpan);
  input.focus();
  input.select();
}

async function deleteConversationHandler(id) {
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (id === activeConversationId) {
    const conversations = await loadConversations();
    if (conversations.length) {
      await selectConversation(conversations[0].id);
    } else {
      await createNewConversation();
    }
  } else {
    loadConversations();
  }
}

async function selectConversation(id) {
  activeConversationId = id;
  await loadConversations(); // also refreshes sidebar highlighting
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) return;
  renderTranscript(await res.json());
  if (window.innerWidth < 1024) toggleSidebar(false);
}

async function createNewConversation() {
  const res = await fetch("/api/conversations", { method: "POST" });
  const conversation = await res.json();
  activeConversationId = conversation.id;
  await loadConversations();
  renderTranscript(conversation);
  questionInput.value = "";
  questionInput.focus();
}

newConversationBtn.addEventListener("click", createNewConversation);

async function initConversations() {
  questionInput.disabled = true;
  askBtn.disabled = true;
  const conversations = await loadConversations();
  if (conversations.length === 0) {
    await createNewConversation();
  } else {
    await selectConversation(conversations[0].id); // list is already most-recent-first
  }
  questionInput.disabled = false;
  askBtn.disabled = false;
}

initConversations();

// --- Mic input (hands-free via Web Speech API): click once, ask any number of
// questions back to back - each pause auto-submits, then listening resumes on its
// own once the answer is done. Click again to stop. Speech-to-text only, no
// spoken replies - answers stay on screen as text like everywhere else in the app.
let recognition = null;
let isRecording = false;
let handsFreeMode = false;
let stoppedByUser = false;

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

  recognition.onend = async () => {
    isRecording = false;
    micBtn.classList.remove("recording");
    const question = questionInput.value.trim();
    questionInput.value = "";
    if (question) {
      await askQuestion(question);
    }
    if (handsFreeMode && !stoppedByUser) {
      startListening();
    }
  };

  recognition.onerror = (e) => {
    isRecording = false;
    micBtn.classList.remove("recording");
    statusEl.textContent = `Mic error: ${e.error}`;
    // "no-speech" just means a quiet pause between questions - keep the hands-free
    // loop going. Anything else (permission denied, no mic, etc.) won't fix itself
    // by retrying, so give up the loop.
    if (e.error !== "no-speech" && e.error !== "aborted") {
      handsFreeMode = false;
    }
  };

  function startListening() {
    questionInput.value = "";
    statusEl.textContent = "Listening... click the mic to stop";
    isRecording = true;
    stoppedByUser = false;
    micBtn.classList.add("recording");
    recognition.start();
  }

  micBtn.addEventListener("click", () => {
    if (isRecording || handsFreeMode) {
      stoppedByUser = true;
      handsFreeMode = false;
      recognition.stop();
      return;
    }
    handsFreeMode = true;
    startListening();
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition isn't supported in this browser - try Chrome";
}

// --- Practice mode ---

function renderPracticeHistory() {
  practiceHistoryListEl.innerHTML = practiceHistory
    .slice()
    .reverse()
    .map(
      (item) => `
      <div class="bg-white border border-slate-200 rounded-xl p-3">
        <div class="history-item-q text-sm">${escapeHtml(item.question)}</div>
        <div class="history-item-a markdown-body">${renderMarkdown(item.answer)}</div>
      </div>`
    )
    .join("");
}

async function loadNextPracticeQuestion() {
  practiceAnswerEl.textContent = "";
  practiceStructuredEl.innerHTML = "";
  practiceStatusEl.textContent = "";
  practiceStatusEl.classList.remove("text-emerald-600");
  practiceDebugInfoEl.classList.add("hidden");
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
  practiceStatusEl.textContent = "Thinking...";
  streamAnswer(
    currentPracticeQuestion,
    practiceAnswerEl,
    (answerText) => {
      practiceHistory.push({ question: currentPracticeQuestion, answer: answerText });
      renderPracticeHistory();
    },
    { debugEl: practiceDebugInfoEl, structuredEl: practiceStructuredEl, statusTarget: practiceStatusEl }
  );
});

// --- Document upload ---
const uploadInput = document.getElementById("uploadInput");
const uploadStatusEl = document.getElementById("uploadStatus");
const sidebarDropzone = document.getElementById("sidebarDropzone");

async function uploadFile(file) {
  if (!file) return;
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
    }
  } catch (e) {
    uploadStatusEl.textContent = `Error: ${e.message}`;
  }
}

function handleFileSelect(event) {
  uploadFile(event.target.files[0]);
  event.target.value = "";
}

function handleDrop(event) {
  event.preventDefault();
  sidebarDropzone.classList.remove("drag-over");
  uploadFile(event.dataTransfer.files[0]);
}
