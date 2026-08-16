// ============================================================
// Minimal Gupshup send helper — mirrors the shape of meta-api.ts's
// sendTextMessage() so send-message.ts can call either provider
// through a similar interface.
//
// NOTE: only plain text is supported here. Gupshup's template/media/
// interactive APIs use a different shape than Meta's and aren't
// wired up yet — send-message.ts rejects those message types for
// the 'gupshup' provider with a clear error instead of guessing.
// ============================================================

export interface SendGupshupTextParams {
  apiKey: string;
  /** Your Gupshup source number (the WhatsApp number messages are sent from). */
  source: string;
  /** Your Gupshup app name, sent as src.name. */
  appName: string;
  /** Destination phone number, digits only (no leading +). */
  to: string;
  text: string;
}

export interface SendGupshupResult {
  messageId: string;
}

export interface SendGupshupTemplateParams {
  apiKey: string;
  source: string;
  appName: string;
  to: string;
  /** Gupshup's own template UUID (Dashboard > Templates) — NOT Meta's template name. */
  gupshupTemplateId: string;
  /** Body variable values, one per {{N}}, in order. */
  params: string[];
}

/**
 * Send an approved WhatsApp template ("HSM") through Gupshup.
 *
 * Gupshup identifies templates by its own UUID, resolved via the
 * `gupshup_template_id` column on `message_templates` (see migration
 * 038) — separate from Meta's name+language lookup. Only body
 * variables are supported here (positional `params`); Gupshup's
 * header-media / button-variable options aren't wired up, matching
 * the same scope limit as the text path above.
 */
export async function sendGupshupTemplateMessage(
  params: SendGupshupTemplateParams
): Promise<SendGupshupResult> {
  const { apiKey, source, appName, to, gupshupTemplateId, params: bodyParams } = params;

  const response = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      channel: 'whatsapp',
      source,
      destination: to,
      'src.name': appName,
      template: JSON.stringify({ id: gupshupTemplateId, params: bodyParams }),
    }),
  });

  const responseText = await response.text();

  console.log('[Gupshup TEMPLATE SEND]', response.status, responseText);

  if (!response.ok) {
    throw new Error(`Gupshup rejected the template message: ${responseText}`);
  }

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = { raw: responseText };
  }

  const messageId =
    (result?.messageId as string | undefined) ||
    (result?.message_id as string | undefined);

  if (!messageId) {
    throw new Error(`Gupshup response missing messageId: ${responseText}`);
  }

  return { messageId };
}

export async function sendGupshupTextMessage(
  params: SendGupshupTextParams
): Promise<SendGupshupResult> {
  const { apiKey, source, appName, to, text } = params;

  const response = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      channel: 'whatsapp',
      source,
      destination: to,
      'src.name': appName,
      message: JSON.stringify({ type: 'text', text }),
    }),
  });

  const responseText = await response.text();

  console.log('[Gupshup SEND]', response.status, responseText);

  if (!response.ok) {
    throw new Error(`Gupshup rejected the message: ${responseText}`);
  }

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = { raw: responseText };
  }

  const messageId =
    (result?.messageId as string | undefined) ||
    (result?.message_id as string | undefined);

  if (!messageId) {
    throw new Error(`Gupshup response missing messageId: ${responseText}`);
  }

  return { messageId };
}