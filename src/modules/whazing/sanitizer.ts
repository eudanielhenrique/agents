export interface SanitizationResult {
  ok: boolean;
  cleanReply: string;
  reason?: string;
}

const REJECT_PATTERNS = [
  /\bskipped\s+reply\b/i,
  /\bno_reply\b/i,
  /\b\[no_reply\]\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bas\s+a\s+language\s+model\b/i,
  /\bi\s+cannot\s+fulfill\s+this\s+request\b/i,
  /\bi\s+apologize,\s+but\s+i\b/i,
  /\btoken_limit_reached\b/i,
  /^\s*\?>/,
  /<\?/,
];

/**
 * Sanitizes and validates an outgoing assistant message for WhatsApp.
 * Blocks known reasoning leakages, empty replies, and hallucinations before they reach the user.
 */
export function sanitizeWhazingReply(
  rawReply: string | null | undefined,
): SanitizationResult {
  if (rawReply == null) {
    return { ok: false, cleanReply: "", reason: "null_or_undefined_reply" };
  }

  let text = rawReply.trim();
  if (!text) {
    return { ok: false, cleanReply: "", reason: "blank_reply" };
  }

  // Check known hallucination/leakage patterns
  for (const pattern of REJECT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        cleanReply: "",
        reason: `hallucination_pattern_${pattern.source}`,
      };
    }
  }

  // Reject replies without sufficient alphanumeric content (e.g. only "...??" or "---")
  const alphanumericCount = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alphanumericCount < 2) {
    return {
      ok: false,
      cleanReply: "",
      reason: "insufficient_alphanumeric_content",
    };
  }

  // Normalize excessive blank lines (max 2 consecutive newlines)
  text = text.replace(/\n{3,}/g, "\n\n");

  return { ok: true, cleanReply: text };
}
