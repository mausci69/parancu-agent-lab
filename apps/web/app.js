"use strict";

const byId = id => document.getElementById(id);
const storageKey = "parancu.web.corpusId";
let corpus = null;
let file = null;
let preparingRequest = false;
let asking = false;
let pollVersion = 0;
let mode = "txt";
let keyState = { ready: false, source: "none" };
let settingsBusy = false;

function showKeyStatus(status) {
  keyState = status;
  byId("key-status").textContent = status.ready ? "OpenAI ready" : "OpenAI key missing";
  byId("key-status").className = status.ready ? "badge ready" : "badge";
  byId("settings-status").textContent = status.source === "session"
    ? "Ready · using a session key."
    : "Add a key to prepare TXT documents or ask questions. Import and export work without a key.";
  byId("remove-key").disabled = settingsBusy || status.source !== "session";
  controls();
}

async function refreshKeyStatus() {
  try { showKeyStatus(await api("/api/settings/openai")); }
  catch { showKeyStatus({ ready: false, source: "none" }); }
}

byId("settings").addEventListener("click", () => {
  byId("settings-error").hidden = true;
  byId("openai-key").value = "";
  byId("settings-dialog").showModal();
  void refreshKeyStatus();
});
byId("close-settings").addEventListener("click", () => byId("settings-dialog").close());
byId("settings-dialog").addEventListener("close", () => { byId("openai-key").value = ""; });
window.addEventListener("pagehide", () => { byId("openai-key").value = ""; });
window.addEventListener("focus", () => { void refreshKeyStatus(); });

async function updateKey(remove) {
  if (settingsBusy) return;
  settingsBusy = true;
  byId("save-key").disabled = true;
  byId("remove-key").disabled = true;
  byId("settings-error").hidden = true;
  try {
    // The password input and request body are the only browser holders of the key.
    const request = api("/api/settings/openai", remove ? { method: "DELETE" } : {
      method: "PUT", body: JSON.stringify({ key: byId("openai-key").value })
    });
    byId("openai-key").value = "";
    const status = await request;
    // Close on API success before rendering page controls, which may throw.
    if (!remove) byId("settings-dialog").close();
    showKeyStatus(status);
  } catch {
    byId("settings-error").textContent = "Could not update the key. Use a valid OpenAI key and check the server connection.";
    byId("settings-error").hidden = false;
  } finally {
    byId("openai-key").value = "";
    settingsBusy = false;
    byId("save-key").disabled = false;
    byId("remove-key").disabled = keyState.source !== "session";
  }
}
byId("key-form").addEventListener("submit", event => { event.preventDefault(); void updateKey(false); });
byId("remove-key").addEventListener("click", () => { void updateKey(true); });

function updateModeAppearance() {
  byId("document-file").accept = mode === "txt" ? ".txt,text/plain" : ".json,application/json";
  byId("document-file").setAttribute("aria-label", mode === "txt" ? "Choose a single TXT document" : "Choose a prepared corpus JSON file");
  byId("mode-txt").setAttribute("aria-pressed", String(mode === "txt"));
  byId("mode-import").setAttribute("aria-pressed", String(mode === "import"));
  byId("upload-title").textContent = mode === "txt" ? "Choose a TXT file" : "Choose a prepared corpus";
  byId("upload-description").textContent = mode === "txt" ? "Start your search here" : "Reuse existing metadata and embeddings";
  byId("upload-limit").textContent = mode === "txt" ? "UTF-8 · up to 1 MiB · one file" : "ParancU JSON · up to 32 MiB · no AI calls";
}

function selectMode(next) {
  if (preparingRequest || asking || corpus?.status === "preparing") return;
  mode = next;
  file = null; corpus = null; ++pollVersion;
  remember(null);
  byId("document-file").value = "";
  updateModeAppearance();
  byId("selected-file").hidden = true;
  byId("corpus-stats").hidden = true;
  byId("corpus-origin").hidden = true;
  byId("export-corpus").hidden = true;
  byId("retry-status").hidden = true;
  byId("document-badge").textContent = "Waiting for a document";
  byId("document-badge").className = "badge";
  byId("document-status").textContent = mode === "txt" ? "Upload a document to get started." : "Choose the language for legacy JSON. Versioned exports retain their saved language.";
  resetAnswer(); pipeline("initial"); errorMessage(""); controls();
}
byId("mode-txt").addEventListener("click", () => selectMode("txt"));
byId("mode-import").addEventListener("click", () => selectMode("import"));

function remember(id) {
  try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); }
  catch { /* Storage may be unavailable in private browser settings. */ }
}

