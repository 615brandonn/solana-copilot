import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase-types";
import { normalizeSupabaseUrl } from "@/lib/supabase-url";

const url = normalizeSupabaseUrl(import.meta.env.PUBLIC_SUPABASE_URL ?? "");
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key
  ? createClient<Database>(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
