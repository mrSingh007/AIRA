import { z } from "zod";
import type {
  Ticket,
  TicketAttachment,
  TicketAttachmentInput,
} from "../shared/types.js";
import { assert, id, type State } from "./state.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const attachmentInput = z
  .array(
    z.union([
      z.object({ id: z.string().uuid() }).strict(),
      z
        .object({
          filename: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .refine(
              (value) => !/[\\/\x00-\x1f\x7f]/.test(value),
              "Use a simple attachment filename.",
            ),
          contentType: z.enum([
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "text/markdown",
          ]),
          data: z
            .string()
            .min(1)
            .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
        })
        .strict(),
    ]),
  )
  .max(10, "Attach at most 5 images and 5 Markdown files.")
  .superRefine((inputs, context) => {
    for (const markdown of [false, true]) {
      if (inputs.filter(input => "contentType" in input && (input.contentType === "text/markdown") === markdown).length > 5)
        context.addIssue({ code: "custom", message: markdown ? "Attach at most 5 Markdown files." : "Attach at most 5 images." });
    }
  });

function attachmentBytes(
  input: Extract<TicketAttachmentInput, { data: string }>,
): Buffer {
  assert(
    /^[A-Za-z0-9+/]*={0,2}$/.test(input.data),
    400,
    "Attachment data must be valid base64.",
  );
  const bytes = Buffer.from(input.data, "base64");
  assert(
    bytes.toString("base64") === input.data,
    400,
    "Attachment data must be valid base64.",
  );
  assert(
    bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES,
    400,
    "Each attachment must be at most 2 MiB.",
  );
  if (input.contentType === "text/markdown") {
    assert(/\.(md|markdown)$/i.test(input.filename), 400, "Markdown attachments must use a .md or .markdown filename.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { assert(false, 400, "Markdown attachments must contain valid UTF-8 text."); }
    assert(!text.includes("\0"), 400, "Markdown attachments cannot contain null bytes.");
    return bytes;
  }
  const matches = {
    "image/png":
      bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      bytes.toString("ascii", 12, 16) === "IHDR",
    "image/jpeg":
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9,
    "image/gif":
      bytes.length >= 14 &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)),
    "image/webp":
      bytes.length >= 20 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" &&
      bytes.readUInt32LE(4) + 8 === bytes.length,
  };
  assert(
    matches[input.contentType],
    400,
    "The image contents do not match the selected PNG, JPEG, GIF, or WebP format.",
  );
  return bytes;
}

export function replaceAttachments(
  state: State,
  ticket: Ticket,
  inputs: TicketAttachmentInput[],
): void {
  assert(
    ticket.status === "backlog",
    409,
    "Attachments can only be changed while the ticket is in Backlog.",
  );
  const data: Record<string, string> = {};
  const attachments: TicketAttachment[] = inputs.map((input) => {
    if ("id" in input) {
      const current = ticket.attachments.find(
        (attachment) => attachment.id === input.id,
      );
      assert(
        current && state.attachmentData[current.id],
        400,
        "An attachment no longer exists or belongs to another ticket.",
      );
      return current;
    }
    const bytes = attachmentBytes(input);
    const attachment = {
      id: id(),
      filename: input.filename,
      contentType: input.contentType,
      size: bytes.length,
    };
    data[attachment.id] = bytes.toString("base64");
    return attachment;
  });
  assert(
    new Set(attachments.map((attachment) => attachment.id)).size ===
      attachments.length,
    400,
    "Attachments must be distinct.",
  );
  assert(attachments.filter(a => a.contentType === "text/markdown").length <= 5 &&
    attachments.filter(a => a.contentType !== "text/markdown").length <= 5, 400,
    "Attach at most 5 images and 5 Markdown files.");
  for (const previous of ticket.attachments)
    if (!attachments.some((attachment) => attachment.id === previous.id))
      delete state.attachmentData[previous.id];
  Object.assign(state.attachmentData, data);
  ticket.attachments = attachments;
}

export function attachmentPath(
  ticketNumber: string,
  attachment: TicketAttachment,
): string {
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "text/markdown": "md",
  }[attachment.contentType];
  assert(
    /^[A-Za-z0-9-]+$/.test(ticketNumber) &&
      /^[a-f0-9-]{36}$/.test(attachment.id) &&
      extension,
    400,
    "Invalid ticket attachment path.",
  );
  const directory = attachment.contentType === "text/markdown" ? "attachments" : "images";
  return `docs/kangentix/${ticketNumber}/${directory}/${attachment.id}.${extension}`;
}
