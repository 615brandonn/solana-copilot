// Some users paste the full PostgREST URL (e.g. ...supabase.co/rest/v1/).
// supabase-js appends /rest/v1/ itself, so we strip it here to avoid double paths.
export function normalizeSupabaseUrl(url: string): string {
  let trimmed = url.trim();
  // Remove trailing slash(es)
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  // Remove /rest/v1 if present
  if (trimmed.toLowerCase().endsWith("/rest/v1")) trimmed = trimmed.slice(0, -"/rest/v1".length);
  // Clean up any remaining trailing slash
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}
