# Voca Backend - Cloudflare Workers

High-scale, cost-effective AI proxy for Chrome Extension. Protects your Groq API Key and keeps Supabase costs at $0.

## Architecture Overview - Three Tier System

```
┌─────────────────┐     ┌─────────────────────────────┐     ┌─────────────┐
│ Chrome Extension│────▶│ Cloudflare Worker           │────▶│ Groq API    │
│ (Supabase Auth) │     │ - JWT Verification (jose)   │     │ (AI calls)  │
└─────────────────┘     │ - KV Quota Check            │     └─────────────┘
                        │ - Plan: free/pro/premium    │
                        │ - API Proxy                 │
                        └──────────────┬──────────────┘
                                       │
                                       ▼ (every 20 msgs, async)
                        ┌─────────────────────────────┐
                        │ Supabase (Batch Sync)
                        │ - Auth                        │
                        │ - "user from voca" table      │
                        │   with usage_count, plan      │
                        └─────────────────────────────┘
```

## Setup Steps

### 1. Install Dependencies

```bash
cd voca-backend
npm install
```

### 2. Set Secrets (Encrypted)

⚠️ **SECURITY WARNING**: Never commit these secrets to version control or expose them in client-side code!

```bash
# Supabase: Dashboard → Project Settings → API → JWT Secret
wrangler secret put SUPABASE_JWT_SECRET

# Supabase: Dashboard → Project Settings → API → Project URL
wrangler secret put SUPABASE_URL

# Supabase: Dashboard → Project Settings → API → anon/public key
wrangler secret put SUPABASE_ANON_KEY

# ⚠️ CRITICAL: Service Role Key has admin privileges - NEVER expose this to client!
# Supabase: Dashboard → Project Settings → API → service_role key (under JWT Settings)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Groq: https://console.groq.com/keys
wrangler secret put GROQ_API_KEY
```

### 3. Deploy

```bash
npm run deploy
```

Get your worker URL: `https://voca-backend.YOUR_SUBDOMAIN.workers.dev`

Update `background.js` in the Chrome Extension:
```javascript
const WORKER_URL = 'https://voca-backend.YOUR_SUBDOMAIN.workers.dev';
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/ai/process` | POST | AI requests (grammar, improve, translate, auto-reply) |
| `/v1/usage` | POST | Check current usage |
| `/v1/sync` | POST | Manual sync to Supabase |

## How It Works

1. **JWT Verification**: Worker verifies Supabase JWT using `jose` library (offline, no DB call)
2. **Plan Check**: Extracts `plan` from `payload.app_metadata` (free/pro/premium)
3. **KV Quota Check**: 
   - Free: 200 messages + 80 translations
   - Pro: 2,300 messages + 1,500 translations
   - Premium: 5,000 messages + 4,000 translations
4. **Groq Proxy**: Forwards valid requests to Groq API with injected key
5. **Batch Sync**: Every 20 messages, async sync to Supabase (keeps costs at $0)

## Three-Tier Quota System

| Tier | Price | Messages | Translations | Total |
|------|-------|----------|--------------|-------|
| **Free** | $0 | 200 | 80 | 280 |
| **Pro** | $8 | 2,300 | 1,500 | 3,800 |
| **Premium** | $12 | 5,000 | 4,000 | 9,000 |

**How it works:**
1. JWT `app_metadata.plan` determines user's tier (free/pro/premium)
2. KV stores separate counters for `messagesUsed` and `translationsUsed`
3. Different limits applied based on action type (grammar/improve vs translate/auto-reply)
4. Batch sync to Supabase every 20 total requests

**KV Key Format**: `usage:{user_uuid}:{YYYY-MM}`

## Cost Benefits (10k users at Free tier limits)

| Approach | Monthly Cost |
|----------|-------------|
| Supabase Edge Functions | $0 (but hits limits quickly) |
| **Cloudflare Workers** | **$0** (KV + Worker requests free) |
| Groq API (10k × 200 msgs) | ~$10,000 |
| **Total with Workers** | **~$10,000** (vs $50,000+ with direct Supabase) |

## Secrets Required

Set via `wrangler secret put`:
- `GROQ_API_KEY` - From https://console.groq.com/keys
- `SUPABASE_JWT_SECRET` - From Supabase Dashboard → Settings → API
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Anon/public key from Supabase Dashboard
- `SUPABASE_SERVICE_ROLE_KEY` - **⚠️ Service role key (admin access) - NEVER expose to client**

## Environment Variables

`wrangler.toml`:
- `BATCH_SYNC_THRESHOLD`: Sync every N messages (default: 20)
- `GROQ_MODEL`: Model (default: llama-3.1-8b-instant)
