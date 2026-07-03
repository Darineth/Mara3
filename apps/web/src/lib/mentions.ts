/**
 * @-mention detection for channel messages. A mention is `@` followed by the
 * user's display name, case-insensitively, standing on its own: not glued to a
 * preceding word character (so `mail@host` never mentions "host") and not a
 * prefix of a longer word (so `@Rosalind` never mentions "Rosa"). Names may
 * contain spaces and punctuation — they're matched literally.
 */
export function mentionsUser(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])@${escaped}(?![\\w-])`, 'iu').test(text);
}
