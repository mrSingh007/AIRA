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
              "Use a simple image filename.",
            ),
          contentType: z.enum([
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ]),
          data: z
            .string()
            .min(1)
            .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
        })
        .strict(),
    ]),
  )
  .max(5, "Attach at most 5 images.");

function imageBytes(
  input: Extract<TicketAttachmentInput, { data: string }>,
): Buffer {
  assert(
    /^[A-Za-z0-9+/]*={0,2}$/.test(input.data),
    400,
    "Image data must be valid base64.",
  );
  const bytes = Buffer.from(input.data, "base64");
  assert(
    bytes.toString("base64") === input.data,
    400,
    "Image data must be valid base64.",
  );
  assert(
    bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES,
    400,
    "Each image must be at most 2 MiB.",
  );
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
    ticket.status === "backlog" && !ticket.sprintId,
    409,
    "Images can only be changed while the ticket is in Backlog.",
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
        "An attached image no longer exists or belongs to another ticket.",
      );
      return current;
    }
    const bytes = imageBytes(input);
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
    "Images must be distinct.",
  );
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
  }[attachment.contentType];
  assert(
    /^[A-Za-z0-9-]+$/.test(ticketNumber) &&
      /^[a-f0-9-]{36}$/.test(attachment.id) &&
      extension,
    400,
    "Invalid ticket image path.",
  );
  return `docs/kangentix/${ticketNumber}/images/${attachment.id}.${extension}`;
}
