const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  // Fail loudly at startup rather than with a confusing error on the first request.
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. " +
    "Set them in your Vercel project settings (and in a local .env for `npm run dev`)."
  );
}

// Service-role key — this bypasses Row Level Security and must NEVER be sent to the
// browser. It only ever lives here, in server-side code (api/index.js), never in
// public/app.js or any response body.
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = { supabase, STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || "documents" };
