import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "./api.js";

export function SourceHardRefresh({ sourceId, domain, run }: { sourceId: string; domain: string; run: (op: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const refresh = () => {
    if (pending || !window.confirm(`Hard refresh ${domain}?\n\nScan again from the beginning, within the scraper's configured scan limit. Rediscovered deleted or missing files become eligible for download again, using your auto-download settings. Files still in your library are kept.`)) return;
    setPending(true); setResult("");
    void run(async () => {
      try {
        const response = await api<{ recovered: number; added: number }>(`/api/sources/${sourceId}/hard-refresh`, { method: "POST" });
        setResult(`${response.recovered} restored · ${response.added} new`);
        return response;
      } finally { setPending(false); }
    }, `${domain} hard refresh completed`);
  };
  return <span className="source-hard-refresh"><button type="button" className="icon-button" disabled={pending} aria-label={`Hard refresh ${domain}`} title={pending ? "Rescanning source…" : "Hard refresh: reconsider deleted and missing content"} onClick={refresh}><RotateCcw size={14}/></button>{result && <small role="status">{result}</small>}</span>;
}
