import React, { useCallback, useEffect, useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import { api } from "./api";

/**
 * Live host + container resource panel embedded at the top of the existing
 * `/statistics` page. The backend samples on its own timer; this component only
 * polls the cached snapshot, and it stops polling while the tab is hidden.
 */

type DiskUsage = { path: string; label: string; totalBytes: number; usedBytes: number; freeBytes: number; percent: number };

type SystemStatsSnapshot = {
  available: boolean;
  reason?: string;
  platform: string;
  sampledAt: string;
  intervalMs: number;
  host: {
    cpu: { cores: number; usagePercent: number; perCorePercent: number[]; load1: number; load5: number; load15: number; uptimeSeconds: number };
    memory: { totalBytes: number; usedBytes: number; availableBytes: number; percent: number };
    network: { receivedBytes: number; transmittedBytes: number; receivedBytesPerSecond: number; transmittedBytesPerSecond: number };
    diskIo: { readBytes: number; writtenBytes: number; readBytesPerSecond: number; writtenBytesPerSecond: number };
  };
  container: { detected: boolean; cgroupVersion: "v1" | "v2" | "none"; cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; memoryPercent: number };
  disks: DiskUsage[];
  recordings: { activeDirectories: number; bytesOnDisk: number; writeBytesPerSecond: number };
};

const POLL_MS = 5000;

function formatBytes(bytes = 0): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRate(bytesPerSecond = 0): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatUptime(seconds = 0): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function level(percent: number): "ok" | "warn" | "high" {
  if (percent >= 85) return "high";
  if (percent >= 65) return "warn";
  return "ok";
}

function Gauge({ label, percent, caption }: { label: string; percent: number; caption: string }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return <div className="system-gauge">
    <div className="system-gauge-dial">
      <svg viewBox="0 0 80 80" role="img" aria-label={`${label}: ${value}%`}>
        <circle className="system-gauge-track" cx="40" cy="40" r={radius}/>
        <circle className="system-gauge-value" cx="40" cy="40" r={radius} data-level={level(value)}
          strokeDasharray={`${circumference}`} strokeDashoffset={`${circumference * (1 - value / 100)}`}/>
      </svg>
      <b>{value}<i>%</i></b>
    </div>
    <strong>{label}</strong>
    <small>{caption}</small>
  </div>;
}

function Metric({ icon: Icon, label, value, caption }: { icon: React.ElementType; label: string; value: string; caption: string }) {
  return <article className="system-metric">
    <span><Icon/></span>
    <div><small>{label}</small><b>{value}</b><p>{caption}</p></div>
  </article>;
}

export function SystemStats() {
  const [snapshot, setSnapshot] = useState<SystemStatsSnapshot | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const next = await api<SystemStatsSnapshot>("/api/system/stats");
      setSnapshot(next); setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void load(); };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const sampledLabel = snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString() : "";

  if (!snapshot) {
    return <section className="statistics-panel system-stats-panel">
      <div className="statistics-panel-head"><div><p>SYSTEM HEALTH</p><h3>Host and container load</h3></div><Activity/></div>
      <p className="system-stats-note">{error || "Sampling system resources…"}</p>
    </section>;
  }

  if (!snapshot.available) {
    return <section className="statistics-panel system-stats-panel">
      <div className="statistics-panel-head"><div><p>SYSTEM HEALTH</p><h3>Host and container load</h3></div><Activity/></div>
      <p className="system-stats-note">{snapshot.reason ?? "System metrics are unavailable on this host."}</p>
    </section>;
  }

  const { host, container, disks, recordings } = snapshot;
  const containerCpu = container.detected ? container.cpuPercent : host.cpu.usagePercent;
  const containerMemoryPercent = container.memoryLimitBytes > 0 ? container.memoryPercent : host.memory.percent;
  const rootDisk = disks[0];
  const mediaDisk = disks.find((disk) => disk.label === "Media library") ?? disks[disks.length - 1];

  return <section className="statistics-panel system-stats-panel">
    <div className="statistics-panel-head"><div><p>SYSTEM HEALTH</p><h3>Host and container load</h3></div><Activity/></div>
    <div className="system-gauges">
      <Gauge label={container.detected ? "Container CPU" : "Host CPU"} percent={containerCpu}
        caption={`${host.cpu.cores} ${host.cpu.cores === 1 ? "core" : "cores"} · load ${host.cpu.load1.toFixed(2)}`}/>
      <Gauge label={container.memoryLimitBytes > 0 ? "Container memory" : "Host memory"} percent={containerMemoryPercent}
        caption={container.memoryLimitBytes > 0
          ? `${formatBytes(container.memoryBytes)} of ${formatBytes(container.memoryLimitBytes)}`
          : `${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)}`}/>
      <Gauge label="Disk usage" percent={rootDisk?.percent ?? 0}
        caption={rootDisk ? `${formatBytes(rootDisk.freeBytes)} free of ${formatBytes(rootDisk.totalBytes)}` : "Unavailable"}/>
    </div>
    <div className="system-metrics">
      <Metric icon={Cpu} label="Host CPU" value={`${host.cpu.usagePercent}%`}
        caption={`Load ${host.cpu.load1.toFixed(2)} / ${host.cpu.load5.toFixed(2)} / ${host.cpu.load15.toFixed(2)}`}/>
      <Metric icon={MemoryStick} label="Host memory" value={`${host.memory.percent}%`}
        caption={`${formatBytes(host.memory.usedBytes)} used · ${formatBytes(host.memory.availableBytes)} free`}/>
      <Metric icon={Server} label="Container memory" value={container.detected ? formatBytes(container.memoryBytes) : "n/a"}
        caption={container.detected
          ? `${container.memoryLimitBytes > 0 ? `Limit ${formatBytes(container.memoryLimitBytes)}` : "No memory limit"} · cgroup ${container.cgroupVersion} · excl. reclaimable cache`
          : "Running outside a container"}/>
      <Metric icon={HardDrive} label="Recording buffer" value={`${recordings.activeDirectories} active`}
        caption={`${formatBytes(recordings.bytesOnDisk)} on disk · ${formatRate(recordings.writeBytesPerSecond)}`}/>
    </div>
    <div className="system-details">
      <div><span>Media disk</span><b>{mediaDisk ? `${formatBytes(mediaDisk.freeBytes)} free (${100 - mediaDisk.percent}%)` : "Unavailable"}</b></div>
      <div><span>Network I/O</span><b>↓ {formatRate(host.network.receivedBytesPerSecond)} · ↑ {formatRate(host.network.transmittedBytesPerSecond)}</b></div>
      <div><span>Disk I/O</span><b>R {formatRate(host.diskIo.readBytesPerSecond)} · W {formatRate(host.diskIo.writtenBytesPerSecond)}</b></div>
      <div><span>Host uptime</span><b>{formatUptime(host.cpu.uptimeSeconds)}</b></div>
    </div>
    {host.cpu.perCorePercent.length > 0 && <div className="system-cores" aria-label="Per-core CPU usage">
      {host.cpu.perCorePercent.map((percent, index) => <span key={index} title={`Core ${index}: ${percent}%`} data-level={level(percent)} style={{ opacity: 0.25 + Math.min(1, percent / 100) * 0.75 }}/>)}
    </div>}
    <p className="system-stats-foot">Sampled every {Math.round(snapshot.intervalMs / 1000)}s · updated {sampledLabel}{error ? ` · ${error}` : ""}</p>
  </section>;
}
