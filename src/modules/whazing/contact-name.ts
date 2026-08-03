// Heuristic: is this WhatsApp profile name usable as a proper human name to greet the customer
// with (so the agent can skip asking "qual seu nome?"), or is it noise the agent should still ask
// about? WhatsApp profile names range from real names ("Fernanda", "Susa Corradi") to
// auto-generated handles/usernames ("orivaldoalvesvieira" — no space, no capitalization, reads
// like a concatenated slug) to pure emoji/symbols ("✨"). Deterministic on purpose: classifying
// this via an LLM call would add a network round-trip to every new conversation for a low-stakes
// greeting decision.
export function looksLikePersonName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const name = raw.trim();
  if (!name) return false;

  const letters = name.match(/\p{L}/gu) ?? [];
  // Rejects names that are mostly/only emoji, digits, or symbols (e.g. "✨").
  if (letters.length < 2) return false;

  const nonSpace = name.replace(/\s/g, "");
  if (letters.length < nonSpace.length * 0.6) return false;

  // A long, single, all-lowercase, no-space token reads as a WhatsApp handle rather than a typed
  // name (e.g. "orivaldoalvesvieira") — real single-word names are short first names or already
  // capitalized. Multi-word names and anything with a capital letter skip this check.
  const hasSpace = /\s/.test(name);
  const hasUpper = /\p{Lu}/u.test(name);
  if (!hasSpace && !hasUpper && name.length > 12) return false;

  return true;
}
