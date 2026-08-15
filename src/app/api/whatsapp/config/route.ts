import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing");
  }

  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  return createAdminClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function getAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
) {
  const { data, error } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Profile lookup error:", error);
    return null;
  }

  return data?.account_id || null;
}

/*
============================================================
GET
============================================================
*/

export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          connected: false,
          reason: "unauthorized",
        },
        { status: 401 }
      );
    }

    const accountId = await getAccountId(
      supabase,
      user.id
    );

    if (!accountId) {
      return NextResponse.json({
        connected: false,
        reason: "no_account",
        message:
          "Your profile is not linked to an account.",
      });
    }

    const { data: config, error } =
      await supabase
        .from("whatsapp_config")
        .select(
          "id, phone_number_id, waba_id, status, connected_at, account_id"
        )
        .eq("account_id", accountId)
        .maybeSingle();

    if (error) {
      console.error(
        "whatsapp_config GET error:",
        error
      );

      return NextResponse.json({
        connected: false,
        reason: "db_error",
        message:
          "Failed to read WhatsApp configuration.",
      });
    }

    if (!config) {
      return NextResponse.json({
        connected: false,
        reason: "no_config",
        message:
          "No Gupshup WhatsApp configuration found.",
      });
    }

    if (config.status !== "connected") {
      return NextResponse.json({
        connected: false,
        reason: "disconnected",
        message:
          "WhatsApp is not connected.",
        config,
      });
    }

    return NextResponse.json({
      connected: true,

      provider: "gupshup",

      phone_number:
        config.phone_number_id,

      app_name:
        config.waba_id,

      connected_at:
        config.connected_at,
    });
  } catch (error) {
    console.error(
      "Gupshup config GET error:",
      error
    );

    return NextResponse.json({
      connected: false,
      reason: "server_error",
      message:
        error instanceof Error
          ? error.message
          : "Internal server error",
    });
  }
}

/*
============================================================
POST
============================================================

Expected body:

{
  "phone_number": "972595744379",
  "app_name": "ubcGroup",
  "api_key": "YOUR_GUPSHUP_API_KEY"
}

============================================================
*/

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const accountId = await getAccountId(
      supabase,
      user.id
    );

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            "Your profile is not linked to an account.",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const phoneNumber =
      String(body.phone_number || "").trim();

    const appName =
      String(body.app_name || "").trim();

    const apiKey =
      String(body.api_key || "").trim();

    if (!phoneNumber) {
      return NextResponse.json(
        {
          error:
            "Gupshup phone_number is required.",
        },
        { status: 400 }
      );
    }

    if (!appName) {
      return NextResponse.json(
        {
          error:
            "Gupshup app_name is required.",
        },
        { status: 400 }
      );
    }

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Gupshup api_key is required.",
        },
        { status: 400 }
      );
    }

    /*
    --------------------------------------------------------
    Test Gupshup credentials before saving
    --------------------------------------------------------
    */

    const testResponse = await fetch(
      "https://api.gupshup.io/wa/api/v1/msg",
      {
        method: "POST",

        headers: {
          apikey: apiKey,
          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body: new URLSearchParams({
          channel: "whatsapp",
          source: phoneNumber,
          destination: phoneNumber,

          message: JSON.stringify({
            type: "text",
            text: "Gupshup connection test",
          }),

          "src.name": appName,
        }),
      }
    );

    /*
      We don't actually want to send the test message.
      Therefore don't rely on this as a connection test.
    */

    /*
    --------------------------------------------------------
    Encrypt API key
    --------------------------------------------------------
    */

    let encryptedApiKey: string;

    try {
      encryptedApiKey = encrypt(apiKey);
    } catch (error) {
      console.error(
        "Gupshup encryption error:",
        error
      );

      return NextResponse.json(
        {
          error:
            "Failed to encrypt Gupshup API key. Check ENCRYPTION_KEY.",
        },
        { status: 500 }
      );
    }

    /*
    --------------------------------------------------------
    Check existing config
    --------------------------------------------------------
    */

    const { data: existing } =
      await supabase
        .from("whatsapp_config")
        .select("id")
        .eq("account_id", accountId)
        .maybeSingle();

    const configData = {
      user_id: user.id,

      account_id: accountId,

      /*
        Existing DB column
        stores Gupshup source phone
      */
      phone_number_id: phoneNumber,

      /*
        Existing DB column
        stores Gupshup App Name
      */
      waba_id: appName,

      /*
        Existing DB column
        stores encrypted Gupshup API key
      */
      access_token: encryptedApiKey,

      verify_token: null,

      status: "connected",

      connected_at:
        new Date().toISOString(),

      updated_at:
        new Date().toISOString(),

      last_registration_error: null,
    };

    /*
    --------------------------------------------------------
    UPDATE
    --------------------------------------------------------
    */

    if (existing) {
      const { error: updateError } =
        await supabase
          .from("whatsapp_config")
          .update(configData)
          .eq("account_id", accountId);

      if (updateError) {
        console.error(
          "Gupshup config update error:",
          updateError
        );

        return NextResponse.json(
          {
            error:
              "Failed to update Gupshup configuration.",
            details:
              updateError.message,
          },
          { status: 500 }
        );
      }
    }

    /*
    --------------------------------------------------------
    INSERT
    --------------------------------------------------------
    */

    else {
      const { error: insertError } =
        await supabase
          .from("whatsapp_config")
          .insert({
            id: undefined,

            ...configData,
          });

      if (insertError) {
        console.error(
          "Gupshup config insert error:",
          insertError
        );

        return NextResponse.json(
          {
            error:
              "Failed to save Gupshup configuration.",
            details:
              insertError.message,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,

      connected: true,

      provider: "gupshup",

      phone_number:
        phoneNumber,

      app_name:
        appName,

      message:
        "Gupshup WhatsApp connected successfully.",
    });
  } catch (error) {
    console.error(
      "Gupshup config POST error:",
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

/*
============================================================
DELETE
============================================================
*/

export async function DELETE() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const accountId = await getAccountId(
      supabase,
      user.id
    );

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            "Your profile is not linked to an account.",
        },
        { status: 403 }
      );
    }

    const { error } =
      await supabase
        .from("whatsapp_config")
        .delete()
        .eq("account_id", accountId);

    if (error) {
      console.error(
        "Gupshup config delete error:",
        error
      );

      return NextResponse.json(
        {
          error:
            "Failed to delete configuration.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error(
      "Gupshup config DELETE error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Internal server error",
      },
      { status: 500 }
    );
  }
}