import React from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, BriefcaseBusiness, Check, CircleAlert, FileText, Github, Linkedin, Paperclip, RotateCcw, Sparkles, Upload, UserRound, X } from "lucide-react";
import { api, askStream, loadSessionId, newSessionId } from "./api.js";

const starter = [{ role: "assistant", text: "Hi! I’m Vidhi’s AI portfolio assistant. Ask me about her experience, projects, technical skills, or paste a job description to explore how her background aligns with the role." }];
const suggestions = ["Tell me about Vidhi’s experience", "What AI projects has she built?", "Which technologies does she work with?"];

const MAX_JD_BYTES = 2 * 1024 * 1024;
const WAKE_NOTICE_MS = 3000;
const AWAKE_FOR_MS = 10 * 60 * 1000; // Render sleeps after ~15 idle minutes; assume awake for 10 after a response

const NOTICES = {
  connecting: "Connecting to the assistant…",
  waking: "Waking up the assistant — the first reply can take up to a minute.",
  online: "Assistant online",
  offline: "Can’t reach the assistant right now · Please try again shortly",
};
const STATUS_LABELS = { connecting: "Connecting", waking: "Waking up", online: "Online", offline: "Offline" };

export default function App() {
  const [sessionId, setSessionId] = useState(loadSessionId);
  const [messages, setMessages] = useState(starter);
  const [question, setQuestion] = useState("");
  const [jd, setJd] = useState("");
  const [jdFile, setJdFile] = useState(null);
  const [jobRole, setJobRole] = useState(null);
  const [panel, setPanel] = useState("profile");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [matching, setMatching] = useState(false);
  const [connection, setConnection] = useState("connecting"); // connecting | waking | online | offline
  const [status, setStatus] = useState(null); // e.g. "Scoring against …" while a tool runs mid-answer
  const fileRef = useRef(null);
  const awakeUntil = useRef(0);
  const nextId = useRef(1);
  const streamRef = useRef(null);

  // Start the container warming while the visitor reads; failures already show in the status.
  useEffect(() => { call("/health").catch(() => {}); }, []);
  useEffect(() => () => streamRef.current?.cancel(), []);

  // Shows the cold-start notice if a request is still waiting after a few seconds.
  function wakeTimer() {
    return setTimeout(() => { if (Date.now() > awakeUntil.current) setConnection("waking"); }, WAKE_NOTICE_MS);
  }

  // Wraps api() to drive the cold-start notice and the online/offline status.
  async function call(path, body) {
    const slow = wakeTimer();
    try {
      const data = await api(path, body);
      markAwake();
      return data;
    } catch (err) {
      markFailure(err);
      throw err;
    } finally {
      clearTimeout(slow);
    }
  }

  function markAwake() {
    awakeUntil.current = Date.now() + AWAKE_FOR_MS;
    setConnection("online");
  }

  function markFailure(err) {
    if (err.status) markAwake(); // a 4xx still means the server is up
    else setConnection("offline");
  }

  // Updates one message by id. Matched by id rather than "the last message" because
  // a JD loaded from the panel can append a message while an answer is still streaming.
  function updateMessage(id, change) {
    setMessages(m => m.map(msg => (msg.id === id ? change(msg) : msg)));
  }

  async function ask(value) {
    const q = value.trim();
    if (!q || loading) return;
    const id = nextId.current++;
    setMessages(m => [...m, { role: "user", text: q }, { id, role: "assistant", text: "", streaming: true }]);
    setQuestion("");
    setLoading(true);
    setStatus(null);

    const slow = wakeTimer();
    const heardBack = () => { clearTimeout(slow); markAwake(); };
    const stream = askStream(sessionId, q, {
      onToken: text => {
        heardBack();
        updateMessage(id, msg => ({ ...msg, text: msg.text + text }));
      },
      onStatus: text => {
        heardBack();
        setStatus(text);
      },
      onDone: role => {
        setJobRole(role); // a JD pasted into the chat also sets the role
        setStatus(null);
      },
    });
    streamRef.current = stream;

    try {
      await stream.done;
      updateMessage(id, msg => (msg.text ? msg : { ...msg, error: true, text: "I didn’t get an answer back. Please try asking again." }));
    } catch (err) {
      if (err.cancelled) return;
      markFailure(err);
      updateMessage(id, msg => ({
        ...msg,
        error: true,
        text: msg.text ? `${msg.text}\n\n(${err.message})` : `Sorry — I couldn’t get an answer just now. ${err.message}`,
      }));
    } finally {
      clearTimeout(slow);
      updateMessage(id, msg => ({ ...msg, streaming: false }));
      streamRef.current = null;
      setStatus(null);
      setLoading(false);
    }
  }

  function jdLoaded(role) {
    setJobRole(role ?? null);
    setResult({
      ok: true,
      title: role ? `Now scoring against: ${role}` : "Job description loaded",
      body: "Ask in the chat how well Vidhi matches this role — the assistant will score it against her profile.",
    });
    setMessages(m => [...m, {
      role: "assistant",
      text: `I’ve loaded the job description${role ? ` for ${role}` : ""}. Ask me how well Vidhi matches it, and I’ll walk you through where her background lines up with the role.`,
    }]);
  }

  function jdFailed(message) {
    setResult({ ok: false, title: "Couldn’t load the job description", body: message });
  }

  async function analyze() {
    if (!jd.trim()) { jdFailed("Paste a job description before analyzing."); return; }
    setMatching(true);
    setResult(null);
    setJdFile(null);
    try {
      const data = await call("/set-jd", { session_id: sessionId, jd_text: jd });
      jdLoaded(data.role);
    } catch (err) {
      jdFailed(err.message);
    } finally {
      setMatching(false);
    }
  }

  async function uploadJd(e) {
    const f = e.target.files?.[0];
    e.target.value = ""; // lets the same file be picked again after removing it
    if (!f) return;
    setPanel("job");
    if (!/\.(pdf|docx)$/i.test(f.name)) { jdFailed("Please choose a PDF or DOCX job description."); return; }
    if (f.size > MAX_JD_BYTES) { jdFailed("That file is too large (2 MB max)."); return; }

    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("jd_file", f);
    setJdFile(f);
    setResult(null);
    setMatching(true);
    try {
      const data = await call("/upload-jd", form);
      jdLoaded(data.role);
    } catch (err) {
      setJdFile(null);
      jdFailed(err.message);
    } finally {
      setMatching(false);
    }
  }

  function chooseJdFile() {
    setPanel("job");
    fileRef.current?.click();
  }

  function resetConversation() {
    const form = new FormData();
    form.append("session_id", sessionId);
    // Not awaited: the fresh session id below already isolates the new conversation,
    // and a cold server would otherwise freeze the reset for up to a minute.
    call("/reset", form).catch(() => {});
    setSessionId(newSessionId());
    setMessages(starter);
    setQuestion("");
    setJd("");
    setJdFile(null);
    setResult(null);
    setJobRole(null);
  }

  // The typing dots give way to text as soon as the first token lands.
  const pendingEmpty = messages.some(m => m.streaming && !m.text);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-icon"><Sparkles size={19} /></span>
          <span>ask<span className="green">vidhi</span><small>PORTFOLIO ASSISTANT</small></span>
        </a>
        <div className="topright"><i /> Recruiter preview <span className="avatar"><UserRound size={18} /></span></div>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <div className="sideheading">
            <div><p className="eyebrow">YOUR SPACE</p><h2>Recruiter toolkit</h2></div>
          </div>
          <button className={panel === "profile" ? "nav active" : "nav"} onClick={() => setPanel("profile")}><UserRound size={16} /> Candidate profile</button>
          <button className={panel === "job" ? "nav active" : "nav"} onClick={() => setPanel("job")}><BriefcaseBusiness size={16} /> Job fit analysis</button>

          {/* Outside the panels so the composer paperclip works from either one. */}
          <input ref={fileRef} hidden type="file" accept=".pdf,.docx" onChange={uploadJd} />

          {panel === "profile" ? (
            <section className="card">
              <div className="profile">
                <div className="initials">VD</div>
                <div><h3>Vidhi Dixit</h3><p>Software & AI Engineer</p></div>
              </div>
              <p className="summary">A software developer exploring full-stack engineering and practical AI applications.</p>
              <div className="tags">{["Python", "FastAPI", "React", "LLMs", "Salesforce"].map(x => <span key={x}>{x}</span>)}</div>
              <hr />
              <p className="label">LINKS</p>
              <a className="link" href="https://github.com/" target="_blank" rel="noreferrer"><Github size={16} /> GitHub <span>↗</span></a>
              <a className="link" href="https://www.linkedin.com/" target="_blank" rel="noreferrer"><Linkedin size={16} /> LinkedIn <span>↗</span></a>
            </section>
          ) : (
            <section className="card">
              <div className="jobicon"><BriefcaseBusiness size={20} /></div>
              <h3>Check role alignment</h3>
              <p className="summary">Paste a job description or upload a file to compare it against Vidhi’s profile.</p>
              <label className="label" htmlFor="jd">JOB DESCRIPTION</label>
              <textarea id="jd" rows="8" value={jd} onChange={e => { setJd(e.target.value); setResult(null); }} placeholder="Paste the job description here…" />
              <button className="primary full" onClick={analyze} disabled={matching}>{matching ? "Preparing…" : "✧  Analyze job fit"}</button>
              <hr />
              <p className="label">OR UPLOAD A FILE</p>
              {!jdFile ? (
                <button className="upload" onClick={() => fileRef.current?.click()} disabled={matching}>
                  <Upload size={20} /><b>Upload a job description</b><span>PDF or DOCX · 2 MB max</span>
                </button>
              ) : (
                <div className="file">
                  <FileText size={20} />
                  <div><b>{jdFile.name}</b><span>{(jdFile.size / 1024).toFixed(0)} KB · {matching ? "Uploading…" : "Uploaded"}</span></div>
                  <button className="remove" aria-label="Remove file" disabled={matching} onClick={() => setJdFile(null)}><X size={15} /></button>
                </div>
              )}
              {result && (
                <div className="result">
                  <span>{result.ok ? <Check size={14} /> : <CircleAlert size={14} />} {result.ok ? "Job description loaded" : "Something went wrong"}</span>
                  <b>{result.title}</b>
                  <p>{result.body}</p>
                </div>
              )}
              <p className="micro">The match score comes back in the chat once the job description is loaded.</p>
            </section>
          )}

          <div className="privacy"><Check size={15} /> Your conversations are kept separate by session.</div>
        </aside>

        <section className="chat">
          <div className="chathead">
            <div className="boticon"><Bot size={22} /></div>
            <div className="chatheading">
              <h1>Ask me about Vidhi</h1>
              <p>Experience, projects, skills & role alignment</p>
              {jobRole && <span className="online rolechip" title={`Scoring against: ${jobRole}`}><BriefcaseBusiness size={12} /><span>Scoring against: {jobRole}</span></span>}
            </div>
            <span className={connection === "online" ? "online" : "online wait"}><i /> {STATUS_LABELS[connection]}</span>
            <button className="newchat" onClick={resetConversation} disabled={loading || matching} aria-label="New conversation">
              <RotateCcw size={13} /><span>New conversation</span>
            </button>
          </div>

          <div className="conversation">
            <div className="divider">START A CONVERSATION</div>
            {messages.map((m, i) => m.text && (
              <div className={"message " + m.role} key={i}>
                {m.role === "assistant" && <span className="msgicon">{m.error ? <CircleAlert size={14} /> : <Sparkles size={14} />}</span>}
                <div className="bubble">{m.text}</div>
              </div>
            ))}
            {loading && (status || pendingEmpty) && (
              <div className="message assistant">
                <span className="msgicon"><Sparkles size={14} /></span>
                {status ? <div className="bubble statusline">{status}</div> : <div className="bubble typing"><i /><i /><i /></div>}
              </div>
            )}
          </div>

          {messages.length === 1 && (
            <div className="suggestions">
              <p>TRY ASKING</p>
              {suggestions.map(s => <button key={s} onClick={() => ask(s)}>{s}<span>↗</span></button>)}
            </div>
          )}

          <div className="composerwrap">
            <form className="composer" onSubmit={e => { e.preventDefault(); ask(question); }}>
              <button type="button" className="attach" title="Upload a job description" aria-label="Upload a job description" onClick={chooseJdFile} disabled={matching}>
                <Paperclip size={18} />
              </button>
              <textarea
                rows="1"
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); } }}
                placeholder="Ask about Vidhi’s experience, skills or projects…"
              />
              <button className="send" disabled={!question.trim() || loading} aria-label="Send"><ArrowUp size={19} /></button>
            </form>
            <div className="composerfoot">
              <span><Paperclip size={12} /> Shift + Enter for a new line</span>
              <span>AI responses may need verification</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>© 2026 Ask Vidhi</span>
        <span className={connection === "online" ? "notice ok" : "notice"}><i /> {NOTICES[connection]}</span>
        <span>Built for curious minds ✧</span>
      </footer>
    </div>
  );
}
