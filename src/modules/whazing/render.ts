import { cleanTranscription } from "@/modules/chatwoot/render";
import type { NormalizedWhazingEvent } from "./types";

// Renders a NormalizedWhazingEvent to a text representation for the LLM.
// Mirrors the renderInboundMessage pattern from chatwoot/render.ts but adapted to the
// Whazing shape: attachments are inline on the message, not fetched from Chatwoot.
// Returns null when the event carries no content (no body and no attachments).
export function renderWhazingMessage(
  event: NormalizedWhazingEvent,
  transcription?: string | null,
): string | null {
  const msg = event.message;
  if (!msg) return null;

  const parts: string[] = [];

  const body = msg.body?.trim();
  if (body) parts.push(body);

  for (const att of msg.attachments) {
    const mt = (att.mediaType ?? "").toLowerCase();
    if (mt === "audio" || mt === "voice" || mt === "ptt") {
      const tr = cleanTranscription(transcription ?? "");
      parts.push(
        tr
          ? `<mensagem-de-audio>${tr}</mensagem-de-audio>`
          : "<mensagem de áudio não audível; peça que o cliente reenvie por texto>",
      );
    } else if (mt === "image" || mt === "sticker") {
      parts.push("<mensagem-de-imagem />");
    } else if (mt === "video") {
      parts.push("<mensagem-de-video />");
    } else {
      const name = att.fileName?.trim();
      parts.push(
        name
          ? `<mensagem-de-arquivo nome="${name}" />`
          : "<mensagem-de-arquivo />",
      );
    }
  }

  const rendered = parts.join("\n").trim();
  return rendered || null;
}
