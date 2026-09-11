import fs from "node:fs";
import path from "node:path";

/**
 * Lightweight system + container resource sampler.
 *
 * Everything here is read straight from the Linux kernel interfaces (`/proc`,
 * `/sys/fs/cgroup`) and `node:fs`, so the image gains no dependency. Sampling
 * runs on a background timer: CPU percentages, network and disk throughput are
 * all deltas between two readings, and doing that work inline on a request
 * would block the event loop that the download queue and the SSE streams share.
 *
 * Two viewpoints are reported on purpose, because they genuinely differ inside
 * a container:
 *   - `host`      — what `/proc` sees, i.e. the whole machine (a container shares
 *                   the host's `/proc` unless lxcfs is mounted).
 *   - `container` — what the cgroup accounting sees, i.e. what `docker stats`
 *                   shows for this container.
 */

export type CpuTicks = { total: number; idle: number };
export type CounterPair = { receivedBytes: number; transmittedBytes: number };
export type DiskUsage = { path: string; label: string; totalBytes: number; usedBytes: number; freeBytes: number; percent: number };

export type SystemStatsSnapshot = {
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

const PROC_ROOT = "/proc";
const CGROUP_ROOT = "/sys/fs/cgroup";
const SECTOR_BYTES = 512;
/** cgroup v1 reports an enormous sentinel instead of "unlimited". */
const CGROUP_V1_UNLIMITED = 1e18;

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readNumber(file: string): number | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal") ?? 0;
  const available = values.get("MemAvailable") ?? (values.get("MemFree") ?? 0) + (values.get("Buffers") ?? 0) + (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0);
  return { totalBytes, availableBytes: Math.max(0, Math.min(available, totalBytes)) };
}

/**
 * `/proc/stat` cpu lines. The first eight fields are user, nice, system, idle,
 * iowait, irq, softirq and steal; guest time is already folded into user/nice so
 * it must not be counted twice.
 */
export function parseStat(text: string): { aggregate: CpuTicks; perCore: CpuTicks[] } {
  let aggregate: CpuTicks | undefined;
  const perCore: CpuTicks[] = [];
  for (const line of text.split("\n")) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    if (!match[1]) aggregate = { total, idle };
    else perCore.push({ total, idle });
  }
  return { aggregate: aggregate ?? { total: 0, idle: 0 }, perCore };
}

export function usagePercent(previous: CpuTicks, current: CpuTicks): number {
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return 0;
  const idleDelta = current.idle - previous.idle;
  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

export function parseLoadavg(text: string): { load1: number; load5: number; load15: number } {
  const [load1 = 0, load5 = 0, load15 = 0] = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return { load1: load1 || 0, load5: load5 || 0, load15: load15 || 0 };
}

export function parseUptime(text: string): number {
  const value = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : 0;
}

/** Sum every interface except loopback; fields 0 and 8 are rx/tx bytes. */
export function parseNetDev(text: string): CounterPair {
  let receivedBytes = 0;
  let transmittedBytes = 0;
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!name || name === "lo") continue;
    const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (fields.length < 9) continue;
    receivedBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
    transmittedBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
  }
  return { receivedBytes, transmittedBytes };
}

/**
 * `/proc/diskstats` fields 5 and 9 are the read/written sector counts. Whole
 * disks only: counting partitions and device-mapper nodes too would report the
 * same I/O several times.
 */
export function parseDiskstats(text: string): { readBytes: number; writtenBytes: number } {
  let readBytes = 0;
  let writtenBytes = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const name = fields[2];
    if (!/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)) continue;
    readBytes += (Number(fields[5]) || 0) * SECTOR_BYTES;
    writtenBytes += (Number(fields[9]) || 0) * SECTOR_BYTES;
  }
  return { readBytes, writtenBytes };
}

/** cgroup v2 `cpu.stat` exposes cumulative microseconds in `usage_usec`. */
export function parseCgroupUsageMicroseconds(text: string): number | undefined {
  const match = /^usage_usec\s+(\d+)\s*$/m.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** cgroup v1 `cpuacct.usage` is cumulative nanoseconds. */
export function parseCgroupUsageNanoseconds(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Reclaimable page cache held by the cgroup. `docker stats` reports
 * `usage - inactive_file` rather than the raw usage, because that cache is
 * evictable under pressure; without this subtraction the panel would report a
 * noticeably larger figure than `docker stats` for the same container.
 */
export function parseInactiveFile(text: string): number {
  const match = /^inactive_file\s+(\d+)\s*$/m.exec(text);
  return match ? Number(match[1]) : 0;
}

export function normalizeMemoryLimit(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value <= 0 || value >= CGROUP_V1_UNLIMITED) return 0;
  return value;
}

function diskUsage(target: string, label: string): DiskUsage | undefined {
  try {
    const stats = fs.statfsSync(target);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - stats.bfree * stats.bsize);
    if (totalBytes <= 0) return undefined;
    return { path: target, label, totalBytes, usedBytes, freeBytes, percent: clampPercent((usedBytes / totalBytes) * 100) };
  } catch {
    return undefined;
  }
}

