import { NextResponse } from "next/server";
import {
  listDecisions,
  createDecision,
  bulkImport,
} from "@/lib/decisions/store";
import type { Decision } from "@/lib/types/decision";

export async function GET() {
  const decisions = await listDecisions();
  return NextResponse.json({ decisions });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (Array.isArray(body?.import)) {
      const added = await bulkImport(body.import as Decision[]);
      return NextResponse.json({ imported: added }, { status: 201 });
    }

    const { text, decidedBy, decidedById, date, context } = body as {
      text?: string;
      decidedBy?: string;
      decidedById?: string;
      date?: string;
      context?: string;
    };

    if (!text || !text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    if (!decidedBy || !decidedBy.trim()) {
      return NextResponse.json(
        { error: "decidedBy is required" },
        { status: 400 }
      );
    }

    const decision = await createDecision({
      text,
      decidedBy,
      decidedById,
      date,
      context,
    });
    return NextResponse.json({ decision }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
