import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * POST /api/gupshup/config
 *
 * Saves or updates this account's Gupshup connection. Unlike Meta's
 * flow, there's no live "verify these credentials" endpoint to call
 * before saving — Gupshup credentials are trusted as entered and only
 * proven correct by the first successful send.
 *
 * Body: { app_name, source_number, api_key }
 *
 * `app_name` MUST exactly match (case-sensitive) the "app" field
 * Gupshup sends in its webhook payload — this is how the webhook
 * route resolves which account an inbound message belongs to.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { app_name, source_number, api_key } = body

    if (!app_name || !source_number || !api_key) {
      return NextResponse.json(
        { error: 'app_name, source_number, and api_key are required' },
        { status: 400 }
      )
    }

    // Reject if another account already claims this app_name — mirrors
    // the phone_number_id ownership check in whatsapp_config's POST.
    // Without this, two accounts sharing an app_name would make the
    // webhook's .maybeSingle() lookup ambiguous and inbound messages
    // would silently land on whichever account happened to match.
    const { data: claimed, error: claimedError } = await supabase
      .from('gupshup_config')
      .select('account_id')
      .eq('app_name', app_name)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking app_name ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This Gupshup app name is already linked to another account on this instance.',
        },
        { status: 409 }
      )
    }

    let encryptedApiKey: string
    try {
      encryptedApiKey = encrypt(api_key)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt API key. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    const { data: existing } = await supabase
      .from('gupshup_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const baseRow = {
      app_name,
      source_number,
      api_key: encryptedApiKey,
      status: 'connected',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('gupshup_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating gupshup_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      const { error: insertError } = await supabase
        .from('gupshup_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting gupshup_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true, saved: true })
  } catch (error) {
    console.error('Error in Gupshup config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/gupshup/config
 * Removes this account's Gupshup connection. Does not touch
 * whatsapp_config (Meta).
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('gupshup_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting gupshup_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Gupshup config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
