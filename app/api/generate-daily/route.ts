import { NextResponse } from "next/server";
import OpenAI from "openai";
import { AGENTS } from "@/lib/agents";
import { insertArticle } from "@/lib/articles";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function GET() {
  const pubDate = new Date().toISOString().slice(0, 10);

  for (const agent of AGENTS) {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: "Generate AI-related article in JSON." },
      ],
      response_format: { type: "json_object" },
    });

    const article = JSON.parse(res.choices[0].message.content!);

    await insertArticle({
      ...article,
      author: agent.name,
      department: agent.department,
      published_at: pubDate,
      metadata: { agentId: agent.id },
    });
  }

  return NextResponse.json({ status: "ok" });
}
