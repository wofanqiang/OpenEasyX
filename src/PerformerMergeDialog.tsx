import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { PerformerConflict } from "../packages/profile-identity.js";
import "./performer-merge.css";

type Summary = { id: string; name: string; sources: number; files: number };
export type MergePreview = { from: Summary; target: Summary; blocked: boolean };
export function requestPerformerMerge(conflict: PerformerConflict) {
  window.dispatchEvent(new CustomEvent("easyx:performer-conflict", { detail: conflict }));
}

export function PerformerConflictNotice({ conflict }: { conflict: PerformerConflict }) {
  return <div className="performer-conflict" role="alert"><strong>Account already linked to {conflict.existingPerformer.name}</strong><p>Are these the same person? Review both profiles before merging, or correct the URL.</p><button type="button" className="secondary" onClick={() => requestPerformerMerge(conflict)}>Review merge</button></div>;
}

export function PerformerMergeReview({ preview, profileUrl, targetId, selectTarget, confirm, close, pending, error }: {
  preview: MergePreview; profileUrl?: string; targetId: string; selectTarget: (id: string) => void;
  confirm: () => void; close: () => void; pending: boolean; error?: string;
}) {
  return <><h2 id="performer-merge-title">Are these the same person?</h2>
    {profileUrl && <p>This account is linked to another profile: <a href={profileUrl} target="_blank" rel="noreferrer">{profileUrl}</a></p>}
    <fieldset disabled={pending}><legend>Choose the profile to keep</legend>{[preview.target, preview.from].map((person) => <label key={person.id} className="merge-choice"><input type="radio" name="merge-target" checked={targetId === person.id} onChange={() => selectTarget(person.id)}/><span><strong>{person.name}</strong><small>{person.sources} account links · {person.files} stored files</small></span></label>)}</fieldset>
    <p>The other name becomes an alias. Account links, files, favorites and playback history are kept. The two profiles become one.</p>
    {preview.blocked && <p role="alert" className="merge-error">Finish active scans and finish or cancel active downloads for these performers before merging.</p>}
    {error && <p role="alert" className="merge-error">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" disabled={pending} onClick={close}>Cancel</button><button type="button" className="primary" disabled={pending || preview.blocked} onClick={confirm}>{pending ? "Merging…" : "Merge profiles"}</button></div>
  </>;
}

export function PerformerMergeDialog({ conflict, close, run }: { conflict: PerformerConflict; close: () => void; run: (op: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [targetId, setTargetId] = useState(conflict.existingPerformer.id);
  const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void api<MergePreview>(`/api/performers/${conflict.performerId}/merge-preview?targetId=${encodeURIComponent(conflict.existingPerformer.id)}`)
      .then((value) => { if (active) setPreview(value); }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [conflict]);
  const confirm = () => {
    if (!preview || pending) return;
    const fromId = targetId === preview.from.id ? preview.target.id : preview.from.id;
    setPending(true); setError("");
    void run(async () => {
      try {
        const result = await api(`/api/performers/${fromId}/merge`, { method: "POST", body: JSON.stringify({ targetId, confirmed: true }) });
        close(); window.dispatchEvent(new CustomEvent("easyx:performer-merged", { detail: { targetId } })); return result;
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
      finally { setPending(false); }
    }, "Performer profiles merged");
  };
  return <div className="modal-backdrop performer-merge-backdrop"><div className="modal performer-merge-modal" role="dialog" aria-modal="true" aria-labelledby="performer-merge-title">
    {preview ? <PerformerMergeReview preview={preview} profileUrl={conflict.profileUrl} targetId={targetId} selectTarget={setTargetId} confirm={confirm} close={close} pending={pending} error={error}/> : <><h2 id="performer-merge-title">Review profile conflict</h2><p role="status">{error || "Loading both profiles…"}</p><button type="button" className="secondary" onClick={close}>Cancel</button></>}
  </div></div>;
}
