"use client";

import { useState, useEffect, useRef } from "react";
import { HEADER, resultsToRows } from "../lib/exportRows";
import { reconcileConsistency } from "../lib/consistency";

const REVIEWER_NAME_KEY = "kortexReviewerName";
const NEW_COL_INDEX = 9; // HEADER = [cat1,cat2,cat3,cat4,cat5,brand,product line,hashtag,inclusion,new,comments]
const INCLUSION_COL_INDEX = 8;
const HASHTAG_COL_INDEX = 7;
// Hashtags per /api/classify request. This is just internal chunking — paste
// as many hashtags as you want into the textarea in one go (100+ is fine),
// this only controls how they're split into requests behind the scenes.
//
// This MUST match the server's CONCURRENCY (route.js), not exceed it. The
// progress bar only updates once a whole batch finishes, so a batch bigger
// than CONCURRENCY buys nothing (the server can't run more than CONCURRENCY
// at once anyway) while making the UI look frozen for longer — e.g. with
// BATCH_SIZE=15 and CONCURRENCY=5, a run of just 10 hashtags was one single
// batch, so the bar sat at 0% for the entire ~8 minutes it actually took,
// looking exactly like a hang even though it was working. Keeping them equal
// means every batch is one fully-parallel "wave," so progress updates as
// often as the server can possibly go — no wasted round trips, much better
// feedback.
const BATCH_SIZE = 2; // matches CONCURRENCY (route.js) — see the note there on why it was lowered

function isInconsistentRow(row) {
  return String(row[row.length - 1] || "").includes("Consistency check needed");
}

function isNewRow(row) {
  return Boolean(row[NEW_COL_INDEX]);
}

function loadReviewerName() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REVIEWER_NAME_KEY) || "";
  } catch {
    return "";
  }
}

function saveReviewerNameToBrowser(name) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REVIEWER_NAME_KEY, name);
  } catch {
    // ignore — worst case, asked again next visit
  }
}

function entryAccuracy(entry) {
  const total = entry.row_count || 0;
  if (total === 0) return null;
  return Math.round(((total - (entry.mistake_count || 0)) / total) * 100);
}

