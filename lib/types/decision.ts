export interface Decision {
  id: string;
  text: string;
  decidedBy: string;
  decidedById?: string;
  date: string;
  context: string;
  status: "active" | "superseded";
  createdAt: string;
}

// No seeded content. Decisions only appear when Michael logs them or when
// Basil captures one from real verified activity. An empty list is honest;
// a fabricated list is not.
export const SEED_DECISIONS: Decision[] = [];
