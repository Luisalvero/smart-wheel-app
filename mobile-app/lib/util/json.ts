/** Parses a JSON array of strings stored in SQLite; anything else → []. */
export const parseList = (json: string | undefined | null): string[] => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
