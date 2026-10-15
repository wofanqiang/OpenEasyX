import { describe, expect, it, vi } from "vitest";
import { stripchatSearchUsernames, stripchatModelFromPage, searchStripchatPeople, discoverStripchatSources } from "./index.js";
const page = (state: unknown) => `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`;
const context = () => ({ config: {}, fetch, log: vi.fn(), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: page({ viewCam: { model: { id: 1, username: "Alice", isOnline: false } } }), stderr: "" })) });
describe("Stripchat performer discovery", () => {
  it.each([["@Alice", ["Alice"]], ["Jane Doe", ["JaneDoe", "Jane_Doe", "Jane-Doe"]], ["https://stripchat.com/Alice", ["Alice"]], ["a/b", []]])("accepts exact username query %s", (query, expected) => {
    expect(stripchatSearchUsernames(query as string)).toEqual(expected);
  });
  it("finds offline room models and preserves their online=false status", async () => {
    expect(await searchStripchatPeople(context(), "Alice")).toMatchObject([{ externalId: "alice", metadata: { online: false } }]);
  });
  it("does not confuse viewer/user records with model records", () => {
    expect(stripchatModelFromPage(page({ user: { username: "Alice", id: 1 } }), "Alice")).toBeUndefined();
    expect(stripchatModelFromPage(page({ viewCam: { model: { username: "Alice", id: 1, isModel: false } } }), "Alice")).toBeUndefined();
    expect(stripchatModelFromPage(page({ models: [{ username: "Alice", id: 1, isModel: true }] }), "Alice")).toMatchObject({ username: "Alice" });
  });
  it("parses escaped quotes and braces without confusing the page state", () => {
    expect(stripchatModelFromPage(page({ viewCam: { model: { id: 1, username: "Alice", bio: 'hello "{world}"', isModel: true } } }), "Alice")?.username).toBe("Alice");
  });
  it("only discovers a linked room, including legacy live references", async () => {
    expect(await discoverStripchatSources(context(), { id: "p", name: "Alice", aliases: [], externalRefs: {} })).toEqual([]);
    expect(await discoverStripchatSources(context(), { id: "p", name: "Alice", aliases: [], externalRefs: { "org.easyx.stripchat": "live:alice" } })).toMatchObject([{ externalId: "https://stripchat.com/Alice" }]);
  });
});
