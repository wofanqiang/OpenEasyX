import { useState } from "react";
import { HeartPulse, LoaderCircle } from "lucide-react";
import { api } from "./api";

type DiagnosticCheck = { id: string; label: string; ok: boolean; detail: string };
type DiagnosticsReport = { ranAt: string; ok: boolean; checks: DiagnosticCheck[] };

/**
 * One-click self-check for everything recordings depend on. On-demand only (it probes the
 * plugins over the network), so unlike SystemStats there is no polling loop here.
 */
export function DiagnosticsPanel() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (running) return;
    setRunning(true); setError("");
    try {
      setReport(await api<DiagnosticsReport>("/api/system/diagnostics"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return <section className="statistics-panel diagnostics-panel">
    <div className="statistics-panel-head"><div><p>DIAGNOSTICS</p><h3>Self-check</h3></div><HeartPulse/></div>
    <p className="diagnostics-intro">One pass over the things recordings depend on: the disk floor, the ffmpeg tools, media directory permissions, plugin connectivity, queue health and stray capture processes.</p>
    <button className="quiet" onClick={() => void run()} disabled={running}>
      {running ? <LoaderCircle className="spin"/> : <HeartPulse/>}{running ? "Checking…" : "Run self-check"}
    </button>
    {error && <p className="row-error" role="alert">{error}</p>}
    {report && <ul className="diagnostics-checks">
      {report.checks.map((check) => <li key={check.id} data-ok={check.ok}><b>{check.label}</b><span>{check.detail}</span></li>)}
    </ul>}
    {report && <p className="system-stats-foot">{report.ok ? "All checks passed" : "Some checks need attention"} · {new Date(report.ranAt).toLocaleTimeString()}</p>}
  </section>;
}
