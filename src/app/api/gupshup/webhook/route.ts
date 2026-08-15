import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// SUPABASE ADMIN CLIENT
// ============================================================

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

// ============================================================
// TYPES
// ============================================================

type GupshupWebhook = {
  app?: string;
  timestamp?: number;
  version?: number;
  type?: string;

  payload?: {
    id?: string;
    source?: string;
    type?: string;

    payload?: {
      text?: string;
      url?: string;
      caption?: string;
    };

    sender?: {
      phone?: string;
      name?: string;
      country_code?: string;
      dial_code?: string;
    };
  };
};

// ============================================================
// POST
// ============================================================

export async function POST(request: NextRequest) {
  try {
    console.log("");
    console.log("==========================================");
    console.log("       GUPSHUP INCOMING WEBHOOK");
    console.log("==========================================");

    // ----------------------------------------------------------
    // 1. Read webhook
    // ----------------------------------------------------------

    const body = (await request.json()) as GupshupWebhook;

    console.log(
      "[Gupshup] Incoming:",
      JSON.stringify(body, null, 2)
    );

    // ----------------------------------------------------------
    // 2. Only process message events
    // ----------------------------------------------------------

    if (body.type !== "message") {
      console.log(
        "[Gupshup] Ignoring event:",
        body.type
      );

      return NextResponse.json({
        success: true,
        ignored: true,
      });
    }

    const payload = body.payload;

    if (!payload) {
      console.error("[Gupshup] Missing payload");

      return NextResponse.json(
        {
          success: false,
          error: "Missing payload",
        },
        { status: 400 }
      );
    }

    // ----------------------------------------------------------
    // 3. Extract message information
    // ----------------------------------------------------------

    const messageId = payload.id;

    const phone =
      payload.sender?.phone ||
      payload.source;

    const name =
      payload.sender?.name ||
      phone ||
      "WhatsApp Contact";

    const messageType =
      payload.type || "text";

    const text =
      payload.payload?.text ||
      payload.payload?.caption ||
      "";

    if (!messageId) {
      console.error("[Gupshup] Missing message ID");

      return NextResponse.json(
        {
          success: false,
          error: "Missing message ID",
        },
        { status: 400 }
      );
    }

    if (!phone) {
      console.error("[Gupshup] Missing sender phone");

      return NextResponse.json(
        {
          success: false,
          error: "Missing sender phone",
        },
        { status: 400 }
      );
    }

    console.log("[Gupshup] Parsed message:", {
      messageId,
      phone,
      name,
      messageType,
      text,
    });

    // ----------------------------------------------------------
    // 4. Supabase
    // ----------------------------------------------------------

    const supabase = getSupabaseAdmin();

    // ----------------------------------------------------------
    // 5. Find WhatsApp configuration
    // ----------------------------------------------------------

    const {
      data: configs,
      error: configError,
    } = await supabase
      .from("whatsapp_config")
      .select(
        "id, user_id, account_id"
      )
      .not("account_id", "is", null)
      .limit(10);

    if (configError) {
      console.error(
        "[Gupshup] whatsapp_config error:",
        configError
      );

      return NextResponse.json(
        {
          success: false,
          error: "Failed to load WhatsApp configuration",
        },
        { status: 500 }
      );
    }

    if (!configs || configs.length === 0) {
      console.error(
        "[Gupshup] No whatsapp_config found"
      );

      return NextResponse.json(
        {
          success: false,
          error: "No WhatsApp configuration found",
        },
        { status: 404 }
      );
    }

    /*
     * Your database currently uses account_id as the
     * tenant/account identifier.
     *
     * Since you have one WhatsApp account configured,
     * using the first active configuration is okay.
     *
     * Later, if you support multiple WhatsApp numbers,
     * we should match the Gupshup app/source to a specific
     * whatsapp_config row.
     */

    const config = configs[0];

    const accountId = config.account_id;
    const userId = config.user_id;

    if (!accountId || !userId) {
      console.error(
        "[Gupshup] Invalid whatsapp_config:",
        config
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "WhatsApp configuration has no account_id/user_id",
        },
        { status: 500 }
      );
    }

    console.log(
      "[Gupshup] Account:",
      accountId
    );

    console.log(
      "[Gupshup] Config owner:",
      userId
    );

    // ----------------------------------------------------------
    // 6. Normalize phone
    // ----------------------------------------------------------

    const normalizedPhone =
      String(phone).replace(/\D/g, "");

    console.log(
      "[Gupshup] Normalized phone:",
      normalizedPhone
    );

    // ----------------------------------------------------------
    // 7. Find contact
    // ----------------------------------------------------------

    let contact: any = null;

    const {
      data: existingContact,
      error: contactFindError,
    } = await supabase
      .from("contacts")
      .select("*")
      .eq("account_id", accountId)
      .eq("phone_normalized", normalizedPhone)
      .maybeSingle();

    if (contactFindError) {
      console.warn(
        "[Gupshup] phone_normalized lookup failed:",
        contactFindError.message
      );
    }

    // ----------------------------------------------------------
    // Fallback: search phone directly
    // ----------------------------------------------------------

    if (!existingContact) {
      const {
        data: fallbackContact,
        error: fallbackError,
      } = await supabase
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .eq("phone", normalizedPhone)
        .maybeSingle();

      if (!fallbackError && fallbackContact) {
        contact = fallbackContact;
      }
    } else {
      contact = existingContact;
    }

    // ----------------------------------------------------------
    // 8. Create/update contact
    // ----------------------------------------------------------

    if (contact) {
      console.log(
        "[Gupshup] Existing contact:",
        contact.id
      );

      if (
        name &&
        name !== contact.name
      ) {
        const { error: updateContactError } =
          await supabase
            .from("contacts")
            .update({
              name,
              updated_at:
                new Date().toISOString(),
            })
            .eq("id", contact.id);

        if (updateContactError) {
          console.warn(
            "[Gupshup] Contact name update failed:",
            updateContactError
          );
        }
      }
    } else {
      console.log(
        "[Gupshup] Creating new contact..."
      );

      const {
        data: newContact,
        error: createContactError,
      } = await supabase
        .from("contacts")
        .insert({
          account_id: accountId,
          user_id: userId,
          phone: normalizedPhone,
          name: name || normalizedPhone,
          phone_normalized: normalizedPhone,
        })
        .select()
        .single();

      if (createContactError) {
        console.error(
          "[Gupshup] Contact creation failed:",
          createContactError
        );

        return NextResponse.json(
          {
            success: false,
            error: "Failed to create contact",
            details:
              createContactError.message,
          },
          { status: 500 }
        );
      }

      contact = newContact;

      console.log(
        "[Gupshup] Contact created:",
        contact.id
      );
    }

    // ----------------------------------------------------------
    // 9. Find conversation
    // ----------------------------------------------------------

    let conversation: any = null;

    const {
      data: existingConversations,
      error: conversationFindError,
    } = await supabase
      .from("conversations")
      .select("*")
      .eq("account_id", accountId)
      .eq("contact_id", contact.id)
      .order("created_at", {
        ascending: true,
      })
      .limit(1);

    if (conversationFindError) {
      console.error(
        "[Gupshup] Conversation lookup failed:",
        conversationFindError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Failed to find conversation",
        },
        { status: 500 }
      );
    }

    if (
      existingConversations &&
      existingConversations.length > 0
    ) {
      conversation =
        existingConversations[0];

      console.log(
        "[Gupshup] Existing conversation:",
        conversation.id
      );
    }

    // ----------------------------------------------------------
    // 10. Create conversation if needed
    // ----------------------------------------------------------

    if (!conversation) {
      console.log(
        "[Gupshup] Creating conversation..."
      );

      const {
        data: newConversation,
        error: createConversationError,
      } = await supabase
        .from("conversations")
        .insert({
          account_id: accountId,
          user_id: userId,
          contact_id: contact.id,
        })
        .select()
        .single();

      if (createConversationError) {
        console.error(
          "[Gupshup] Conversation creation failed:",
          createConversationError
        );

        return NextResponse.json(
          {
            success: false,
            error:
              "Failed to create conversation",
            details:
              createConversationError.message,
          },
          { status: 500 }
        );
      }

      conversation =
        newConversation;

      console.log(
        "[Gupshup] Conversation created:",
        conversation.id
      );
    }

    // ----------------------------------------------------------
    // 11. Check duplicate message
    // ----------------------------------------------------------

    const {
      data: existingMessage,
      error: duplicateCheckError,
    } = await supabase
      .from("messages")
      .select("id")
      .eq(
        "conversation_id",
        conversation.id
      )
      .eq("message_id", messageId)
      .maybeSingle();

    if (duplicateCheckError) {
      console.warn(
        "[Gupshup] Duplicate check warning:",
        duplicateCheckError
      );
    }

    if (existingMessage) {
      console.log(
        "[Gupshup] Duplicate message:",
        messageId
      );

      return NextResponse.json({
        success: true,
        duplicate: true,
      });
    }

    // ----------------------------------------------------------
    // 12. Map message type
    // ----------------------------------------------------------

    const allowedContentTypes = [
      "text",
      "image",
      "document",
      "audio",
      "video",
      "location",
      "template",
      "interactive",
    ];

    let contentType = messageType;

    if (
      !allowedContentTypes.includes(
        contentType
      )
    ) {
      contentType = "text";
    }

    // ----------------------------------------------------------
    // 13. Timestamp
    // ----------------------------------------------------------

    const timestamp =
      body.timestamp &&
      Number(body.timestamp) > 0
        ? new Date(
            Number(body.timestamp)
          ).toISOString()
        : new Date().toISOString();

    // ----------------------------------------------------------
    // 14. Insert message
    // ----------------------------------------------------------

    console.log(
      "[Gupshup] Saving message..."
    );

    const {
      data: newMessage,
      error: messageError,
    } = await supabase
      .from("messages")
      .insert({
        conversation_id:
          conversation.id,

        sender_type: "customer",

        content_type:
          contentType,

        content_text:
          text || null,

        message_id:
          messageId,

        status:
          "delivered",

        created_at:
          timestamp,
      })
      .select()
      .single();

    if (messageError) {
      console.error(
        "[Gupshup] Message insert failed:",
        messageError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Failed to save message",
          details:
            messageError.message,
        },
        { status: 500 }
      );
    }

    console.log(
      "[Gupshup] Message saved:",
      newMessage.id
    );

    // ----------------------------------------------------------
    // 15. Update conversation
    // ----------------------------------------------------------
    //
    // Your existing project has the RPC:
    //
    // bump_conversation_on_inbound
    //
    // This is safer than manually doing unread_count + 1.
    // ----------------------------------------------------------

    const {
      error: bumpError,
    } = await supabase.rpc(
      "bump_conversation_on_inbound",
      {
        p_conversation_id:
          conversation.id,

        p_last_message_text:
          text ||
          `[${messageType}]`,
      }
    );

    if (bumpError) {
      console.warn(
        "[Gupshup] Conversation bump RPC failed:",
        bumpError
      );

      // Fallback update
      const {
        error: fallbackUpdateError,
      } = await supabase
        .from("conversations")
        .update({
          last_message_text:
            text ||
            `[${messageType}]`,

          last_message_at:
            timestamp,

          unread_count:
            (conversation.unread_count || 0) +
            1,

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          conversation.id
        );

      if (fallbackUpdateError) {
        console.error(
          "[Gupshup] Conversation fallback update failed:",
          fallbackUpdateError
        );
      }
    }

    // ----------------------------------------------------------
    // 16. DONE
    // ----------------------------------------------------------

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "       MESSAGE SUCCESSFULLY SAVED"
    );
    console.log(
      "=========================================="
    );

    console.log({
      messageId,
      contactId: contact.id,
      conversationId:
        conversation.id,
      accountId,
      text,
    });

    return NextResponse.json({
      success: true,

      messageId:
        newMessage.id,

      whatsappMessageId:
        messageId,

      contactId:
        contact.id,

      conversationId:
        conversation.id,

      accountId,

      text,
    });
  } catch (error) {
    console.error(
      "[Gupshup] WEBHOOK ERROR:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}