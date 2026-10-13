import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { repositoryPath, validateFileChanges, type FileChange, type RepositorySnapshot } from "../src/server/github.js";

const snapshot: RepositorySnapshot = {
  sha: "commit", treeSha: "tree", entries: [], archivePath: "unused", archiveSize: 0,
  dispose: async () => {},
};
const change = (path: string, content = "changed", mode: FileChange["mode"] = "100644"): FileChange => ({
  path, mode, content: Buffer.from(content).toString("base64"),
});

test("repository names must identify exactly one owner and repository", () => {
  assert.equal(repositoryPath("owner-name/repo.name"), "/repos/owner-name/repo.name");
  for (const value of ["", "owner", "owner/repo/extra", "../repo", "owner/..", "owner/repo?token=value", "owner\\repo", " owner/repo"])
    assert.throws(() => repositoryPath(value), /owner\/repository/);
});

test("file changes reject traversal, Git metadata and ambiguous paths", () => {
  for (const path of ["", "/absolute", "../outside", "nested/../../outside", "nested/.git/config", ".GIT/HEAD", "nested//file", "nested/./file", "nested\\file", "line\nbreak", "control\x7f", "x".repeat(1001)])
    assert.throws(() => validateFileChanges([change(path)], snapshot), /unsafe repository path/, path);
  assert.deepEqual(validateFileChanges([change("src/my file.ts")], snapshot), [change("src/my file.ts")]);
});

test("duplicate paths and unsupported modes cannot reach repository publication", () => {
  assert.throws(() => validateFileChanges([change("source"), change("source")], snapshot), /duplicate repository paths/);
  assert.throws(() => validateFileChanges([{ ...change("source"), mode: "160000" }], snapshot), /unsupported file mode/);
  assert.throws(() => validateFileChanges({}, snapshot), /at most 500 files/);
  assert.throws(() => validateFileChanges(Array.from({ length: 501 }, (_, i) => change(`file-${i}`)), snapshot), /at most 500 files/);
});

test("only canonical base64 contents are accepted", () => {
  for (const content of [undefined, 42, "%%%", "YQ", "YQ==\n", "YQ===", "YR=="])
    assert.throws(() => validateFileChanges([{ path: "source", mode: "100644", content }], snapshot), /invalid file contents/);
  assert.deepEqual(validateFileChanges([change("empty", "")], snapshot), [change("empty", "")]);
});

test("unchanged blobs are omitted while mode changes and existing deletions are retained", () => {
  const contents = "unchanged\n";
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(contents)}\0`).update(contents).digest("hex");
  const original = { ...snapshot, entries: [{ path: "source", mode: "100644", type: "blob", sha }] };
  assert.deepEqual(validateFileChanges([change("source", contents)], original), []);
  assert.deepEqual(validateFileChanges([change("source", contents, "100755")], original), [change("source", contents, "100755")]);
  assert.deepEqual(validateFileChanges([{ path: "missing", mode: "100644", content: null }], original), []);
  const deletion: FileChange = { path: "source", mode: "100644", content: null };
  assert.deepEqual(validateFileChanges([deletion], original), [deletion]);
});

test("symbolic links may point within the repository but cannot escape or target Git metadata", () => {
  const safe = change("nested/link", "../source", "120000");
  assert.deepEqual(validateFileChanges([safe], snapshot), [safe]);
  for (const target of ["", "/etc/passwd", "../../outside", "..\\outside", "../.git/config", "../.GIT/HEAD", "source\n"])
    assert.throws(() => validateFileChanges([change("nested/link", target, "120000")], snapshot), /symbolic link|Symbolic link/);
});

test("file transfer limits count decoded bytes per file and across the complete change set", () => {
  const limit = 5 * 1024 * 1024;
  const boundary = Buffer.alloc(limit).toString("base64");
  const oversized = Buffer.alloc(limit + 1).toString("base64");
  assert.equal(validateFileChanges([{ path: "boundary", mode: "100644", content: boundary }], snapshot).length, 1);
  assert.throws(() => validateFileChanges([{ path: "oversized", mode: "100644", content: oversized }], snapshot), /transfer limit/);
  const maximum = Array.from({ length: 4 }, (_, i) => ({ path: `file-${i}`, mode: "100644" as const, content: boundary }));
  assert.equal(validateFileChanges(maximum, snapshot).length, 4);
  assert.throws(() => validateFileChanges([...maximum, change("one-byte-too-many", "x")], snapshot), /20 MiB total/);
});
