import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketImages, validateAttachmentFiles, type ImageDraft } from "./TicketImages";

const image: ImageDraft = { key: "image", filename: "design.png", preview: "/api/tickets/t/attachments/image", contentType: "image/png", input: { id: "image" } };
const markdown: ImageDraft = { key: "markdown", filename: "requirements.md", preview: "/api/tickets/t/attachments/markdown", contentType: "text/markdown", input: { id: "markdown" } };

test("Markdown attachments use the authenticated file link and document preview instead of an image", () => {
  const html = renderToStaticMarkup(<TicketImages images={[image, markdown]} />);
  assert.match(html, /href="\/api\/tickets\/t\/attachments\/markdown"/);
  assert.match(html, /aria-label="Markdown file"/);
  assert.match(html, /requirements.md/);
  assert.doesNotMatch(html, /<img[^>]*attachments\/markdown/);
  assert.match(html, /<img[^>]*attachments\/image/);
});

test("file picker supports Markdown alongside images with independent limits", () => {
  const html = renderToStaticMarkup(<TicketImages images={[]} onChange={() => {}} />);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/gif,image\/webp,text\/markdown,.md,.markdown"/);
  const file = { name: "context.markdown", type: "", size: 10 };
  assert.equal(validateAttachmentFiles(Array(5).fill(image), [file]), "");
  assert.match(validateAttachmentFiles(Array(5).fill(markdown), [file]), /5 Markdown/);
  assert.match(validateAttachmentFiles(Array(5).fill(image), [{ name: "extra.png", type: "image/png", size: 10 }]), /5 images/);
  assert.match(validateAttachmentFiles([], [{ ...file, size: 2 * 1024 * 1024 + 1 }]), /2 MB/);
  assert.match(validateAttachmentFiles([], [{ ...file, size: 0 }]), /2 MB/);
  assert.match(validateAttachmentFiles([], [{ name: "unsafe.html", type: "text/html", size: 10 }]), /Choose/);
});
