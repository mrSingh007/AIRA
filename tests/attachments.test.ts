import assert from "node:assert/strict";
import test from "node:test";
import { attachmentInput, attachmentPath, MAX_IMAGE_BYTES, replaceAttachments } from "../src/server/attachments.js";
import { ApiError, emptyState } from "../src/server/state.js";
import type { Ticket, TicketAttachment, TicketAttachmentInput } from "../src/shared/types.js";

const ticket = (): Ticket => ({ id: "ticket", projectId: "project", number: "KANGENTIX-1", title: "Images", description: "", attachments: [], workflowSnapshot: null, priority: "medium", status: "backlog", stepId: null, sprintId: null, createdBy: "user", createdAt: "", updatedAt: "", closedAt: null, pullRequests: [] });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const upload = (bytes = png): Extract<TicketAttachmentInput, { data: string }> => ({ filename: "image.png", contentType: "image/png", data: bytes.toString("base64") });
const badRequest = (error: unknown) => error instanceof ApiError && error.status === 400;

test("attachment input validates safe filenames, supported formats, strict fields and five-image limit", () => {
  const parsed = attachmentInput.parse([{ ...upload(), filename: " image.png " }])[0];
  assert.ok("filename" in parsed);
  assert.equal(parsed.filename, "image.png");
  for (const filename of ["", "../image.png", "dir/image.png", "dir\\image.png", "nul\0.png", "control\n.png", "x".repeat(201)]) {
    assert.equal(attachmentInput.safeParse([{ ...upload(), filename }]).success, false, filename);
  }
  for (const input of [{ ...upload(), contentType: "image/svg+xml" }, { ...upload(), extra: true }, { id: "not-a-uuid" }, { ...upload(), data: "" }]) {
    assert.equal(attachmentInput.safeParse([input]).success, false);
  }
  assert.equal(attachmentInput.safeParse(Array.from({ length: 6 }, () => upload())).success, false);
});

test("all supported image signatures can be stored and receive stable typed paths", () => {
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
  const webp = Buffer.alloc(20); webp.write("RIFF", 0); webp.writeUInt32LE(12, 4); webp.write("WEBP", 8);
  const images = [["image/png", png, "png"], ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9]), "jpg"], ["image/gif", gif, "gif"], ["image/webp", webp, "webp"]] as const;
  for (const [contentType, bytes, extension] of images) {
    const state = emptyState(); const current = ticket();
    replaceAttachments(state, current, [{ filename: `upload.${extension}`, contentType, data: bytes.toString("base64") }]);
    const attachment = current.attachments[0];
    assert.equal(attachment.size, bytes.length);
    assert.equal(state.attachmentData[attachment.id], bytes.toString("base64"));
    assert.equal(attachmentPath(current.number, attachment), `docs/kangentix/KANGENTIX-1/images/${attachment.id}.${extension}`);
  }
});

test("replacement preserves retained data and removes only this ticket's discarded images", () => {
  const state = emptyState(); const current = ticket();
  replaceAttachments(state, current, [upload(), { ...upload(), filename: "second.png" }]);
  const [retained, removed] = current.attachments;
  state.attachmentData.other = "unrelated-data";
  replaceAttachments(state, current, [{ id: retained.id }, { ...upload(), filename: "new.png" }]);
  assert.equal(current.attachments[0], retained);
  assert.equal(state.attachmentData[retained.id], png.toString("base64"));
  assert.equal(state.attachmentData[removed.id], undefined);
  assert.equal(state.attachmentData.other, "unrelated-data");
  replaceAttachments(state, current, []);
  assert.deepEqual(current.attachments, []);
  assert.deepEqual(state.attachmentData, { other: "unrelated-data" });
});

test("invalid, duplicate, foreign and corrupt image replacements are atomic", () => {
  const state = emptyState(); const current = ticket();
  replaceAttachments(state, current, [upload()]);
  const existing = current.attachments[0];
  state.attachmentData["00000000-0000-4000-8000-000000000000"] = "other ticket";
  const before = structuredClone({ attachments: current.attachments, data: state.attachmentData });
  const malformed: TicketAttachmentInput[][] = [
    [upload(), { ...upload(), data: "not base64!" }],
    [{ ...upload(), data: "Zg" }],
    [{ ...upload(), data: "Zh==" }],
    [{ ...upload(), data: Buffer.from("text").toString("base64") }],
    [{ ...upload(), contentType: "image/jpeg" }],
    [{ id: existing.id }, { id: existing.id }],
    [{ id: "00000000-0000-4000-8000-000000000000" }],
    [{ id: "missing" }],
  ];
  for (const inputs of malformed) {
    assert.throws(() => replaceAttachments(state, current, inputs), badRequest);
    assert.deepEqual({ attachments: current.attachments, data: state.attachmentData }, before);
  }
  delete state.attachmentData[existing.id];
  assert.throws(() => replaceAttachments(state, current, [{ id: existing.id }]), badRequest);
});

test("decoded size bounds and WebP declared lengths are enforced", () => {
  const state = emptyState(); const current = ticket();
  const maximum = Buffer.alloc(MAX_IMAGE_BYTES); png.copy(maximum);
  replaceAttachments(state, current, [upload(maximum)]);
  assert.equal(current.attachments[0].size, MAX_IMAGE_BYTES);
  assert.throws(() => replaceAttachments(state, current, [upload(Buffer.concat([maximum, Buffer.from([0])]))]), badRequest);
  const webp = Buffer.alloc(20); webp.write("RIFF"); webp.write("WEBP", 8); webp.writeUInt32LE(13, 4);
  assert.throws(() => replaceAttachments(state, current, [{ filename: "bad.webp", contentType: "image/webp", data: webp.toString("base64") }]), badRequest);
});

test("images are editable only outside sprints in backlog and paths cannot escape image directories", () => {
  const state = emptyState(); const current = ticket();
  for (const changes of [{ status: "active" as const }, { status: "closed" as const }, { status: "backlog" as const, sprintId: "sprint" }]) {
    Object.assign(current, changes);
    assert.throws(() => replaceAttachments(state, current, []), (error: unknown) => error instanceof ApiError && error.status === 409);
  }
  const attachment: TicketAttachment = { id: "00000000-0000-4000-8000-000000000000", filename: "ignored.png", contentType: "image/png", size: 1 };
  for (const number of ["../KANGENTIX", "KANGENTIX/1", "KANGENTIX_1", ""]) assert.throws(() => attachmentPath(number, attachment), badRequest);
  assert.throws(() => attachmentPath("KANGENTIX-1", { ...attachment, id: "../../escape" }), badRequest);
});
