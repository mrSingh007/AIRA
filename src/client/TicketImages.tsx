import { useState } from "react";
import { ImagePlus, X } from "lucide-react";
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
  input: TicketAttachmentInput;
}
export function ticketImageDrafts(ticket: Ticket): ImageDraft[] {
  return ticket.attachments.map((image) => ({
    key: image.id,
    filename: image.filename,
    preview: `/api/tickets/${ticket.id}/attachments/${image.id}`,
    input: { id: image.id },
  }));
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
    if (images.length + files.length > 5) {
      setError("Attach up to 5 images per ticket.");
      return;
    }
    if (
      files.some(
        (file) =>
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            file.type,
          ) ||
          file.size > 2 * 1024 * 1024 ||
          !file.size,
      )
    ) {
      setError("Choose PNG, JPEG, GIF, or WebP images, up to 2 MB each.");
      return;
    }
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
            filename: file.name,
            preview,
            input: {
              filename: file.name,
              contentType: file.type as TicketAttachment["contentType"],
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
      <span className="field-label">Images</span>
      {images.length > 0 && (
        <div className="ticket-image-grid">
          {images.map((image) => (
            <div className="ticket-image" key={image.key}>
              <a href={image.preview} target="_blank" rel="noreferrer">
                <img src={image.preview} alt={image.filename} />
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
              {reading ? "Reading images…" : "Attach images"}
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              disabled={disabled || reading || images.length >= 5}
              onChange={(event) => {
                void addFiles(Array.from(event.target.files || []));
                event.target.value = "";
              }}
            />
          </label>
          <small className="muted">
            Up to 5 images, 2 MB each. Your agent can access these images in
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
