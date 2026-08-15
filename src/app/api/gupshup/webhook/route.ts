import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    console.log("========== GUPSHUP WEBHOOK ==========");
    console.log(JSON.stringify(body, null, 2));
    console.log("=====================================");

    // Make sure this is a message event
    if (body.type !== "message") {
      console.log("Ignoring non-message event:", body.type);

      return NextResponse.json({
        success: true,
        ignored: true,
      });
    }

    const payload = body.payload;

    if (!payload) {
      return NextResponse.json(
        { error: "Missing payload" },
        { status: 400 }
      );
    }

    const messageId = payload.id;
    const phone = payload.sender?.phone;
    const name = payload.sender?.name || phone;
    const messageType = payload.type;
    const text = payload.payload?.text || "";

    if (!phone || !messageId) {
      return NextResponse.json(
        { error: "Missing sender phone or message id" },
        { status: 400 }
      );
    }

    console.log("Incoming WhatsApp message:", {
      messageId,
      phone,
      name,
      messageType,
      text,
    });

    // ============================================================
    // 1. Find WhatsApp configuration
    // ============================================================

    const { data: configs, error: configError } =
      await supabaseAdmin
        .from("whatsapp_config")
        .select("id, user_id, account_id")
        .limit(10);

    if (configError) {
      console.error("WhatsApp config error:", configError);

      return NextResponse.json(
        { error: "Failed to find WhatsApp configuration" },
        { status: 500 }
      );
    }

    if (!configs || configs.length === 0) {
      console.error("No whatsapp_config found");

      return NextResponse.json(
        { error: "No WhatsApp configuration found" },
        { status: 404 }
      );
    }

    /*
     * For now we use the first configured WhatsApp account.
     *
     * Since your database currently has one WhatsApp number,
     * this is enough.
     */
    const config = configs[0];

    const accountId = config.account_id;
    const userId = config.user_id;

    if (!accountId || !userId) {
      console.error("WhatsApp config missing account_id/user_id", config);

      return NextResponse.json(
        { error: "WhatsApp configuration is incomplete" },
        { status: 500 }
      );
    }

    console.log("Using account:", accountId);

    // ============================================================
    // 2. Find existing contact
    // ============================================================

    let contact;

    const { data: existingContact, error: contactFindError } =
      await supabaseAdmin
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .eq("phone", phone)
        .maybeSingle();

    if (contactFindError) {
      console.error("Contact lookup error:", contactFindError);
    }

    if (existingContact) {
      contact = existingContact;

      // Update name if changed
      if (name && name !== existingContact.name) {
        await supabaseAdmin
          .from("contacts")
          .update({
            name,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingContact.id);
      }
    } else {
      // ============================================================
      // 3. Create contact
      // ============================================================

      const { data: newContact, error: contactCreateError } =
        await supabaseAdmin
          .from("contacts")
          .insert({
            account_id: accountId,
            user_id: userId,
            phone,
            name,
          })
          .select()
          .single();

      if (contactCreateError) {
        console.error(
          "Contact creation error:",
          contactCreateError
        );

        return NextResponse.json(
          { error: "Failed to create contact" },
          { status: 500 }
        );
      }

      contact = newContact;
    }

    console.log("Contact:", contact.id);

    // ============================================================
    // 4. Find conversation
    // ============================================================

    let conversation;

    const { data: existingConversation, error: conversationFindError } =
      await supabaseAdmin
        .from("conversations")
        .select("*")
        .eq("account_id", accountId)
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (conversationFindError) {
      console.error(
        "Conversation lookup error:",
        conversationFindError
      );
    }

    if (existingConversation) {
      conversation = existingConversation;
    } else {
      // ============================================================
      // 5. Create conversation
      // ============================================================

      const { data: newConversation, error: conversationCreateError } =
        await supabaseAdmin
          .from("conversations")
          .insert({
            account_id: accountId,
            user_id: userId,
            contact_id: contact.id,
          })
          .select()
          .single();

      if (conversationCreateError) {
        console.error(
          "Conversation creation error:",
          conversationCreateError
        );

        return NextResponse.json(
          { error: "Failed to create conversation" },
          { status: 500 }
        );
      }

      conversation = newConversation;
    }

    console.log("Conversation:", conversation.id);

    // ============================================================
    // 6. Prevent duplicate messages
    // ============================================================

    const { data: existingMessage } = await supabaseAdmin
      .from("messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("message_id", messageId)
      .maybeSingle();

    if (existingMessage) {
      console.log("Duplicate message ignored:", messageId);

      return NextResponse.json({
        success: true,
        duplicate: true,
      });
    }

    // ============================================================
    // 7. Insert message
    // ============================================================

    const contentType =
      messageType === "text"
        ? "text"
        : messageType === "image"
          ? "image"
          : messageType === "video"
            ? "video"
            : messageType === "audio"
              ? "audio"
              : messageType === "document"
                ? "document"
                : "text";

    const { data: newMessage, error: messageError } =
      await supabaseAdmin
        .from("messages")
        .insert({
          conversation_id: conversation.id,
          sender_type: "customer",
          content_type: contentType,
          content_text: text || null,
          message_id: messageId,
          status: "delivered",
          created_at: new Date(
            Number(body.timestamp)
          ).toISOString(),
        })
        .select()
        .single();

    if (messageError) {
      console.error("Message insert error:", messageError);

      return NextResponse.json(
        { error: "Failed to save message" },
        { status: 500 }
      );
    }

    console.log("Message saved:", newMessage.id);

    // ============================================================
    // 8. Update conversation
    // ============================================================

    const { error: conversationUpdateError } =
      await supabaseAdmin
        .from("conversations")
        .update({
          last_message_text: text || `[${messageType}]`,
          last_message_at: new Date(
            Number(body.timestamp)
          ).toISOString(),
          unread_count: (conversation.unread_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversation.id);

    if (conversationUpdateError) {
      console.error(
        "Conversation update error:",
        conversationUpdateError
      );
    }

    console.log("========== MESSAGE SAVED ==========");

    return NextResponse.json({
      success: true,
      messageId: newMessage.id,
      conversationId: conversation.id,
      contactId: contact.id,
    });
  } catch (error) {
    console.error("Gupshup webhook error:", error);

    return NextResponse.json(
      { error: "Invalid webhook request" },
      { status: 400 }
    );
  }
}