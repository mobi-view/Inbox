import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/whatsapp/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getAdminClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase environment variables are missing"
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function POST(
  request: NextRequest
) {
  try {
    const supabase =
      await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const body =
      await request.json();

    const {
      destination,
      text,
      conversation_id,
    } = body;

    if (!destination) {
      return NextResponse.json(
        {
          error:
            "destination is required",
        },
        { status: 400 }
      );
    }

    if (!text) {
      return NextResponse.json(
        {
          error:
            "text is required",
        },
        { status: 400 }
      );
    }

    const admin =
      getAdminClient();

    /*
    --------------------------------------------------------
    Find account
    --------------------------------------------------------
    */

    const { data: profile } =
      await admin
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();

    if (!profile?.account_id) {
      return NextResponse.json(
        {
          error:
            "Account not found",
        },
        { status: 404 }
      );
    }

    /*
    --------------------------------------------------------
    Get Gupshup configuration
    --------------------------------------------------------
    */

    const {
      data: config,
      error: configError,
    } = await admin
      .from("whatsapp_config")
      .select(
        "id, phone_number_id, waba_id, access_token, status"
      )
      .eq(
        "account_id",
        profile.account_id
      )
      .eq(
        "status",
        "connected"
      )
      .maybeSingle();

    if (
      configError ||
      !config
    ) {
      return NextResponse.json(
        {
          error:
            "Gupshup WhatsApp is not connected.",
        },
        { status: 400 }
      );
    }

    /*
    --------------------------------------------------------
    Decrypt Gupshup API key
    --------------------------------------------------------
    */

    let apiKey: string;

    try {
      apiKey =
        decrypt(
          config.access_token
        );
    } catch {
      return NextResponse.json(
        {
          error:
            "Unable to decrypt Gupshup API key.",
        },
        { status: 500 }
      );
    }

    /*
    --------------------------------------------------------
    Send through Gupshup
    --------------------------------------------------------
    */

    const gupshupResponse =
      await fetch(
        "https://api.gupshup.io/wa/api/v1/msg",
        {
          method: "POST",

          headers: {
            apikey: apiKey,

            "Content-Type":
              "application/x-www-form-urlencoded",
          },

          body:
            new URLSearchParams({
              channel:
                "whatsapp",

              source:
                config.phone_number_id,

              destination:
                String(destination),

              "src.name":
                config.waba_id,

              message:
                JSON.stringify({
                  type: "text",
                  text: String(text),
                }),
            }),
        }
      );

    const responseText =
      await gupshupResponse.text();

    console.log(
      "[Gupshup SEND]",
      gupshupResponse.status,
      responseText
    );

    if (
      !gupshupResponse.ok
    ) {
      return NextResponse.json(
        {
          error:
            "Gupshup rejected the message.",

          details:
            responseText,
        },
        {
          status:
            gupshupResponse.status,
        }
      );
    }

    /*
    --------------------------------------------------------
    Parse Gupshup response
    --------------------------------------------------------
    */

    let gupshupResult: any;

    try {
      gupshupResult =
        JSON.parse(
          responseText
        );
    } catch {
      gupshupResult = {
        raw: responseText,
      };
    }

    /*
    --------------------------------------------------------
    Save outgoing message
    --------------------------------------------------------
    */

    if (conversation_id) {
      const messageId =
        gupshupResult?.messageId ||
        gupshupResult?.message_id ||
        null;

      const {
        error: messageError,
      } = await admin
        .from("messages")
        .insert({
          conversation_id,

          sender_type:
            "agent",

          content_type:
            "text",

          content_text:
            String(text),

          message_id:
            messageId,

          status:
            "sent",

          created_at:
            new Date().toISOString(),
        });

      if (messageError) {
        console.error(
          "[Gupshup] Failed to save outgoing message:",
          messageError
        );
      }

      await admin
        .from("conversations")
        .update({
          last_message_text:
            String(text),

          last_message_at:
            new Date().toISOString(),

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          conversation_id
        );
    }

    return NextResponse.json({
      success: true,

      provider:
        "gupshup",

      gupshup:
        gupshupResult,
    });
  } catch (error) {
    console.error(
      "[Gupshup SEND] Error:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Internal server error",
      },
      { status: 500 }
    );
  }
}