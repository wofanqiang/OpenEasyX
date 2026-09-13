import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deletePerformerFiles, ensurePerformerDirectory, renamePerformerDirectory } from "./performer-files.js";

const roots: string[] = [];
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-performer-files-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("performer media directories", () => {
  it("creates and renames the directory as soon as the performer changes", () => {
    const root = temp();
    expect(ensurePerformerDirectory(root, "A/B Star")).toBe(path.join(root, "A-B Star"));
    expect(fs.existsSync(path.join(root, "A-B Star"))).toBe(true);
    renamePerformerDirectory(root, "A/B Star", "Better Name");
    expect(fs.existsSync(path.join(root, "Better Name"))).toBe(true);
    expect(fs.existsSync(path.join(root, "A-B Star"))).toBe(false);
  });

  it("removes only the selected performer's media tree", () => {
    const root = temp(); const directory = ensurePerformerDirectory(root, "Example");
    fs.mkdirSync(path.join(directory, "example.test"));
    fs.writeFileSync(path.join(directory, "example.test", "one.jpg"), "one");
    fs.mkdirSync(path.join(root, "Keep"));
    fs.writeFileSync(path.join(root, "Keep", "two.jpg"), "two");
    const removed = deletePerformerFiles(root, { id: "p", name: "Example", aliases: [], externalRefs: {}, autoRecord: false, createdAt: "", updatedAt: "" }, []);
    expect(removed).toBe(1);
    expect(fs.existsSync(directory)).toBe(false);
    expect(fs.existsSync(path.join(root, "Keep", "two.jpg"))).toBe(true);
  });
});
