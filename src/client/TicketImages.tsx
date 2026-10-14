import { useState } from "react";
import { FileText, ImagePlus, X } from "lucide-react";
import type {
  Ticket,
  TicketAttachment,
  TicketAttachmentInput,
} from "../shared/types";
import { errorMessage } from "./api";
import { randomId } from "./id";

export interface ImageDraft {
  key: string;
  filename: string;
  preview: string;
  contentType?: TicketAttachment["contentType"];
  input: TicketAttachmentInput;
}
export function ticketImageDrafts(ticket: Ticket): ImageDraft[] {
  return ticket.attachments.map((image) => ({
    key: image.id,
    contentType: image.contentType,
    filename: image.filename,
    preview: `/api/tickets/${ticket.id}/attachments/${image.id}`,
    input: { id: image.id },
  }));
}
export function validateAttachmentFiles(images: ImageDraft[], files: Pick<File, "name" | "size" | "type">[]): string {
  const markdownFile = (file: Pick<File, "name">) => /\.(md|markdown)$/i.test(file.name);
  for (const markdown of [false, true]) {
    const current = images.filter(image => (image.contentType === "text/markdown") === markdown).length;
    if (current + files.filter(file => markdownFile(file) === markdown).length > 5)
      return markdown ? "Attach up to 5 Markdown files per ticket." : "Attach up to 5 images per ticket.";
  }
  if (files.some(file => (!markdownFile(file) && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) || !file.size || file.size > 2 * 1024 * 1024))
    return "Choose PNG, JPEG, GIF, WebP, or Markdown (.md or .markdown) files, up to 2 MB each.";
  return "";
}

export function TicketImages({
  images,
  onChange,
  disabled,
  onBusy,
}: {
  images: ImageDraft[];
  onChange?: (images: ImageDraft[]) => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  async function addFiles(files: File[]) {
    setError("");
    if (!files.length) return;
    const validationError = validateAttachmentFiles(images, files);
    if (validationError) { setError(validationError); return; }
    setReading(true);
    onBusy?.(true);
    try {
      const additions = await Promise.all(
        files.map(async (file) => {
          const preview = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () =>
              reject(new Error(`Could not read ${file.name}.`));
            reader.readAsDataURL(file);
          });
          return {
            key: randomId(),
            contentType: (/\.(md|markdown)$/i.test(file.name) ? "text/markdown" : file.type) as TicketAttachment["contentType"],
            filename: file.name,
            preview,
            input: {
              filename: file.name,
              contentType: (/\.(md|markdown)$/i.test(file.name) ? "text/markdown" : file.type) as TicketAttachment["contentType"],
              data: preview.slice(preview.indexOf(",") + 1),
            },
          };
        }),
      );
      onChange?.([...images, ...additions]);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setReading(false);
      onBusy?.(false);
    }
  }
  if (!onChange && !images.length) return null;
  return (
    <div className="ticket-images">
      <span className="field-label">Attachments</span>
      {images.length > 0 && (
        <div className="ticket-image-grid">
          {images.map((image) => (
            <div className="ticket-image" key={image.key}>
              <a href={image.preview} target="_blank" rel="noreferrer">
                {image.contentType === "text/markdown" ? <FileText size={32} aria-label="Markdown file" /> : <img src={image.preview} alt={image.filename} />}
                <span>{image.filename}</span>
              </a>
              {onChange && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${image.filename}`}
                  disabled={disabled || reading}
                  onClick={() =>
                    onChange(images.filter((item) => item.key !== image.key))
                  }
                >
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {onChange && (
        <>
          <label className="image-upload">
            <span>
              <ImagePlus size={16} />
              {reading ? "Reading files…" : "Attach images or Markdown"}
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,text/markdown,.md,.markdown"
              multiple
              disabled={disabled || reading || images.length >= 10}
              onChange={(event) => {
                void addFiles(Array.from(event.target.files || []));
                event.target.value = "";
              }}
            />
          </label>
          <small className="muted">
            Up to 5 images and 5 Markdown files, 2 MB each. Your agent can access these attachments in
            every workflow step.
          </small>
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