function errorMessage(message) {
  byId("error").textContent = message;
  byId("error").hidden = !message;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function controls() {
  const preparing = preparingRequest || corpus?.status === "preparing";
  const locked = preparing || asking;
  byId("document-file").disabled = locked;
  byId("mode-txt").disabled = locked;
  byId("mode-import").disabled = locked;
  byId("file-picker").classList.toggle("disabled", locked);
  byId("language").disabled = locked || corpus?.status === "ready";
  byId("prepare").disabled = !file || locked || corpus?.status === "ready" || (mode === "txt" && !keyState.ready);
  byId("prepare").textContent = preparing ? (mode === "import" ? "Importing…" : "Preparing…") : mode === "import" ? "Import corpus ↗" : "Prepare document ↗";
  byId("question").disabled = corpus?.status !== "ready" || asking || !keyState.ready;
  byId("ask").disabled = corpus?.status !== "ready" || asking || !keyState.ready || !byId("question").value.trim();
  byId("ask").textContent = asking ? "Finding an answer…" : "Find an answer →";
  byId("question-hint").textContent = !keyState.ready ? "Add an OpenAI key in Settings to ask questions." : corpus?.status === "ready"
    ? "A specific question helps find the right evidence."
    : "You can ask a question once preparation is complete.";
}

function pipeline(mode) {
  ["document", "retrieve", "generate", "verify"].forEach((name, index) => {
    const node = byId(`step-${name}`);
    node.className = "";
    if (mode === "complete" || (index === 0 && (mode === "ready" || mode === "asking"))) node.classList.add("complete");
    else if (index === 0) node.classList.add("active");
    if (mode === "asking" && index > 0) node.classList.add("working");
  });
}

function showCorpus(info) {
  corpus = info;
  mode = info.origin === "imported" ? "import" : "txt";
  updateModeAppearance();
  byId("file-name").textContent = info.name;
  byId("selected-file").hidden = false;
  byId("language").value = info.language;
  byId("file-size").textContent = info.language === "it" ? "Italian" : "English";
  const ready = info.status === "ready";
  const failed = info.status === "failed";
  byId("document-badge").textContent = ready ? "Document ready" : failed ? "Preparation failed" : "Preparing document";
  byId("document-badge").className = `badge ${ready ? "ready" : failed ? "failed" : ""}`;
  byId("document-status").textContent = ready
    ? "Corpus saved. Ask more questions without preparing it again."
    : failed ? info.error : "Generating metadata and embeddings. This may take several minutes; percentage progress is not available.";
  byId("corpus-stats").hidden = !ready;
  byId("export-corpus").hidden = !ready;
  byId("corpus-origin").hidden = !ready;
  if (ready) {
    byId("export-corpus").href = `/api/corpora/${encodeURIComponent(info.id)}/export`;
    byId("export-corpus").setAttribute("download", "");
    byId("corpus-origin").textContent = info.origin === "imported" ? "Imported prepared corpus · ready to use" : "Created from TXT";
  }
  if (ready) {
    byId("chunk-count").textContent = String(info.chunks);
    byId("sentence-count").textContent = String(info.sentences);
  }
  pipeline(ready ? "ready" : "initial");
  controls();
}

async function poll(id, version) {
  try {
    const info = await api(`/api/corpora/${encodeURIComponent(id)}`);
    if (version !== pollVersion) return;
    byId("retry-status").hidden = true;
    showCorpus(info);
    if (info.status === "preparing") setTimeout(() => poll(id, version), 1200);
    else if (info.status === "ready") byId("question").focus();
  } catch (error) {
    if (version !== pollVersion) return;
    errorMessage(`${error.message} If the server is still running, check the status again.`);
    byId("retry-status").hidden = false;
    byId("retry-status").onclick = () => { errorMessage(""); void poll(id, ++pollVersion); };
  }
}

function resetAnswer() {
  byId("answer-content").hidden = true;
  byId("answer-placeholder").hidden = false;
  byId("evidence-panel").hidden = true;
  byId("evidence-list").replaceChildren();
  byId("answer-badge").textContent = "READY TO EXPLORE";
  byId("answer-badge").className = "badge";
  byId("citation").hidden = true;
  byId("verification").hidden = true;
}

byId("document-file").addEventListener("change", () => {
  const selected = byId("document-file").files[0];
  if (!selected) return;
  const extension = mode === "txt" ? ".txt" : ".json";
  const limit = mode === "txt" ? 1 : 32;
  if (!selected.name.toLowerCase().endsWith(extension) || selected.size > limit * 1024 * 1024 || !selected.size) {
    errorMessage(`Choose a non-empty ${extension} file up to ${limit} MiB.`);
    byId("document-file").value = "";
    return;
  }
  file = selected;
  corpus = null;
  ++pollVersion;
  remember(null);
  errorMessage("");
  resetAnswer();
  pipeline("initial");
  byId("retry-status").hidden = true;
  byId("selected-file").hidden = false;
  byId("file-name").textContent = file.name;
  byId("file-size").textContent = `${(file.size / 1024).toFixed(1)} KiB · original unchanged`;
  byId("document-badge").textContent = "Ready to prepare";
  byId("document-badge").className = "badge";
  byId("document-status").textContent = "Choose the document language and start preparation.";
  byId("corpus-stats").hidden = true;
  byId("corpus-origin").hidden = true;
  byId("export-corpus").hidden = true;
  byId("document-badge").textContent = mode === "txt" ? "Ready to prepare" : "Ready to import";
  byId("document-status").textContent = mode === "txt" ? "Choose the language and prepare your document." : "Import validates the saved metadata and embeddings without calling OpenAI or E5.";
  controls();
});

byId("prepare").addEventListener("click", async () => {
  if (!file || preparingRequest || asking || corpus?.status === "preparing" || corpus?.status === "ready") return;
  if (mode === "txt" && !keyState.ready) { errorMessage("Add an OpenAI key in Settings first."); return; }
  preparingRequest = true;
  controls();
  errorMessage("");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    let saved;
    if (mode === "import") {
      try { saved = JSON.parse(text); }
      catch { throw new Error("Invalid JSON. Choose a complete ParancU prepared-corpus file."); }
    }
    const info = await api(mode === "import" ? "/api/corpora/import" : "/api/corpora", {
      method: "POST", body: JSON.stringify({ name: file.name, language: byId("language").value,
        ...(mode === "import" ? { corpus: saved } : { text }) })
    });
    remember(info.id);
    showCorpus(info);
    void poll(info.id, ++pollVersion);
  } catch (error) {
    errorMessage(error instanceof TypeError ? "Could not read or upload the document. Check that it uses UTF-8 encoding and that the server is reachable." : error.message);
  } finally { preparingRequest = false; controls(); }
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showAnswer(data) {
  const { result, retrievedEvidence } = data;
  byId("answer-placeholder").hidden = true;
  byId("answer-content").hidden = false;
  byId("asked-question").textContent = result.question;
  byId("answer-badge").textContent = result.action === "answer" ? "SUPPORT VERIFIED" : "INSUFFICIENT EVIDENCE";
  byId("answer-badge").className = result.action === "answer" ? "badge ready" : "badge";
  byId("answer-text").textContent = result.action === "answer" ? result.answer : "No answer was supported by the passages checked. Try rephrasing your question or using another document.";
  if (result.action === "answer") {
    const evidence = result.evidence;
    byId("citation").textContent = `${data.corpus.name} · chunk ${evidence.chunkIndex} · candidate #${evidence.candidateRank} ↗`;
    byId("citation").href = `#evidence-${evidence.candidateRank}`;
    byId("citation").hidden = false;
    byId("citation").onclick = () => { byId(`evidence-${evidence.candidateRank}`).open = true; };
    byId("verification").textContent = `Verification: ${result.reason}`;
    byId("verification").hidden = false;
  }
  byId("evidence-panel").hidden = false;
  byId("evidence-count").textContent = String(retrievedEvidence.length);
  for (const evidence of retrievedEvidence) {
    const card = element("details", `evidence-card ${evidence.status === "accepted" ? "accepted" : ""}`);
    card.id = `evidence-${evidence.candidateRank}`;
    card.open = evidence.status === "accepted";
    const summary = element("summary");
    summary.append(element("span", "evidence-rank", `#${evidence.candidateRank}`),
      element("span", "evidence-title", `Chunk ${evidence.chunkIndex}`),
      element("span", `badge ${evidence.status === "accepted" ? "ready" : ""}`, {
        accepted: "CITED EVIDENCE", rejected: "NOT ACCEPTED", not_evaluated: "NOT EVALUATED"
      }[evidence.status]), element("span", "evidence-score", `Retrieval score ${evidence.score.toFixed(3)}`));
    const body = element("div", "evidence-body");
    body.append(element("blockquote", "", evidence.text));
    if (evidence.reason) body.append(element("p", "", `Verification: ${evidence.reason}`));
    else body.append(element("p", "", "This passage was retrieved but has not been evaluated by the verifier."));
    card.append(summary, body);
    byId("evidence-list").append(card);
  }
  if (!retrievedEvidence.length) byId("evidence-list").append(element("p", "evidence-explainer", "ParancU returned no candidates."));
}

byId("question").addEventListener("input", controls);
byId("question-form").addEventListener("submit", async event => {
  event.preventDefault();
  const question = byId("question").value.trim();
  if (corpus?.status !== "ready" || asking || !question || !keyState.ready) return;
  asking = true;
  controls();
  errorMessage("");
  resetAnswer();
  pipeline("asking");
  byId("answer-placeholder").hidden = true;
  byId("answer-panel").setAttribute("aria-busy", "true");
  byId("activity").hidden = false;
  byId("activity").textContent = "Retrieving evidence, generating an answer, and verifying support…";
  try {
    const data = await api("/api/questions", { method: "POST", body: JSON.stringify({ corpusId: corpus.id, question }) });
    showAnswer(data);
    pipeline("complete");
  } catch (error) {
    errorMessage(error.message);
    byId("answer-badge").textContent = "OPERATIONAL ERROR";
    byId("answer-badge").className = "badge failed";
    byId("answer-placeholder").hidden = false;
    pipeline("ready");
  } finally {
    asking = false;
    byId("activity").hidden = true;
    byId("answer-panel").setAttribute("aria-busy", "false");
    controls();
  }
});

controls();
void refreshKeyStatus();
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) void poll(saved, ++pollVersion);
} catch { /* The upload flow works without localStorage. */ }
