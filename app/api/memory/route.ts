import { NextResponse } from "next/server";
import { listMemories, createMemory } from "@/lib/memory/store";
import { getSessionUser } from "@/lib/auth";
import type { MemoryKind } from "@/lib/memory/types";

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const memories = await listMemories(username);
  return NextResponse.json({ memories });
}

export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await req.json();
    const { kind, content, entity, source } = body as {
      kind?: MemoryKind;
      content?: string;
      entity?: string;
      source?: "chat" | "manual" | "inferred";
    };

    if (!kind || !content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "kind and content are required" },
        { status: 400 }
      );
    }

    const allowed: MemoryKind[] = ["fact", "preference", "person", "context"];
    if (!allowed.includes(kind)) {
      return NextResponse.json(
        { error: `kind must be one of ${allowed.join(", ")}` },
        { status: 400 }
      );
    }

    const memory = await createMemory(username, {
      kind,
      content,
      entity,
      source: source ?? "manual",
    });
    return NextResponse.json({ memory }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
