import { describe, expect, it } from "vitest";
import {
  SystemStatsService,
  clampPercent,
  normalizeMemoryLimit,
  parseCgroupUsageMicroseconds,
  parseCgroupUsageNanoseconds,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseStat,
  parseUptime,
  usagePercent,
} from "./system-stats.js";

const STAT_SAMPLE = [
  "cpu  100 0 50 1000 20 0 5 0 0 0",
  "cpu0 60 0 30 500 10 0 2 0 0 0",
  "cpu1 40 0 20 500 10 0 3 0 0 0",
  "intr 1 2 3",
  "ctxt 9",
].join("\n");

describe("system stats parsers", () => {
  it("reads total and available memory from meminfo", () => {
    const memory = parseMeminfo(["MemTotal:        1000000 kB", "MemFree:          100000 kB", "MemAvailable:     400000 kB", "Buffers:           10000 kB", "Cached:           200000 kB"].join("\n"));
    expect(memory.totalBytes).toBe(1_000_000 * 1024);
    expect(memory.availableBytes).toBe(400_000 * 1024);
  });

  it("falls back to free + buffers + cache when MemAvailable is missing", () => {
    const memory = parseMeminfo(["MemTotal:  1000 kB", "MemFree:    100 kB", "Buffers:     50 kB", "Cached:     150 kB", "SReclaimable: 25 kB"].join("\n"));
    expect(memory.availableBytes).toBe(325 * 1024);
  });

  it("never reports more available than total", () => {
    const memory = parseMeminfo(["MemTotal:  100 kB", "MemAvailable: 900 kB"].join("\n"));
    expect(memory.availableBytes).toBe(100 * 1024);
  });

  it("splits aggregate and per-core cpu ticks, treating iowait as idle", () => {
    const { aggregate, perCore } = parseStat(STAT_SAMPLE);
    expect(perCore).toHaveLength(2);
    // idle = idle + iowait; total = the first eight fields (guest is folded into user/nice)
    expect(aggregate).toEqual({ total: 100 + 50 + 1000 + 20 + 5, idle: 1020 });
    expect(perCore[0]).toEqual({ total: 60 + 30 + 500 + 10 + 2, idle: 510 });
    expect(perCore[1]).toEqual({ total: 40 + 20 + 500 + 10 + 3, idle: 510 });
  });

  it("derives cpu usage from two tick readings", () => {
    // 200 ticks elapsed, 50 of them idle => 75% busy.
    expect(usagePercent({ total: 1000, idle: 400 }, { total: 1200, idle: 450 })).toBe(75);
    expect(usagePercent({ total: 1000, idle: 400 }, { total: 1000, idle: 400 })).toBe(0);
  });

  it("parses load average and uptime", () => {
    expect(parseLoadavg("0.13 0.36 0.50 1/234 5678")).toEqual({ load1: 0.13, load5: 0.36, load15: 0.5 });
    expect(parseUptime("12345.67 43210.00")).toBe(12345.67);
  });

  it("sums network counters but skips loopback and header lines", () => {
    const counters = parseNetDev([
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 9999999   10000    0    0    0     0          0         0  9999999   10000    0    0    0     0       0          0",
      "  eth0:  5000      40    0    0    0     0          0         0     7000      50    0    0    0     0       0          0",
      "  eth1:  1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0",
    ].join("\n"));
    expect(counters).toEqual({ receivedBytes: 6000, transmittedBytes: 9000 });
  });

  it("counts whole disks only and converts sectors to bytes", () => {
    const io = parseDiskstats([
      "   8       0 sda 100 0 2000 50 200 0 4000 60 0 0 0",
      "   8       1 sda1 100 0 2000 50 200 0 4000 60 0 0 0",
      " 253       0 dm-0 10 0 100 5 10 0 100 5 0 0 0",
      " 259       0 nvme0n1 5 0 800 1 5 0 1600 1 0 0 0",
    ].join("\n"));
    // sda1 (partition) and dm-0 (device mapper) must be ignored.
    expect(io).toEqual({ readBytes: (2000 + 800) * 512, writtenBytes: (4000 + 1600) * 512 });
  });

  it("reads cgroup usage in both accounting formats", () => {
    expect(parseCgroupUsageMicroseconds("usage_usec 1234567\nuser_usec 100\nsystem_usec 50")).toBe(1234567);
    expect(parseCgroupUsageMicroseconds("user_usec 100\nsystem_usec 50")).toBeUndefined();
    expect(parseCgroupUsageNanoseconds("1234567890\n")).toBe(1234567890);
  });

  it("treats cgroup sentinels as unlimited", () => {
    expect(normalizeMemoryLimit(1_468_006_400)).toBe(1_468_006_400);
    expect(normalizeMemoryLimit(undefined)).toBe(0);
    expect(normalizeMemoryLimit(9_223_372_036_854_771_000)).toBe(0);
    expect(normalizeMemoryLimit(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("clamps percentages to a sane range", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(123.456)).toBe(100);
    expect(clampPercent(23.44)).toBe(23.4);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("SystemStatsService", () => {
  it("degrades gracefully off Linux instead of throwing", () => {
    const service = new SystemStatsService({ mediaDir: process.cwd(), platform: "win32" });
    service.start();
    const snapshot = service.snapshotNow();
    service.stop();
    expect(snapshot.available).toBe(false);
    expect(snapshot.platform).toBe("win32");
    expect(snapshot.reason).toContain("Linux");
    expect(snapshot.disks).toEqual([]);
    expect(snapshot.container.detected).toBe(false);
  });

  it("reports a container memory percentage only when a limit is set", () => {
    const service = new SystemStatsService({ mediaDir: process.cwd(), platform: "win32" });
    const snapshot = service.snapshotNow();
    expect(snapshot.container.memoryLimitBytes).toBe(0);
    expect(snapshot.container.memoryPercent).toBe(0);
  });
});
