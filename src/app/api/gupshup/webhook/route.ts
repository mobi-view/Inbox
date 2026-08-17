import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing");
  }

  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    const body = await request.json();

    console.log("========== GUPSHUP WEBHOOK ==========");
    console.log(JSON.stringify(body, null, 2));
    console.log("=====================================");

    // ---------------------------------------------------------
    // 1. Make sure this is a Gupshup message
    // ---------------------------------------------------------

    if (body?.type !== "message") {
      console.log("Ignoring event:", body?.type);

      return NextResponse.json({
        success: true,
        ignored: true,
      });
    }

    const payload = body?.payload;

    if (!payload) {
      console.error("Missing payload");

      return NextResponse.json(
        {
          success: false,
          error: "Missing payload",
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 2. Extract Gupshup message information
    // ---------------------------------------------------------

    const messageId = payload?.id;

    const phone = payload?.sender?.phone;

    const name = payload?.sender?.name || phone || "WhatsApp Contact";

    const messageType = payload?.type || "text";

    const text = messageType === "text" ? payload?.payload?.text || "" : "";

    if (!messageId) {
      console.error("Missing message ID");

      return NextResponse.json(
        {
          success: false,
          error: "Missing message ID",
        },
        { status: 400 }
      );
    }

    if (!phone) {
      console.error("Missing sender phone");

      return NextResponse.json(
        {
          success: false,
          error: "Missing sender phone",
        },
        { status: 400 }
      );
    }

    console.log("Incoming Gupshup message:", {
      messageId,
      phone,
      name,
      messageType,
      text,
    });

    // ---------------------------------------------------------
    // 3. Find Gupshup configuration by app name
    //
    // Gupshup sends the app name in body.app — this is how we
    // identify which account/tenant this webhook call belongs to.
    // This table is separate from whatsapp_config (which is
    // dedicated to Meta's official Cloud API) so the two providers
    // never collide.
    // ---------------------------------------------------------

    const appName = body?.app;

    if (!appName) {
      console.error("[Gupshup] Missing app name in payload");

      return NextResponse.json(
        {
          success: false,
          error: "Missing app name",
        },
        { status: 400 }
      );
    }

    const { data: config, error: configError } = await supabaseAdmin
      .from("gupshup_config")
      .select("id, account_id, user_id, status")
      .eq("app_name", appName)
      .eq("status", "connected")
      .maybeSingle();

    if (configError) {
      console.error("[Gupshup] gupshup_config query error:", configError);

      return NextResponse.json(
        {
          success: false,
          error: "Failed to read Gupshup configuration",
        },
        { status: 500 }
      );
    }

    if (!config) {
      console.error(
        "[Gupshup] No connected gupshup_config found for app:",
        appName
      );

      return NextResponse.json(
        {
          success: false,
          error: "No connected Gupshup configuration found",
        },
        { status: 404 }
      );
    }

    const accountId = config.account_id;
    const userId = config.user_id;

    if (!accountId) {
      console.error("[Gupshup] gupshup_config has no account_id", config);

      return NextResponse.json(
        {
          success: false,
          error: "Gupshup configuration has no account_id",
        },
        { status: 500 }
      );
    }

    if (!userId) {
      console.error("[Gupshup] gupshup_config has no user_id", config);

      return NextResponse.json(
        {
          success: false,
          error: "Gupshup configuration has no user_id",
        },
        { status: 500 }
      );
    }

    console.log("[Gupshup] Using account:", accountId);
    console.log("[Gupshup] Using user:", userId);

    // ---------------------------------------------------------
    // 4. Find contact
    // ---------------------------------------------------------

    let contact;

    const { data: existingContact, error: contactFindError } =
      await supabaseAdmin
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .eq("phone", phone)
        .maybeSingle();

    if (contactFindError) {
      console.error("[Gupshup] Contact lookup error:", contactFindError);
    }

    // ---------------------------------------------------------
    // 5. Existing contact
    // ---------------------------------------------------------

    if (existingContact) {
      contact = existingContact;

      // Update name if changed
      if (name && name !== existingContact.name) {
        const { error: updateContactError } = await supabaseAdmin
          .from("contacts")
          .update({
            name,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingContact.id);

        if (updateContactError) {
          console.error(
            "[Gupshup] Contact name update error:",
            updateContactError
          );
        }
      }
    }

    // ---------------------------------------------------------
    // 6. Create contact
    // ---------------------------------------------------------

    else {
      console.log("[Gupshup] Contact not found. Creating...");

      const { data: newContact, error: contactCreateError } =
        await supabaseAdmin
          .from("contacts")
          .insert({
            account_id: accountId,
            user_id: userId,
            phone,
            name,
          })
          .select("*")
          .single();

      if (contactCreateError) {
        console.error("[Gupshup] Contact creation error:", contactCreateError);

        return NextResponse.json(
          {
            success: false,
            error: "Failed to create contact",
            details: contactCreateError.message,
          },
          { status: 500 }
        );
      }

      contact = newContact;
    }

    console.log("[Gupshup] Contact:", contact.id);

    // ---------------------------------------------------------
    // 7. Find conversation
    // ---------------------------------------------------------

    let conversation;

    const { data: existingConversation, error: conversationFindError } =
      await supabaseAdmin
        .from("conversations")
        .select("*")
        .eq("account_id", accountId)
        .eq("contact_id", contact.id)
        .order("created_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

    if (conversationFindError) {
      console.error(
        "[Gupshup] Conversation lookup error:",
        conversationFindError
      );
    }

    // ---------------------------------------------------------
    // 8. Existing conversation
    // ---------------------------------------------------------

    if (existingConversation) {
      conversation = existingConversation;
    }

    // ---------------------------------------------------------
    // 9. Create conversation
    // ---------------------------------------------------------

    else {
      console.log("[Gupshup] Conversation not found. Creating...");

      const { data: newConversation, error: conversationCreateError } =
        await supabaseAdmin
          .from("conversations")
          .insert({
            account_id: accountId,
            user_id: userId,
            contact_id: contact.id,
          })
          .select("*")
          .single();

      if (conversationCreateError) {
        console.error(
          "[Gupshup] Conversation creation error:",
          conversationCreateError
        );

        return NextResponse.json(
          {
            success: false,
            error: "Failed to create conversation",
            details: conversationCreateError.message,
          },
          { status: 500 }
        );
      }

      conversation = newConversation;
    }

    console.log("[Gupshup] Conversation:", conversation.id);

    // ---------------------------------------------------------
    // 10. Prevent duplicate messages
    // ---------------------------------------------------------

    const { data: existingMessage, error: duplicateCheckError } =
      await supabaseAdmin
        .from("messages")
        .select("id")
        .eq("conversation_id", conversation.id)
        .eq("message_id", messageId)
        .maybeSingle();

    if (duplicateCheckError) {
      console.error("[Gupshup] Duplicate check error:", duplicateCheckError);
    }

    if (existingMessage) {
      console.log("[Gupshup] Duplicate message:", messageId);

      return NextResponse.json({
        success: true,
        duplicate: true,
      });
    }

    // ---------------------------------------------------------
    // 11. Determine content type
    // ---------------------------------------------------------

    let contentType = "text";

    switch (messageType) {
      case "text":
        contentType = "text";
        break;

      case "image":
        contentType = "image";
        break;

      case "video":
        contentType = "video";
        break;

      case "audio":
        contentType = "audio";
        break;

      case "document":
        contentType = "document";
        break;

      case "sticker":
        contentType = "sticker";
        break;

      case "location":
        contentType = "location";
        break;

      case "contacts":
        contentType = "contacts";
        break;

      default:
        contentType = "text";
    }

    // ---------------------------------------------------------
    // 12. Convert timestamp
    // ---------------------------------------------------------

    let createdAt = new Date().toISOString();

    if (body?.timestamp) {
      const timestampNumber = Number(body.timestamp);

      if (!Number.isNaN(timestampNumber)) {
        createdAt = new Date(timestampNumber).toISOString();
      }
    }

    // ---------------------------------------------------------
    // 13. Insert message
    // ---------------------------------------------------------

    const { data: newMessage, error: messageError } = await supabaseAdmin
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        sender_type: "customer",
        content_type: contentType,
        content_text: text || null,
        message_id: messageId,
        status: "delivered",
        created_at: createdAt,
      })
      .select("*")
      .single();

    if (messageError) {
      console.error("[Gupshup] Message insert error:", messageError);

      return NextResponse.json(
        {
          success: false,
          error: "Failed to save message",
          details: messageError.message,
        },
        { status: 500 }
      );
    }

    console.log("[Gupshup] Message saved:", newMessage.id);

    // ---------------------------------------------------------
    // 14. Update conversation
    // ---------------------------------------------------------

    const currentUnread = Number(conversation.unread_count || 0);

    const { error: conversationUpdateError } = await supabaseAdmin
      .from("conversations")
      .update({
        last_message_text: text || `[${messageType}]`,
        last_message_at: createdAt,
        unread_count: currentUnread + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);

    if (conversationUpdateError) {
      console.error(
        "[Gupshup] Conversation update error:",
        conversationUpdateError
      );
    }

    // ---------------------------------------------------------
    // 15. DONE
    // ---------------------------------------------------------

    console.log("=====================================");
    console.log("[Gupshup] MESSAGE SUCCESSFULLY SAVED");
    console.log("Account:", accountId);
    console.log("Contact:", contact.id);
    console.log("Conversation:", conversation.id);
    console.log("Message:", newMessage.id);
    console.log("=====================================");

    return NextResponse.json({
      success: true,
      messageId: newMessage.id,
      conversationId: conversation.id,
      contactId: contact.id,
      accountId: accountId,
    });
  } catch (error) {
    console.error("[Gupshup] Webhook fatal error:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Invalid webhook request",
      },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------
// GET
// Gupshup may call GET while verifying/testing webhook.
// ---------------------------------------------------------

export async function GET() {
  return NextResponse.json({
    success: true,
    webhook: "Gupshup",
    status: "active",
  });
}
