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

// ============================================================
// Template send — Gupshup's template API is structurally different
// from its plain-text endpoint: it identifies the template by its
// Gupshup-assigned template ID (not name + language, like Meta), and
// takes a flat array of positional parameters rather than a
// name/language pair. The template ID is what message_templates.
// gupshup_template_id stores once a template is created/approved in
// the Gupshup dashboard.
//
// Docs: https://docs.gupshup.io/docs/template-messages
// ============================================================

export interface SendGupshupTemplateParams {
  apiKey: string;
  /** Your Gupshup source number (the WhatsApp number messages are sent from). */
  source: string;
  /** Your Gupshup app name, sent as src.name. */
  appName: string;
  /** Destination phone number, digits only (no leading +). */
  to: string;
  /** Gupshup's template ID (from message_templates.gupshup_template_id), not the template name. */
  templateId: string;
  /** Positional body variables, in order — e.g. ["Jane", "#1234"]. */
  params?: string[];
  /**
   * Header media, for templates whose header is image/video/document.
   * Gupshup needs this as a *separate* top-level `message` field
   * alongside `template` — sending only `template` (id + body params)
   * silently drops the header image/video/document with no error.
   */
  header?: {
    type: 'image' | 'video' | 'document';
    /** Public URL of the media to show in the header. */
    link: string;
    /** Required by Gupshup for document headers; ignored otherwise. */
    filename?: string;
  };
}

export async function sendGupshupTemplateMessage(
  params: SendGupshupTemplateParams
): Promise<SendGupshupResult> {
  const { apiKey, source, appName, to, templateId, params: templateParams, header } = params;

  const body: Record<string, string> = {
    channel: 'whatsapp',
    source,
    destination: to,
    'src.name': appName,
    template: JSON.stringify({
      id: templateId,
      params: templateParams ?? [],
    }),
  };

  if (header) {
    body.message = JSON.stringify({
      type: header.type,
      [header.type]: {
        link: header.link,
        ...(header.type === 'document' && header.filename
          ? { filename: header.filename }
          : {}),
      },
    });
  }

  const response = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
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