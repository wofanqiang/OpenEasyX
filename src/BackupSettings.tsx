import { useRef, useState } from "react";
import { Download, LoaderCircle, Upload } from "lucide-react";
import { api } from "./api";

type ImportResult = {
  performers: { created: number; updated: number; skipped: Array<{ name: string; reason: string }> };
  sources: { added: number; updated: number; warnings: Array<{ performer: string; profileUrl: string; reason: string }>; skipped: Array<{ performer: string; profileUrl: string; reason: string }> };
  settings: { applied: string[]; skipped: string[] };
  plugins: { installed: string[]; skipped: Array<{ id: string; reason: string }> };
};

export function importSummary(result: ImportResult): string {
  const parts = [
    `${result.performers.created} performer${result.performers.created === 1 ? "" : "s"} added`,
    `${result.performers.updated} updated`,
    `${result.sources.added} source${result.sources.added === 1 ? "" : "s"} added`,
  ];
  if (result.performers.skipped.length) parts.push(`${result.performers.skipped.length} performer conflicts`);
  if (result.sources.skipped.length) parts.push(`${result.sources.skipped.length} skipped`);
  if (result.plugins.installed.length) parts.push(`${result.plugins.installed.length} plugin${result.plugins.installed.length === 1 ? "" : "s"} installed`);
  return `Import finished: ${parts.join(", ")}.`;
}

export function BackupSettings({ setNotice, onImported }: { setNotice: (message: string) => void; onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [includeSettings, setIncludeSettings] = useState(true); const [includePlugins, setIncludePlugins] = useState(true);
  const [result, setResult] = useState<ImportResult>();

  const importFile = async (file: File) => {
    setBusy(true); setError(""); setResult(undefined);
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Backup files must be smaller than 32 MB");
      let backup: unknown;
      try { backup = JSON.parse(await file.text()); } catch { throw new Error("This file is not valid JSON"); }
      const query = new URLSearchParams({ settings: includeSettings ? "1" : "0", plugins: includePlugins ? "1" : "0" });
      const imported = await api<ImportResult>(`/api/backup/import?${query}`, { method: "POST", body: JSON.stringify(backup) });
      setResult(imported); setNotice(importSummary(imported)); onImported();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };

  return <section className="panel backup-settings">
    <div className="panel-head"><div><p>BACKUP</p><h3>Export and import</h3></div></div>
    <p className="muted">Save your performers, their sources, recording priorities, settings and installed plugins to a file, and load them again after a reinstall or on another server. Downloads and plugin passwords, cookies or sessions are not included.</p>
    <div className="backup-actions">
      <a className="button primary" href="/api/backup/export" download><Download size={14}/>Export backup</a>
    </div>
    <div className="form-stack">
      <label className="check-row"><input type="checkbox" checked={includeSettings} onChange={(event) => setIncludeSettings(event.target.checked)}/><span>Also import settings</span></label>
      <label className="check-row"><input type="checkbox" checked={includePlugins} onChange={(event) => setIncludePlugins(event.target.checked)}/><span>Also install plugins that are missing</span></label>
    </div>
    <p className="muted">Importing adds to your current library and never deletes anything. Performers are matched by name or linked account and sources by account, so importing the same file again does not create duplicates.</p>
    <div className="backup-actions">
      <input ref={input} type="file" accept="application/json,.json" hidden aria-label="Backup file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }}/>
      <button className="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Upload size={14}/>}{busy ? "Importing…" : "Import backup"}</button>
    </div>
    {error && <p className="row-error" role="alert">{error}</p>}
    {result && <div className="backup-result" role="status">
      <p>{importSummary(result)}</p>
      {result.performers.skipped.length > 0 && <ul>{result.performers.skipped.map((skip) => <li key={skip.name}><b>{skip.name}</b>: {skip.reason}</li>)}</ul>}
      {result.sources.warnings.length > 0 && <ul>{result.sources.warnings.map((warning, index) => <li key={index}><b>{warning.performer}</b>: {warning.reason}</li>)}</ul>}
      {result.settings.skipped.length > 0 && <p>Settings not imported: {result.settings.skipped.join(", ")}</p>}
      {result.sources.skipped.length > 0 && <ul>{result.sources.skipped.map((skip) => <li key={`${skip.performer}-${skip.profileUrl}`}><b>{skip.performer}</b>: {skip.profileUrl} — {skip.reason}</li>)}</ul>}
      {result.plugins.skipped.length > 0 && <ul>{result.plugins.skipped.map((skip) => <li key={skip.id}><b>{skip.id}</b>: {skip.reason}</li>)}</ul>}
    </div>}
  </section>;
}
