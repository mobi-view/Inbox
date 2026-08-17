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
