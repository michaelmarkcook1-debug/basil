export function getItems<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function setItems<T>(key: string, items: T[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(items));
}

export function addItem<T extends { id: string }>(key: string, item: T): void {
  const items = getItems<T>(key);
  items.unshift(item);
  setItems(key, items);
}

export function updateItem<T extends { id: string }>(
  key: string,
  id: string,
  updates: Partial<T>
): void {
  const items = getItems<T>(key);
  const idx = items.findIndex((item) => item.id === id);
  if (idx !== -1) {
    items[idx] = { ...items[idx], ...updates };
    setItems(key, items);
  }
}

export function deleteItem(key: string, id: string): void {
  const items = getItems<{ id: string }>(key);
  setItems(
    key,
    items.filter((item) => item.id !== id)
  );
}

/**
 * Initialize a localStorage key with seed data if the stored version doesn't match.
 * Bumping SEED_VERSION forces a reseed on next page load.
 */
export function initWithSeeds<T>(key: string, seeds: T[], seedVersion: number): T[] {
  if (typeof window === "undefined") return seeds;

  const versionKey = `${key}-seed-version`;
  const storedVersion = localStorage.getItem(versionKey);

  if (storedVersion === String(seedVersion)) {
    // Seeds match — return stored data
    const items = getItems<T>(key);
    return items.length > 0 ? items : seeds;
  }

  // Seeds changed — reseed
  localStorage.setItem(versionKey, String(seedVersion));
  setItems(key, seeds);
  return seeds;
}
