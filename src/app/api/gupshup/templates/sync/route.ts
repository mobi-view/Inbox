import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

/**
 * Sync approved WhatsApp templates from Gupshup → local
 * message_templates table.
 *
 * Mirrors /api/whatsapp/templates/sync (the Meta version): same
 * upsert-by-(account_id, name, language) key, same normalizeStatus
 * mapping. The one Gupshup-specific piece is `gupshup_template_id`,
 * which is what send-message.ts / broadcast/route.ts need to fire a
 * template through Gupshup's API — Gupshup identifies templates by
 * this UUID, not by name+language the way Meta does.
 */

interface GupshupTemplate {
  id: string
  elementName: string
  languageCode: string
  status: string
  category?: string
  data?: string
  containerMeta?: string
  /** IMAGE | VIDEO | DOCUMENT | TEXT — tells us if there's a media header at all. */
  templateType?: string
}

function normalizeCategory(
  raw: string | undefined,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = (raw ?? '').toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeHeaderType(
  raw: string | undefined,
): 'text' | 'image' | 'video' | 'document' | null {
  const upper = (raw ?? '').toUpperCase()
  if (upper === 'IMAGE') return 'image'
  if (upper === 'VIDEO') return 'video'
  if (upper === 'DOCUMENT') return 'document'
  if (upper === 'TEXT') return 'text'
  return null
}

/**
 * Best-effort extraction of a reusable header media URL from
 * containerMeta. NOT guaranteed: Gupshup's template list API is only
 * confirmed to echo back the *example* media used at submission time
 * for review, under an inconsistent/undocumented set of possible key
 * names across template versions — WhatsApp templates generally
 * expect the real header media to be supplied fresh at send time
 * rather than reused automatically. Returns null (not a throw) when
 * nothing matches — the caller treats that as "needs manual entry",
 * not an error.
 */
function extractHeaderMediaUrl(containerMeta: string | undefined): string | null {
  if (!containerMeta) return null
  try {
    const meta = JSON.parse(containerMeta) as Record<string, unknown>
    const candidate =
      (meta.exampleMedia as string | undefined) ||
      (meta.mediaUrl as string | undefined) ||
      (meta.sampleMedia as string | undefined) ||
      (meta.exampleHeaderMedia as string | undefined)
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    return null
  }
}

export async function POST() {
  try {
    // Same tenancy rule as the Meta sync route: rewriting the
    // account-wide template catalog is settings-class data, so
    // 'admin' is required (matches message_templates RLS, migration 017).
    const { supabase, accountId, userId } = await requireRole('admin')

    const { data: config, error: configError } = await supabase
      .from('gupshup_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'connected')
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'Gupshup not configured. Connect your Gupshup account in Settings first.',
        },
        { status: 400 },
      )
    }

    if (!config.app_id) {
      return NextResponse.json(
        {
          error:
            'Gupshup App ID missing. Add app_id to your gupshup_config row (Dashboard > API Keys) before syncing.',
        },
        { status: 400 },
      )
    }

    let apiKey: string
    try {
      apiKey = decrypt(config.api_key)
    } catch (err) {
      console.error('[gupshup templates sync] api_key decryption failed:', err)
      return NextResponse.json(
        {
          error:
            'The stored Gupshup API key cannot be decrypted with the current ENCRYPTION_KEY. Reconnect Gupshup in Settings.',
        },
        { status: 500 },
      )
    }

    const gsRes = await fetch(
      `https://api.gupshup.io/wa/app/${config.app_id}/template`,
      { headers: { apikey: apiKey } },
    )

    if (!gsRes.ok) {
      const errText = await gsRes.text()
      console.error('[gupshup templates sync] Gupshup API error:', gsRes.status, errText)
      return NextResponse.json(
        { error: `Gupshup API error (${gsRes.status}): ${errText}` },
        { status: 502 },
      )
    }

    const gsBody: { templates?: GupshupTemplate[] } = await gsRes.json()
    const templates = gsBody.templates ?? []

    let inserted = 0
    let updated = 0
    let skippedNotApproved = 0
    let needsHeaderMedia = 0
    const errors: { name: string; language: string; message: string }[] = []

    for (const t of templates) {
      // Only approved templates are sendable — keep unapproved ones
      // out of the local catalog entirely rather than showing a
      // broadcastable-looking row that will fail at send time.
      if ((t.status ?? '').toUpperCase() !== 'APPROVED') {
        skippedNotApproved++
        continue
      }

      const headerType = normalizeHeaderType(t.templateType)
      const headerMediaUrl =
        headerType && headerType !== 'text'
          ? extractHeaderMediaUrl(t.containerMeta)
          : null
      if (headerType && headerType !== 'text' && !headerMediaUrl) {
        needsHeaderMedia++
      }

      const row = {
        account_id: accountId,
        user_id: userId,
        name: t.elementName,
        category: normalizeCategory(t.category),
        language: t.languageCode,
        body_text: t.data ?? '',
        status: normalizeStatus(t.status),
        gupshup_template_id: t.id,
        header_type: headerType,
        // Only overwrite header_media_url when we actually found one —
        // never null out a URL the user already entered manually on a
        // re-sync just because this run couldn't extract it again.
        ...(headerMediaUrl ? { header_media_url: headerMediaUrl } : {}),
        updated_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('message_templates')
        .select('id')
        .eq('account_id', accountId)
        .eq('name', t.elementName)
        .eq('language', t.languageCode)
        .maybeSingle()

      if (lookupErr) {
        errors.push({
          name: t.elementName,
          language: t.languageCode,
          message: lookupErr.message,
        })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('message_templates')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({
            name: t.elementName,
            language: t.languageCode,
            message: updErr.message,
          })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase
          .from('message_templates')
          .insert(row)
        if (insErr) {
          errors.push({
            name: t.elementName,
            language: t.languageCode,
            message: insErr.message,
          })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: templates.length,
      inserted,
      updated,
      skippedNotApproved,
      needsHeaderMedia,
      errors,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error syncing Gupshup templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync Gupshup templates',
      },
      { status: 500 },
    )
  }
}