type Reading = {
  cpu: CpuTicks;
  perCore: CpuTicks[];
  memory: { totalBytes: number; availableBytes: number };
  load: { load1: number; load5: number; load15: number };
  uptimeSeconds: number;
  network: CounterPair;
  diskIo: { readBytes: number; writtenBytes: number };
  cgroupVersion: "v1" | "v2" | "none";
  cgroupUsageSeconds?: number;
  containerMemoryBytes: number;
  containerMemoryLimitBytes: number;
  recordings: { activeDirectories: number; bytesOnDisk: number };
};

export type SystemStatsOptions = {
  mediaDir: string;
  /** Where in-flight downloads keep their partial files (defaults to `mediaDir/.downloads`). */
  recordingsRoot?: string;
  sampleIntervalMs?: number;
  platform?: NodeJS.Platform;
};

export class SystemStatsService {
  private readonly mediaDir: string;
  private readonly recordingsRoot: string;
  private readonly intervalMs: number;
  private readonly platform: NodeJS.Platform;
  private timer?: NodeJS.Timeout;
  private previous?: Reading;
  private snapshot: SystemStatsSnapshot;

  constructor(options: SystemStatsOptions) {
    this.mediaDir = path.resolve(options.mediaDir);
    this.recordingsRoot = path.resolve(options.recordingsRoot ?? path.join(options.mediaDir, ".downloads"));
    this.intervalMs = Math.max(250, options.sampleIntervalMs ?? 1000);
    this.platform = options.platform ?? process.platform;
    this.snapshot = this.emptySnapshot(this.platform === "linux" ? "Waiting for the first sample" : `System metrics are only collected on Linux hosts (this host is ${this.platform})`);
    if (this.platform === "linux") this.collect();
  }

  start() {
    if (this.timer || this.platform !== "linux") return;
    this.timer = setInterval(() => this.collect(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshotNow(): SystemStatsSnapshot {
    return this.snapshot;
  }

  private emptySnapshot(reason: string): SystemStatsSnapshot {
    return {
      available: false, reason, platform: this.platform, sampledAt: new Date().toISOString(), intervalMs: this.intervalMs,
      host: {
        cpu: { cores: 0, usagePercent: 0, perCorePercent: [], load1: 0, load5: 0, load15: 0, uptimeSeconds: 0 },
        memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0, percent: 0 },
        network: { receivedBytes: 0, transmittedBytes: 0, receivedBytesPerSecond: 0, transmittedBytesPerSecond: 0 },
        diskIo: { readBytes: 0, writtenBytes: 0, readBytesPerSecond: 0, writtenBytesPerSecond: 0 },
      },
      container: { detected: false, cgroupVersion: "none", cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, memoryPercent: 0 },
      disks: [], recordings: { activeDirectories: 0, bytesOnDisk: 0, writeBytesPerSecond: 0 },
    };
  }

  private read(): Reading | undefined {
    const statText = readText(path.join(PROC_ROOT, "stat"));
    const meminfoText = readText(path.join(PROC_ROOT, "meminfo"));
    if (!statText || !meminfoText) return undefined;
    const { aggregate, perCore } = parseStat(statText);
    const memory = parseMeminfo(meminfoText);
    const network = parseNetDev(readText(path.join(PROC_ROOT, "net", "dev")) ?? "");
    const diskIo = parseDiskstats(readText(path.join(PROC_ROOT, "diskstats")) ?? "");
    const load = parseLoadavg(readText(path.join(PROC_ROOT, "loadavg")) ?? "");
    const uptimeSeconds = parseUptime(readText(path.join(PROC_ROOT, "uptime")) ?? "");

    // cgroup v2 lives at the root of /sys/fs/cgroup, v1 nests one controller per directory.
    let cgroupVersion: "v1" | "v2" | "none" = "none";
    let cgroupUsageSeconds: number | undefined;
    let containerMemoryBytes = 0;
    let containerMemoryLimitBytes = 0;
    const v2Memory = readNumber(path.join(CGROUP_ROOT, "memory.current"));
    if (v2Memory !== undefined) {
      cgroupVersion = "v2";
      containerMemoryBytes = Math.max(0, v2Memory - parseInactiveFile(readText(path.join(CGROUP_ROOT, "memory.stat")) ?? ""));
      const max = readText(path.join(CGROUP_ROOT, "memory.max"));
      containerMemoryLimitBytes = normalizeMemoryLimit(max === undefined || max.trim() === "max" ? Number.POSITIVE_INFINITY : Number(max));
      const microseconds = parseCgroupUsageMicroseconds(readText(path.join(CGROUP_ROOT, "cpu.stat")) ?? "");
      if (microseconds !== undefined) cgroupUsageSeconds = microseconds / 1e6;
    } else {
      const v1Memory = readNumber(path.join(CGROUP_ROOT, "memory", "memory.usage_in_bytes"));
      if (v1Memory !== undefined) {
        cgroupVersion = "v1";
        containerMemoryBytes = Math.max(0, v1Memory - parseInactiveFile(readText(path.join(CGROUP_ROOT, "memory", "memory.stat")) ?? ""));
        containerMemoryLimitBytes = normalizeMemoryLimit(readNumber(path.join(CGROUP_ROOT, "memory", "memory.limit_in_bytes")));
        const nanoseconds = parseCgroupUsageNanoseconds(readText(path.join(CGROUP_ROOT, "cpuacct", "cpuacct.usage")) ?? "");
        if (nanoseconds !== undefined) cgroupUsageSeconds = nanoseconds / 1e9;
      }
    }

    return { cpu: aggregate, perCore, memory, load, uptimeSeconds, network, diskIo, cgroupVersion, cgroupUsageSeconds, containerMemoryBytes, containerMemoryLimitBytes, recordings: this.recordingUsage() };
  }

  /** Size and directory count of the in-flight download area (one level deep). */
  private recordingUsage(): { activeDirectories: number; bytesOnDisk: number } {
    let activeDirectories = 0;
    let bytesOnDisk = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.recordingsRoot, { withFileTypes: true });
    } catch {
      return { activeDirectories, bytesOnDisk };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      activeDirectories += 1;
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(path.join(this.recordingsRoot, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile()) continue;
        try {
          bytesOnDisk += fs.statSync(path.join(this.recordingsRoot, entry.name, file.name)).size;
        } catch {
          // A partial file can vanish between readdir and stat; ignore it.
        }
      }
    }
    return { activeDirectories, bytesOnDisk };
  }

