import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Secure configuration - stored server-side only
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const MAX_TEXT_LENGTH = 1000;
const MIN_TEXT_LENGTH = 5;
const REQUEST_TIMEOUT_MS = 25000;

// Rate limiting config (per user per minute)
const RATE_LIMIT_REQUESTS = 30; // 30 requests per minute per user
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

// Allowed tones
const ALLOWED_TONES = new Set([
  "Professional", "Formal", "Friendly", "Casual", "Confident", "Concise",
  "Business Collaboration", "Service Provider"
]);
const DEFAULT_TONE = "Professional";

// Prompt templates
const RULES =
  "RULES:\n" +
  "1. Only rewrite the text. Do NOT converse, apologize, or answer questions.\n" +
  "2. Preserve exact meaning, pronouns (I/you/he/she), and sentence structure (keep questions as questions).\n" +
  "3. Keep phrasing natural and direct. Do not sound robotic.\n" +
  "4. Output ONLY the final text.";

const AUTO_REPLY_RULES =
  "RULES:\n" +
  "1. You are writing a reply on behalf of \"Me\" (the user). Respond to what \"Them\" (the other person) said.\n" +
  "2. Messages labeled \"Me\" are what the user previously said. Messages labeled \"Them\" or \"Chat\" are from the other person.\n" +
  "3. Write a short, natural reply that continues the conversation from \"Me\"'s perspective.\n" +
  "4. Match the tone and formality of the conversation.\n" +
  "5. Keep it concise — 1-3 sentences max.\n" +
  "6. Do NOT add greetings unless appropriate.\n" +
  "7. Output ONLY the reply text, nothing else.";

// In-memory rate limit store (resets on function restart)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Get GROQ API key from environment (stored securely in Supabase)
function getGroqApiKey(): string {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) {
    throw new Error("GROQ_API_KEY not configured");
  }
  return key;
}

// Check rate limit for user
function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitStore.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    // Reset or new window
    rateLimitStore.set(userId, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS
    });
    return true;
  }

  if (userLimit.count >= RATE_LIMIT_REQUESTS) {
    return false;
  }

  userLimit.count++;
  return true;
}

// Validate and sanitize text
function validateText(text: unknown): { valid: boolean; error?: string; sanitized?: string } {
  if (typeof text !== "string") {
    return { valid: false, error: "Text must be a string" };
  }

  const trimmed = text.trim();

  if (trimmed.length < MIN_TEXT_LENGTH) {
    return { valid: false, error: `Text too short (min ${MIN_TEXT_LENGTH} chars)` };
  }

  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { valid: false, error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` };
  }

  // Basic sanitization - remove null bytes and control chars except newlines/tabs
  const sanitized = trimmed.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");

  return { valid: true, sanitized };
}

// Build system prompt
function buildPrompt(mode: string, targetLang?: string, tone?: string): string | null {
  const speakingLang = ""; // Could be passed from client if needed

  switch (mode) {
    case "grammar":
      return `Fix grammar/spelling only. Do not change tone.${speakingLang ? " Lang: " + speakingLang : ""}\n${RULES}`;
    case "improve":
      const validTone = ALLOWED_TONES.has(tone || "") ? tone : DEFAULT_TONE;
      return `Rewrite text to sound ${validTone}.${speakingLang ? " Lang: " + speakingLang : ""}\n${RULES}`;
    case "translate":
      if (!targetLang) return null;
      return `Translate to ${targetLang}. Do NOT add the language name as a prefix.\n${RULES}`;
    case "pro-translate":
      if (!targetLang) return null;
      return `Rewrite to a professional tone and translate to ${targetLang}. Do NOT add the language name as a prefix.\n${RULES}`;
    default:
      return null;
  }
}

// Build auto-reply prompt
function buildAutoReplyPrompt(tone: string, speakingLang?: string): string {
  const toneStr = ALLOWED_TONES.has(tone) ? tone : DEFAULT_TONE;
  return `You are writing a reply in a chat conversation. Reply in a ${toneStr} tone.${speakingLang ? ` Write in ${speakingLang}.` : ""}\n${AUTO_REPLY_RULES}`;
}

// Call Groq API
async function callGroq(systemPrompt: string, userText: string): Promise<string> {
  const apiKey = getGroqApiKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Text: ${userText}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Main handler
Deno.serve(async (req: Request) => {
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client to validate JWT
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_ANON_KEY") || "",
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    // Validate user
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check rate limit
    if (!checkRateLimit(user.id)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { mode, text, targetLang, tone, speakingLang, messages } = body;

    // Validate request type
    if (!mode || typeof mode !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid mode" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle auto-reply mode
    if (mode === "auto-reply") {
      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(
          JSON.stringify({ error: "No messages provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const conversationBlock = messages
        .map((m: { sender: string; text: string }) => `${m.sender}: ${m.text}`)
        .join("\n");

      const systemPrompt = buildAutoReplyPrompt(tone || DEFAULT_TONE, speakingLang);
      const userPrompt = `Conversation:\n${conversationBlock}\n\nWrite a reply:`;

      const result = await callGroq(systemPrompt, userPrompt);

      return new Response(
        JSON.stringify({ result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle text processing modes (grammar, improve, translate, pro-translate)
    const textValidation = validateText(text);
    if (!textValidation.valid) {
      return new Response(
        JSON.stringify({ error: textValidation.error }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const systemPrompt = buildPrompt(mode, targetLang, tone);
    if (!systemPrompt) {
      return new Response(
        JSON.stringify({ error: `Unknown mode: ${mode}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await callGroq(systemPrompt, textValidation.sanitized!);

    return new Response(
      JSON.stringify({ result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Edge function error:", err);

    const errorMessage = err instanceof Error ? err.message : "Internal server error";
    const isTimeout = errorMessage.includes("AbortError") || errorMessage.includes("timeout");

    return new Response(
      JSON.stringify({
        error: isTimeout ? "Request timed out" : errorMessage
      }),
      {
        status: isTimeout ? 504 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
