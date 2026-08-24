import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { sendGupshupTemplateMessage } from '@/lib/whatsapp/gupshup-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls Meta directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    // ----------------------------------------------------------
    // Resolve provider + config, account-scoped. Same fallback order
    // as sendMessageToConversation: Meta config wins if present,
    // otherwise fall back to a connected Gupshup config. Keeps every
    // existing Meta broadcaster's behaviour unchanged.
    // ----------------------------------------------------------
    const { data: metaConfig, error: metaConfigError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (metaConfigError) {
      console.error('[broadcast] whatsapp_config query error:', metaConfigError.message)
    }

    let gupshupConfig: {
      api_key: string
      source_number: string
      app_name: string
    } | null = null

    if (!metaConfig) {
      const { data, error: gupshupConfigError } = await supabase
        .from('gupshup_config')
        .select('*')
        .eq('account_id', accountId)
        .eq('status', 'connected')
        .maybeSingle()

      if (gupshupConfigError) {
        console.error('[broadcast] gupshup_config query error:', gupshupConfigError.message)
      }
      gupshupConfig = data
    }

    if (!metaConfig && !gupshupConfig) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    // Load the template row once so sendTemplateMessage (Meta) can
    // build header + button components, and so the Gupshup path can
    // resolve gupshup_template_id. Loading inside the loop would
    // N+1 against Supabase for every recipient. Guard against a
    // malformed local row crashing every send in the loop with the
    // same opaque TypeError — fail loudly once.
    const { data: rawTemplateRow } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle()
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = rawTemplateRow ?? null

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    if (gupshupConfig) {
      // ----------------------------------------------------------
      // Gupshup broadcast path.
      // ----------------------------------------------------------
      const gupshupTemplateId = (templateRow as { gupshup_template_id?: string } | null)
        ?.gupshup_template_id

      if (!gupshupTemplateId) {
        return NextResponse.json(
          {
            error: `Template "${template_name}" has no gupshup_template_id set. Open Settings → Templates and paste in the matching Gupshup template UUID from the Gupshup Dashboard before broadcasting.`,
          },
          { status: 400 },
        )
      }

      const headerType = (templateRow as { header_type?: string } | null)?.header_type
      const headerMediaUrl = (templateRow as { header_media_url?: string } | null)
        ?.header_media_url
      const needsHeaderMedia =
        headerType === 'image' || headerType === 'video' || headerType === 'document'

      if (needsHeaderMedia && !headerMediaUrl) {
        return NextResponse.json(
          {
            error: `Template "${template_name}" has a ${headerType} header but no header_media_url set. Open Settings → Templates and add the header media URL before broadcasting.`,
          },
          { status: 400 },
        )
      }

      const gupshupHeader = needsHeaderMedia
        ? { type: headerType as 'image' | 'video' | 'document', link: headerMediaUrl! }
        : undefined

      let decryptedApiKey: string
      try {
        decryptedApiKey = decrypt(gupshupConfig.api_key)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown decryption error'
        console.error('[broadcast] Gupshup api_key decryption failed:', message)
        return NextResponse.json(
          {
            error:
              'The stored Gupshup API key cannot be decrypted with the current ENCRYPTION_KEY. Reconnect Gupshup in Settings.',
          },
          { status: 500 },
        )
      }

      for (const recipient of recipients) {
        const sanitized = sanitizePhoneForMeta(recipient.phone)

        if (!isValidE164(sanitized)) {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Invalid phone number format',
          })
          failedCount++
          continue
        }

        try {
          const result = await sendGupshupTemplateMessage({
            apiKey: decryptedApiKey,
            source: gupshupConfig.source_number,
            appName: gupshupConfig.app_name,
            to: sanitized,
            templateId: gupshupTemplateId,
            params: recipient.params ?? [],
            header: gupshupHeader,
          })
          results.push({
            phone: recipient.phone,
            status: 'sent',
            whatsapp_message_id: result.messageId,
          })
          sentCount++
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown Gupshup error'
          console.error(`Failed to send broadcast to ${recipient.phone}:`, errorMessage)
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: errorMessage,
          })
          failedCount++
        }
      }
    } else {
      // ----------------------------------------------------------
      // Meta broadcast path — unchanged from the original implementation.
      // ----------------------------------------------------------
      const accessToken = decrypt(metaConfig!.access_token)

      for (const recipient of recipients) {
        const sanitized = sanitizePhoneForMeta(recipient.phone)

        if (!isValidE164(sanitized)) {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Invalid phone number format',
          })
          failedCount++
          continue
        }

        // Retry with phone variants on "not in allowed list" so numbers
        // that differ only in a trunk-prefix 0 still reach recipients.
        const variants = phoneVariants(sanitized)
        let sentMessageId: string | null = null
        let lastError: string | null = null

        for (const variant of variants) {
          try {
            const result = await sendTemplateMessage({
              phoneNumberId: metaConfig!.phone_number_id,
              accessToken,
              to: variant,
              templateName: template_name,
              language: template_language || 'en_US',
              template: templateRow ?? undefined,
              messageParams: recipient.messageParams,
              params: recipient.params ?? [],
            })
            sentMessageId = result.messageId
            lastError = null
            break
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error'
            if (!isRecipientNotAllowedError(errorMessage)) {
              lastError = errorMessage
              break
            }
            lastError = errorMessage
            // retry with next variant
          }
        }

        if (sentMessageId) {
          results.push({
            phone: recipient.phone,
            status: 'sent',
            whatsapp_message_id: sentMessageId,
          })
          sentCount++
        } else {
          console.error(
            `Failed to send broadcast to ${recipient.phone}:`,
            lastError
          )
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: lastError || 'Unknown error',
          })
          failedCount++
        }
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}