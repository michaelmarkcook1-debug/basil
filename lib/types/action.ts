export interface ActionItem {
  id: string;
  text: string;
  owner: string;
  ownerId?: string;
  dueDate?: string;
  status: "open" | "done" | "overdue";
  source: "meeting" | "slack" | "email" | "manual" | "chat";
  createdAt: string;
  updatedAt: string;
}

// No seeded content. Actions only appear when Michael adds them or when
// Basil captures one from real verified activity. An empty list is honest;
// a fabricated list is not.
export const SEED_ACTIONS: ActionItem[] = [];
