// Coverage proves supplied non-placeholder source, not linguistic correctness.
// The Gemini audit and rendered acceptance remain separate evidence.
export function isPlaceholder(value) {
  return (Array.isArray(value) ? value : [value]).some(part =>
    typeof part === 'string' && /^[\x27\x22]?DEV:/i.test(part.trim()));
}
export function isTranslated(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts.length > 0 && parts.every(part => typeof part === 'string' && part.trim().length > 0)
    && !isPlaceholder(value);
}
