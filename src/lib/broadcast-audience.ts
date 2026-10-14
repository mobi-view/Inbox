import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact } from '@/types';

/**
 * PostgREST puts `.in(...)` values in the request URL, so a large list makes
 * the URL too long and the API answers "Bad Request". Keep slices small
 * (a UUID is ~39 chars in the URL, so 100 ids ≈ 4 KB).
 */
export const IN_CHUNK = 100;

/** Supabase returns at most 1000 rows per request unless paged. */
const PAGE_SIZE = 1000;

/** Contact ids that carry ANY of the given tags (de-duplicated, fully paged). */
export async function fetchContactIdsForTags(
  supabase: SupabaseClient,
  tagIds: string[],
): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('contact_id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch contact tags: ${error.message}`);
    for (const row of data ?? []) ids.add(row.contact_id);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return [...ids];
}

/** Full contact rows for a list of ids, fetched in URL-safe chunks. */
export async function fetchContactsByIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Contact[]> {
  const out: Contact[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    out.push(...((data ?? []) as Contact[]));
  }
  return out;
}

/** Every contact in the account (fully paged). */
export async function fetchAllContacts(
  supabase: SupabaseClient,
): Promise<Contact[]> {
  const out: Contact[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    out.push(...((data ?? []) as Contact[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}