  private collect() {
    const reading = this.read();
    if (!reading) {
      this.snapshot = this.emptySnapshot("/proc is not readable in this environment");
      return;
    }
    const previous = this.previous;
    const seconds = previous ? Math.max(0.001, this.intervalMs / 1000) : 0;
    const perCorePercent = reading.perCore.map((ticks, index) => (previous ? usagePercent(previous.perCore[index] ?? ticks, ticks) : 0));
    const hostUsedBytes = Math.max(0, reading.memory.totalBytes - reading.memory.availableBytes);
    const recordings = reading.recordings;
    const containerPercent = reading.containerMemoryLimitBytes > 0 ? clampPercent((reading.containerMemoryBytes / reading.containerMemoryLimitBytes) * 100) : 0;

    this.snapshot = {
      available: true, platform: this.platform, sampledAt: new Date().toISOString(), intervalMs: this.intervalMs,
      host: {
        cpu: {
          cores: reading.perCore.length || 1,
          usagePercent: previous ? usagePercent(previous.cpu, reading.cpu) : 0,
          perCorePercent,
          ...reading.load,
          uptimeSeconds: Math.round(reading.uptimeSeconds),
        },
        memory: {
          totalBytes: reading.memory.totalBytes, usedBytes: hostUsedBytes,
          availableBytes: reading.memory.availableBytes,
          percent: reading.memory.totalBytes ? clampPercent((hostUsedBytes / reading.memory.totalBytes) * 100) : 0,
        },
        network: {
          ...reading.network,
          receivedBytesPerSecond: previous && seconds ? Math.max(0, (reading.network.receivedBytes - previous.network.receivedBytes) / seconds) : 0,
          transmittedBytesPerSecond: previous && seconds ? Math.max(0, (reading.network.transmittedBytes - previous.network.transmittedBytes) / seconds) : 0,
        },
        diskIo: {
          ...reading.diskIo,
          readBytesPerSecond: previous && seconds ? Math.max(0, (reading.diskIo.readBytes - previous.diskIo.readBytes) / seconds) : 0,
          writtenBytesPerSecond: previous && seconds ? Math.max(0, (reading.diskIo.writtenBytes - previous.diskIo.writtenBytes) / seconds) : 0,
        },
      },
      container: {
        detected: reading.cgroupVersion !== "none",
        cgroupVersion: reading.cgroupVersion,
        cpuPercent: previous && seconds && reading.cgroupUsageSeconds !== undefined && previous.cgroupUsageSeconds !== undefined
          ? clampPercent(((reading.cgroupUsageSeconds - previous.cgroupUsageSeconds) / seconds) * 100)
          : 0,
        memoryBytes: reading.containerMemoryBytes,
        memoryLimitBytes: reading.containerMemoryLimitBytes,
        memoryPercent: containerPercent,
      },
      disks: this.disks(),
      recordings: {
        ...recordings,
        writeBytesPerSecond: previous && seconds ? Math.max(0, (recordings.bytesOnDisk - previous.recordings.bytesOnDisk) / seconds) : 0,
      },
    };

    this.previous = reading;
  }

  private disks(): DiskUsage[] {
    const found: DiskUsage[] = [];
    for (const [target, label] of [["/", "Host filesystem"], [this.mediaDir, "Media library"]] as Array<[string, string]>) {
      const usage = diskUsage(target, label);
      if (!usage) continue;
      if (found.some((entry) => entry.totalBytes === usage.totalBytes && entry.freeBytes === usage.freeBytes)) continue;
      found.push(usage);
    }
    return found;
  }
}
