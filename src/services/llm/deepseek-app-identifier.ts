import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { DiscoverySnapshot } from "../../domain/index.js";

const ProposedIdentitySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
});

export type AppIdentity = z.infer<typeof ProposedIdentitySchema>;

export type AppIdentifier = (snapshot: DiscoverySnapshot) => Promise<AppIdentity>;

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * Identifies the application under test from what discovery actually
 * observed (page titles, URLs, forms, buttons/links) — never from the raw
 * target URL alone. Backed by the same DeepSeek chat-completions API as
 * createDeepSeekPlanGenerator (see deepseek-plan-generator.ts): optional,
 * only ever constructed when DEEPSEEK_API_KEY is configured (see
 * cli/context.ts), and this is purely descriptive metadata (map name +
 * description) — it never proposes steps, selectors, or anything that
 * feeds execution, so there is no scope/policy surface for it to violate.
 */
export function createDeepSeekAppIdentifier(options: { apiKey: string; model?: string }): AppIdentifier {
  const chat = new ChatOpenAI({
    apiKey: options.apiKey,
    model: options.model ?? "deepseek-chat",
    temperature: 0,
    configuration: { baseURL: DEEPSEEK_BASE_URL },
  });
  const structured = chat.withStructuredOutput(ProposedIdentitySchema, { name: "identify_application" });

  return async (snapshot) => {
    const prompt = buildPrompt(snapshot);
    const result = (await structured.invoke(prompt)) as AppIdentity;
    return result;
  };
}

function buildPrompt(snapshot: DiscoverySnapshot): string {
  const pages = snapshot.pages.slice(0, 25).map((page) => ({
    url: page.url,
    title: page.title,
    forms: page.forms.map((form) => form.fields.map((field) => field.name).filter(Boolean)),
    buttons: page.buttons.map((button) => button.text).slice(0, 15),
    links: page.links.map((link) => link.text).slice(0, 15),
  }));

  return [
    "You are identifying what web application a QA crawler just discovered, from evidence only.",
    "Base your answer ONLY on the page titles, URLs, form fields, and button/link text below —",
    "never invent a product name or vendor that is not evidenced by this content.",
    `Target: ${snapshot.targetUrl}`,
    `Discovered pages:\n${JSON.stringify(pages, null, 2)}`,
    'Respond with a short application name (e.g. "Demo Shop", "Acme Admin Console") suitable as a',
    "test-map title, and a one-sentence description of what the application appears to let a user do.",
  ].join("\n\n");
}
