import type { WhazingPixType } from "./client";

// Per-agent PIX config, read from `agent.settings.whazingPix`. Backs the `send_pix_button` and
// `request_payment` native tools. pixKey/pixName/pixType are operator-configured here (not
// model-supplied tool arguments): the model choosing/typing a payment key is a real-money footgun
// (customer pays the wrong recipient), so the schema for those tools never exposes these fields —
// they always come from this config.
export interface WhazingPixConfig {
  pixKey: string;
  pixName: string;
  pixType: WhazingPixType;
}

const PIX_TYPES: WhazingPixType[] = ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"];

export function readWhazingPixConfig(settings: unknown): WhazingPixConfig | null {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).whazingPix
      : undefined;
  if (!s || typeof s !== "object") return null;
  const bag = s as Record<string, unknown>;
  const pixKey = typeof bag.pixKey === "string" ? bag.pixKey.trim() : "";
  const pixName = typeof bag.pixName === "string" ? bag.pixName.trim() : "";
  const pixType = typeof bag.pixType === "string" ? bag.pixType.toUpperCase() : "";
  if (!pixKey || !pixName || !PIX_TYPES.includes(pixType as WhazingPixType)) return null;
  return { pixKey, pixName, pixType: pixType as WhazingPixType };
}
