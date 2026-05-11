import { createAction } from "@/lib/actions/store";
import { createDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";
import { updateLedgerItem } from "./store";
import type { LedgerItem, LedgerConvertRequest } from "./types";

export interface ConvertResult {
  ok: boolean;
  ledgerItemId: string;
  targetType: string;
  targetId: string;
  error?: string;
}

export async function convertLedgerItem(
  username: string,
  ledgerItem: LedgerItem,
  request: LedgerConvertRequest
): Promise<ConvertResult> {
  const title = request.title ?? ledgerItem.title;
  const summary = request.summary ?? ledgerItem.summary ?? "";
  const sourceRef = ledgerItem.sourceRef ?? `ledger:${ledgerItem.id}`;

  try {
    let targetId: string;

    switch (request.targetType) {
      case "action": {
        const action = await createAction(username, {
          text: summary ? `${title}: ${summary}` : title,
          priority:
            ledgerItem.urgency === "critical" || ledgerItem.urgency === "high"
              ? "high"
              : ledgerItem.urgency === "low"
              ? "low"
              : "medium",
          dueDate: request.dueAt
            ? request.dueAt.slice(0, 10)
            : ledgerItem.dueAt
            ? ledgerItem.dueAt.slice(0, 10)
            : undefined,
          source: "manual",
          sourceRef,
        });
        targetId = action.id;
        break;
      }
      case "decision": {
        const text = summary ? `${title}: ${summary}` : title;
        const decision = await createDecision(username, {
          text,
          title,
          context: summary || title,
          decidedBy: ledgerItem.relatedPeople[0] ?? username,
          stakeholders: ledgerItem.relatedPeople.slice(1),
          source: "manual",
          sourceRef,
        });
        targetId = decision.id;
        break;
      }
      case "memory": {
        const content = summary ? `${title}: ${summary}` : title;
        const memory = await createMemory(username, {
          kind: "fact",
          content,
          source: "manual",
          sourceRef,
        });
        targetId = memory.id;
        break;
      }
      default:
        return {
          ok: false,
          ledgerItemId: ledgerItem.id,
          targetType: request.targetType,
          targetId: "",
          error: `Unknown target type: ${request.targetType}`,
        };
    }

    // Mark the ledger item as converted
    await updateLedgerItem(username, ledgerItem.id, {
      convertedTo: { type: request.targetType, id: targetId },
      status: "done",
    });

    return {
      ok: true,
      ledgerItemId: ledgerItem.id,
      targetType: request.targetType,
      targetId,
    };
  } catch (err) {
    return {
      ok: false,
      ledgerItemId: ledgerItem.id,
      targetType: request.targetType,
      targetId: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