function defaultBatchName(entry) {
  const d = new Date(entry.created_at);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A short, soft three-note ascending chime (synthesized in-browser via Web
// Audio — no audio file to bundle/host) played once Classify finishes, so a
// long batch doesn't require staring at the tab to know when it's done. A
// rising G5-B5-D6 major arpeggio, ~1s total — a classic pleasant "done" sound.
function playCompletionChime() {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    const notes = [
      { freq: 784.0, start: 0, duration: 0.4 }, // G5
      { freq: 987.77, start: 0.2, duration: 0.4 }, // B5
      { freq: 1174.66, start: 0.4, duration: 0.6 }, // D6
    ];
    notes.forEach(({ freq, start, duration }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.02);
    });
    const last = notes[notes.length - 1];
    setTimeout(() => ctx.close(), (last.start + last.duration + 0.3) * 1000);
  } catch {
    // Some browsers block audio without a prior user gesture — Classify
    // itself is a click, so this should be fine, but fail silently either
    // way rather than breaking the results if it doesn't play.
  }
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8L12 2.5z"
        fill="currentColor"
      />
      <path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8L19 15z" fill="currentColor" />
    </svg>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState([]); // array of arrays, matches HEADER order — editable
  const [editedFlags, setEditedFlags] = useState([]); // parallel to rows — true if manually edited
  const [flags, setFlags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [classifyError, setClassifyError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showNewOnly, setShowNewOnly] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyScope, setHistoryScope] = useState("all"); // "all" | "mine"
  const [showHistory, setShowHistory] = useState(false);
  const [currentHistoryId, setCurrentHistoryId] = useState(null); // which history entry the current view is tied to
  const [reviewerName, setReviewerName] = useState(null); // null = not loaded yet, "" = needs to be asked
  const [nameDraft, setNameDraft] = useState("");
  const saveTimerRef = useRef(null);

  // Every batch is attributed to a reviewer name so History/Data Quality can
  // be shared across the team instead of trapped in one person's browser —
  // no real login, just a name saved to this browser (same pattern as the
  // sibling Kortex tools).
  useEffect(() => {
    setReviewerName(loadReviewerName());
  }, []);

  async function fetchHistory(scope) {
    try {
      const url = scope === "mine" && reviewerName ? `/api/batches?reviewer=${encodeURIComponent(reviewerName)}` : "/api/batches";
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setHistory(data.batches || []);
    } catch {
      // History is a convenience view — a failed fetch just leaves the
      // current list stale, it shouldn't interrupt anything else.
    }
  }

  useEffect(() => {
    if (reviewerName) fetchHistory(historyScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewerName, historyScope]);

  // Keep the current batch's saved row data in sync with every edit (cell
  // edits, row deletes) so mistakes/accuracy survive switching to History and
  // back, or a teammate loading it later — not just the state at the moment
  // Classify finished. Debounced so a fast typist doesn't fire a write per
  // keystroke; only the LATEST state after a pause gets persisted.
  useEffect(() => {
    if (currentHistoryId == null) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch(`/api/batches/${currentHistoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, editedFlags }),
      }).catch(() => {
        // Best-effort — the classify results themselves are already shown;
        // losing a save just means this edit isn't reflected for teammates.
      });
    }, 800);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, editedFlags, currentHistoryId]);

  // Batches now run against a server that processes several hashtags at once
  // (see route.js's CONCURRENCY), so this should finish much faster than
  // before — but a batch-timeout + per-batch try/catch is still needed so a
  // genuinely stuck/failed request can't leave the UI showing "Classifying…"
  // forever with no feedback (that's what a truly stuck request used to look
  // like before this existed — no error, no chime, nothing).
  //
  // This went through a few bad guesses (3 min, then 10 min, then 30 min)
  // trying to size it for "however many hashtags happen to need AI research
  // this time" — which never works, since that number keeps changing as
  // batch sizes grow. The actual fix was route.js's HASHTAG_TIMEOUT_MS: each
  // individual hashtag's matching + AI research combined is hard-capped
  // server-side (280s on this project's Pro plan, well under its 300s
  // maxDuration), so a batch of BATCH_SIZE hashtags running CONCURRENCY at a
  // time can never legitimately take much longer than that same ceiling. This
  // timeout only exists as a last-resort net for a truly dead connection —
  // kept a bit above the server's own budget so it doesn't fire while the
  // server is still legitimately finishing up and about to respond.
  const BATCH_TIMEOUT_MS = 320000; // a bit over route.js's 280s per-hashtag budget

  // Clears the current input/results back to the initial empty view — lets
  // someone running several batches back-to-back start each one from a
  // clean screen, so a finished batch's results can't be mistaken for
  // leftovers from the previous run. Nothing is actually deleted: past
  // batches are already saved in History regardless of this. Disabled while
  // a batch is in flight (see the `disabled` prop below) since clearing
  // `progress` mid-run would make the progress bar jump back to 0% while a
  // batch is still genuinely running.
  function resetToHome() {
    setInput("");
    setRows([]);
    setEditedFlags([]);
    setFlags([]);
    setClassifyError(null);
    setShowNewOnly(false);
    setCurrentHistoryId(null);
    setProgress({ done: 0, total: 0 });
  }

  function confirmReviewerName() {
    const name = nameDraft.trim();
    if (!name) return;
    saveReviewerNameToBrowser(name);
    setReviewerName(name);
  }

  async function handleClassify() {
    const hashtags = input
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (hashtags.length === 0) return;

    setLoading(true);
    setCopied(false);
    setClassifyError(null);
    setProgress({ done: 0, total: hashtags.length });

    const batches = [];
    for (let i = 0; i < hashtags.length; i += BATCH_SIZE) {
      batches.push(hashtags.slice(i, i + BATCH_SIZE));
    }

    let allResults = [];
    let anyBatchFailed = false;

    try {
      for (const batch of batches) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
        try {
          const res = await fetch("/api/classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // AI research for new entries always runs now — it's no longer an optional toggle.
            body: JSON.stringify({ hashtags: batch, useResearch: true }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          const data = await res.json();
          allResults = allResults.concat(data.results || []);
        } catch (err) {
          // Don't let one bad/slow batch hang the whole run or silently lose
          // its hashtags — mark them as failed rows (visible, retriable) and
          // keep going with the remaining batches instead of stopping dead.
          anyBatchFailed = true;
          const message =
            err?.name === "AbortError"
              ? `Timed out after ${BATCH_TIMEOUT_MS / 60000} min — try again`
              : err?.message || "Request failed";
          for (const raw of batch) {
            allResults.push({ hashtag: raw, status: "error", error: message, notes: [] });
          }
        } finally {
          clearTimeout(timeoutId);
        }
        setProgress((p) => ({ ...p, done: Math.min(p.done + batch.length, p.total) }));
      }

      // Each request above only saw its own slice, so re-run the batch-wide
      // consistency check across the full merged set of results now.
      const { results: reconciled, flags: newFlags } = reconcileConsistency(allResults);
      const newRows = resultsToRows(reconciled);
      const newEditedFlags = newRows.map(() => false); // fresh batch — no manual edits yet

      setRows(newRows);
      setEditedFlags(newEditedFlags);
      setFlags(newFlags);
      setShowNewOnly(false);

      if (anyBatchFailed) {
        setClassifyError(
          'Some hashtags failed (timeout or server error) — look for rows marked "Lookup failed" below. Fix them by re-typing just those hashtags and running Classify again.'
        );
      }

      // Save to the shared team history. Best-effort: if this fails (DB
      // hiccup), the classify results the user actually asked for are still
      // shown — a lost save just means this run won't show up in History.
      try {
        const res = await fetch("/api/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ createdBy: reviewerName, rows: newRows, flags: newFlags }),
        });
        if (res.ok) {
          const data = await res.json();
          setCurrentHistoryId(data.batch.id);
          setHistory((prev) => [data.batch, ...prev]);
        }
      } catch {
        // best-effort, see above
      }

      playCompletionChime();
    } catch (err) {
      // Should be rare — per-batch errors are already caught above — but
      // this guarantees "loading" never gets stuck even on a truly
      // unexpected failure elsewhere in this function.
      setClassifyError(err?.message || "Something went wrong while classifying — please try again.");
    } finally {
      setLoading(false);
    }
  }

  function updateCell(rowIndex, colIndex, value) {
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      next[rowIndex][colIndex] = value;
      return next;
    });
    setEditedFlags((prev) => {
      if (prev[rowIndex]) return prev;
      const next = [...prev];
      next[rowIndex] = true;
      return next;
    });
  }

  function deleteRow(rowIndex) {
    setRows((prev) => prev.filter((_, i) => i !== rowIndex));
    setEditedFlags((prev) => prev.filter((_, i) => i !== rowIndex));
  }

  async function handleExport() {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hashtag_classification_${Date.now()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopy() {
    const tsv = [HEADER, ...rows].map((r) => r.join("\t")).join("\n");
    await navigator.clipboard.writeText(tsv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function loadHistoryEntry(entry) {
    const res = await fetch(`/api/batches/${entry.id}`);
    if (!res.ok) return;
    const data = await res.json();
    const loadedRows = data.rows.map((r) => [
      r.cat1,
      r.cat2,
      r.cat3,
      r.cat4,
      r.cat5,
      r.brand,
      r.product_line,
      r.hashtag,
      r.inclusion,
      r.new_label,
      r.comments,
    ]);
    setRows(loadedRows);
    setEditedFlags(data.rows.map((r) => r.edited));
    setFlags(data.batch.flags || []);
    setShowNewOnly(false);
    setShowHistory(false);
    setCurrentHistoryId(data.batch.id);
  }

  async function deleteHistoryEntry(id) {
    setHistory((prev) => prev.filter((e) => e.id !== id));
    if (id === currentHistoryId) setCurrentHistoryId(null);
    try {
      await fetch(`/api/batches/${id}`, { method: "DELETE" });
    } catch {
      // if this fails the row will reappear on next History refresh, which
      // is an acceptable fallback rather than blocking the UI on it
    }
  }

  function renameHistoryEntry(id, name) {
    setHistory((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch(`/api/batches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => {});
    }, 500);
  }

  const visibleIndices = rows
    .map((_, i) => i)
    .filter((i) => !showNewOnly || isNewRow(rows[i]));

  const mistakeCount = editedFlags.filter(Boolean).length;
  const accuracyPct = rows.length > 0 ? Math.round(((rows.length - mistakeCount) / rows.length) * 100) : null;
  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // Blocks the rest of the app until we know who's using it — no account,
  // just a name saved to this browser, so batches/edits can be attributed
  // for the team-shared History (matches the sibling Kortex tools' pattern).
  if (reviewerName === null) {
    return null; // reading localStorage — avoids a flash of the name prompt
  }
  if (reviewerName === "") {
    return (
      <div className="page">
        <div className="name-prompt-card">
          <div className="mark" style={{ margin: "0 auto 16px" }}>
            #
          </div>
          <h1 className="page-title" style={{ textAlign: "center" }}>
            Who are you?
          </h1>
          <p className="page-subtitle" style={{ textAlign: "center" }}>
            Your name keeps your batch history separate from teammates&apos;. No account needed — saved to this browser.
          </p>
          <input
            className="cell-input"
            style={{ width: "100%", marginTop: 16 }}
            placeholder="Type your name…"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmReviewerName()}
            autoFocus
          />
          <button className="btn btn-primary" style={{ width: "100%", marginTop: 12 }} onClick={confirmReviewerName}>
            Continue →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <button
          type="button"
          className="mark mark-button"
          onClick={resetToHome}
          disabled={loading}
          title="Start a new batch"
        >
          #
        </button>
        <div>
          <h1 className="page-title page-title-button" onClick={loading ? undefined : resetToHome} title="Start a new batch">
            Hashtag Classifier
          </h1>
          <p className="page-subtitle">Classify TikTok hashtags against the moria taxonomy sheet.</p>
        </div>
        <span className="spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setNameDraft(reviewerName);
            setReviewerName("");
          }}
          title="Change your name"
        >
          {reviewerName}
        </button>
      </div>

      <div className="card">
        <textarea
          className="textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"#nativemarket\n#granolalifestyle\n#howtodoyoureyebrows"}
          rows={7}
        />
        <p className="hint">
          Enter hashtags one per line. For reference: items with no exact match are automatically
          researched with AI (includes TikTok/Google search, incurs cost).
        </p>

        <div className="toolbar">
          <button className="btn btn-primary" onClick={handleClassify} disabled={loading}>
            {loading ? `Classifying… ${progressPct}%` : "Classify"}
          </button>
          {rows.length > 0 && (
            <>
              <button className="btn" onClick={handleCopy}>
                {copied ? "Copied!" : `Copy Table (${rows.length} row${rows.length === 1 ? "" : "s"})`}
              </button>
              <button className="btn" onClick={handleExport}>
                Export to Excel
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => setShowHistory((v) => !v)}>
            History ({history.length})
          </button>
        </div>

        {loading && (
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="progress-label">
              {progress.done}/{progress.total} hashtags
            </span>
          </div>
        )}
      </div>

      {showHistory && (
        <div className="panel">
          <div className="panel-header">
            🕐 Past batches
            <span className="history-scope-toggle">
              <button
                className={`toggle-pill${historyScope === "all" ? " active" : ""}`}
                onClick={() => setHistoryScope("all")}
              >
                All
              </button>
              <button
                className={`toggle-pill${historyScope === "mine" ? " active" : ""}`}
                onClick={() => setHistoryScope("mine")}
              >
                Mine only
              </button>
            </span>
          </div>
          <div className="panel-body">
            {history.length === 0 && <div className="empty-state">No history yet.</div>}
            {history.map((entry) => {
              const hMistakes = entry.mistake_count || 0;
              const hAccuracy = entryAccuracy(entry);
              return (
              <div className="history-row" key={entry.id}>
                <span className="history-meta">
                  <input
                    className="history-name-input"
                    value={entry.name ?? defaultBatchName(entry)}
                    onChange={(e) => renameHistoryEntry(entry.id, e.target.value)}
                    title="Click to rename this batch"
                  />{" "}
                  <span className="count">
                    — {entry.row_count} hashtags · {entry.created_by}
                  </span>
                  <span className="history-stats">
                    <span className={`mistake-badge${hMistakes === 0 ? " zero" : ""}`}>
                      {hMistakes} mistake{hMistakes === 1 ? "" : "s"}
                    </span>
                    {hAccuracy !== null && (
                      <span className={`accuracy-badge${hAccuracy < 90 ? " low" : ""}`}>
                        {hAccuracy}% accuracy
                      </span>
                    )}
                  </span>
                </span>
                <span>
                  <button
                    className="btn btn-sm"
                    onClick={() => loadHistoryEntry(entry)}
                    style={{ marginRight: 6 }}
                  >
                    View
                  </button>
                  <button className="btn btn-sm" onClick={() => deleteHistoryEntry(entry.id)}>
                    Delete
                  </button>
                </span>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {classifyError && (
        <div className="banner banner-error">
          <p className="banner-title">⚠️ {classifyError}</p>
        </div>
      )}

      {flags.length > 0 && (
        <div className="banner">
          <p className="banner-title">⚠️ Consistency check needed within this batch</p>
          <ul>
            {flags.map((f, i) => (
              <li key={i}>
                {f.message} ({f.hashtags.map((h) => "#" + h).join(", ")})
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="results-header">
            <h2 className="results-title">Results</h2>
            <span className={`mistake-badge${mistakeCount === 0 ? " zero" : ""}`}>
              {mistakeCount} mistake{mistakeCount === 1 ? "" : "s"}
            </span>
            {accuracyPct !== null && (
              <span className={`accuracy-badge${accuracyPct < 90 ? " low" : ""}`}>
                {accuracyPct}% accuracy
              </span>
            )}
          </div>

          <div className="table-toolbar">
            <p className="hint" style={{ margin: 0 }}>
              Click any cell to edit it directly. Changes are reflected in Copy and Export to Excel.
            </p>
            <button
              className={`toggle-pill${showNewOnly ? " active" : ""}`}
              onClick={() => setShowNewOnly((v) => !v)}
              title="Show only new entries"
            >
              <SparkleIcon />
              New only
            </button>
          </div>

          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  {HEADER.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleIndices.map((i) => {
                  const row = rows[i];
                  return (
                    <tr key={i} className={isInconsistentRow(row) ? "inconsistent" : ""}>
                      {row.map((cell, j) => {
                        if (j === INCLUSION_COL_INDEX) {
                          const valueClass =
                            cell === "include"
                              ? "value-include"
                              : cell === "exclude"
                              ? "value-exclude"
                              : "value-blank";
                          return (
                            <td key={j}>
                              <select
                                className={`select-inclusion ${valueClass}`}
                                value={cell || ""}
                                onChange={(e) => updateCell(i, j, e.target.value)}
                              >
                                <option value="">—</option>
                                <option value="include">include</option>
                                <option value="exclude">exclude</option>
                              </select>
                            </td>
                          );
                        }
                        const extraClass =
                          j === HEADER.length - 1 ? " wide" : j === HASHTAG_COL_INDEX ? " hashtag-col" : "";
                        return (
                          <td key={j}>
                            <input
                              className={`cell-input${extraClass}`}
                              value={cell}
                              title={cell}
                              onChange={(e) => updateCell(i, j, e.target.value)}
                            />
                          </td>
                        );
                      })}
                      <td className="row-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => deleteRow(i)} title="Delete row">
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {showNewOnly && visibleIndices.length === 0 && (
            <div className="empty-state">No new entries in this batch.</div>
          )}
        </div>
      )}
    </div>
  );
}
