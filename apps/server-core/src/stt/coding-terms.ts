// SPEC-REF:
//   apps/server-core/src/stt/terminology-context.ts (the only consumer: the
//     Soniox `context` builder, which appends this list after the user's terms)
//   apps/server-core/src/compose/app-category.ts (`appCategoryFor` → 'coding')
//   scripts/eval/speech-quality/README.md (card CTX-1 — how the size was chosen)
//
// Card CTX-1 — the DEFAULT recognition vocabulary for a dictation whose target
// PC has a code editor or terminal focused.
//
// WHY THIS EXISTS. Soniox recognises developer jargon far better when it is told
// the words in advance (EVAL-1, 2026-10-13: English jargon WER 7.4% → 3.7%,
// exact-term recall 80% → 95% with a term list). Until this file the only list
// was the user's own scenario-card terms, and the production default is a user
// who never filled one — so the default user got no context at all.
//
// WHAT THIS IS NOT. Not user-visible copy (it is never rendered; it is data sent
// to the recognizer, in English because the vendor's vocabulary is English), not
// a dictionary (no aliases — aliases are wrong spellings and must never be fed
// to the recognizer, see buildSonioxContext), and not a replacement table.
//
// 🔴 ORDER IS PRIORITY. The list is sliced from the front
// (`CODING_DEFAULT_TERMS.slice(0, n)`) both by the product (under the shared
// size cap, after the user's own terms) and by the eval harness when it measures
// sizes. Put what developers say most and what is misheard most first: AI coding
// tools, languages, the big frameworks and clouds; the long tail goes last.
// Moving a term changes what a capped session receives.
//
// ⚠️ Some entries are also ordinary English words ("prompt", "agent", "Render",
// "Express", "Swift"). They are listed on purpose: in a code editor or terminal
// they are usually the technical term. Every listed term competes with the
// ordinary words that sound like it, so the bar for adding one is that the
// technical sense is the likely one in this setting. A few are written in an
// unambiguous form instead ("Golang", not "Go"), and some are left out
// entirely ("make").

import type { AppCategory } from '../compose/app-category';

export const CODING_DEFAULT_TERMS: readonly string[] = [
  // ── AI coding tools and model vocabulary ───────────────────────────────────
  'Claude Code', 'Claude', 'Anthropic', 'Cursor', 'GitHub Copilot', 'Copilot',
  'ChatGPT', 'OpenAI', 'Codex', 'Gemini', 'Ollama', 'LangChain', 'LLM', 'RAG',
  'embeddings', 'MCP', 'prompt',
  // ── languages, runtimes, package managers ─────────────────────────────────
  'TypeScript', 'JavaScript', 'Python', 'Rust', 'Golang', 'Kotlin', 'Swift',
  'Node.js', 'npm', 'pnpm', 'Yarn',
  // ── frameworks and build tools ────────────────────────────────────────────
  'React', 'Next.js', 'Vue', 'Vite', 'Tailwind', 'Flutter',
  // ── source control and CI ─────────────────────────────────────────────────
  'GitHub', 'GitHub Actions', 'Git', 'pull request',
  // ── cloud, containers, data ───────────────────────────────────────────────
  'Docker', 'Kubernetes', 'kubectl', 'AWS', 'Vercel', 'Cloudflare', 'Supabase',
  'PostgreSQL', 'Postgres', 'Redis', 'SQLite', 'MongoDB',
  // ── protocols and formats ─────────────────────────────────────────────────
  'API', 'JSON', 'YAML', 'OAuth', 'WebSocket', 'GraphQL', 'REST', 'gRPC',
  // ── AI tools, second tier ─────────────────────────────────────────────────
  'Windsurf', 'Cline', 'Aider', 'Hugging Face', 'LlamaIndex', 'llama.cpp',
  'LM Studio', 'vLLM', 'Mistral', 'DeepSeek', 'Llama', 'Qwen', 'Perplexity',
  'fine-tuning', 'vector database', 'pgvector', 'Pinecone', 'tokenizer',
  'system prompt', 'agent',
  // ── languages, second tier ────────────────────────────────────────────────
  'Java', 'C#', 'C++', '.NET', 'PHP', 'Ruby', 'Scala', 'Elixir', 'Dart',
  'Bash', 'PowerShell', 'SQL', 'Deno', 'Bun', 'WebAssembly',
  // ── frameworks and libraries, second tier ─────────────────────────────────
  'Svelte', 'SvelteKit', 'Angular', 'Nuxt', 'Remix', 'Astro', 'Express',
  'NestJS', 'FastAPI', 'Django', 'Flask', 'Spring Boot', 'Rails', 'Laravel',
  'Tauri', 'Electron', 'React Native', 'Expo', 'Redux', 'Zustand', 'Prisma',
  'Drizzle', 'Zod', 'tRPC', 'shadcn', 'webpack', 'esbuild', 'Turborepo',
  'Vitest', 'Jest', 'Playwright', 'Cypress', 'pytest', 'ESLint', 'Prettier',
  'useEffect', 'useState', 'npx', 'pip', 'Cargo',
  // ── cloud and infrastructure, second tier ─────────────────────────────────
  'Azure', 'GCP', 'Google Cloud', 'Lambda', 'S3', 'EC2', 'Terraform', 'Helm',
  'Nginx', 'Netlify', 'Firebase', 'Heroku', 'Fly.io', 'Render', 'DigitalOcean',
  'Stripe', 'Sentry',
];

/** Card CTX-1 — total terms (user + default) the coding default may fill up
 *  to; equal to the list length, so a user with no dictionary gets all of it.
 *
 *  MEASURED, 2026-10-13 (scripts/eval/speech-quality, Soniox stt-rt-v5, TTS
 *  audio, 47 jargon/name items + 56 non-jargon controls; full table in the
 *  card CTX-1 report). Errors on the jargon items vs no context:
 *    en    24 edits → 50 terms 15 · 150 terms 17 · 300 terms 18
 *    mixed  6 edits → 50 terms  7 · 150 terms  3 · 300 terms  3
 *  50 vs 150 vs 300 on English is within run-to-run noise; 50 did not help
 *  mixed Chinese/English, 300 bought nothing over 150. Controls at 150: en
 *  16 → 11 edits, zh 2 → 2, mixed 0 → 0 — no harm seen. The sizes were the
 *  first 50/150/300 entries of the longer list in this file's first commit;
 *  everything past 150 has been removed since (a term past the cap is never
 *  sent, so keeping it would be dead data). */
export const CODING_DEFAULT_TERMS_CAP = 150;

/** NR-245: the category default list, or none. The ONE gate both the
 *  recognizer's context (stt/engine-factory.ts sonioxDefaultTermsFor) and the
 *  polish guard's known terms (stt-polish-guard.ts) read: only a code editor
 *  or terminal gets the coding vocabulary. */
export function categoryDefaultTerms(category: AppCategory | undefined): readonly string[] {
  return category === 'coding' ? CODING_DEFAULT_TERMS : [];
}
