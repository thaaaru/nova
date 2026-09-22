/**
 * Everything an application under test renders is hostile, untrusted
 * input. This module is the only place page/document text is turned into
 * something a model is allowed to see: markup, scripts, styles, comments,
 * and hidden text are removed upstream by the evidence builder, and
 * anything that still looks secret-bearing is dropped here rather than
 * redacted in place — a partially-masked token is still a leak of its
 * shape, and identification never needs one.
 */

/**
 * Shapes that indicate credential material. Deliberately broad: a false
 * positive costs one dropped page heading, a false negative sends a live
 * token across an API boundary.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA|AKID)[0-9A-Z]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/,
  /\bsk-[0-9A-Za-z_-]{16,}\b/,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{5,}\b/,
  /\b(?:password|passwd|secret|api[_-]?key|token|authorization|bearer|session[_-]?id|csrf)\b\s*[:=]\s*\S+/i,
  /\b[0-9]{13,19}\b(?=[^0-9]|$)/,
];

/** True when a candidate string carries anything shaped like a credential, token, or card number. */
export function looksSecretBearing(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Collapses whitespace, strips control characters and zero-width
 * codepoints (a common way to smuggle invisible instructions past a
 * human reviewer), and removes any residual angle-bracket markup.
 */
export function normalizeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Instruction-shaped text arriving *from the model* — the output side of
 * the injection defence. A successful identification describes an
 * application; it never issues directives, claims new permissions, or
 * references tools. Any hit here fails validation rather than being
 * cleaned up, because a model that started taking orders from page
 * content cannot be trusted to have grounded the rest of its answer.
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any )?(?:previous|prior|above) instructions?\b/i,
  /\bdisregard (?:all |any )?(?:previous|prior|above)\b/i,
  /\byou (?:are|act) (?:now )?(?:as )?an? (?:admin|administrator|root|developer mode)\b/i,
  /\b(?:system|developer) prompt\b/i,
  /\b(?:execute|run|invoke|call) (?:the )?(?:following )?(?:command|shell|script|tool|function)\b/i,
  /\bcurl\s+https?:\/\//i,
  /\b(?:approve|authorize) (?:this|the) (?:plan|test|run)\b/i,
  /\bgrant (?:me |yourself )?(?:access|permission)\b/i,
];

/** Returns the instruction-shaped fragments found in model output; empty means clean. */
export function findInstructionLikeText(values: string[]): string[] {
  const hits: string[] = [];
  for (const value of values) {
    for (const pattern of INSTRUCTION_PATTERNS) {
      const match = pattern.exec(value);
      if (match) {
        hits.push(match[0]);
        break;
      }
    }
  }
  return hits;
}
