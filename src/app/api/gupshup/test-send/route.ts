import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { destination, text } = await request.json();

    if (!destination || !text) {
      return NextResponse.json(
        { error: "destination and text are required" },
        { status: 400 }
      );
    }

    const formData = new URLSearchParams();

    formData.append("channel", "whatsapp");
    formData.append("source", process.env.GUPSHUP_SOURCE_NUMBER!);
    formData.append("destination", destination);
    formData.append("src.name", process.env.GUPSHUP_APP_NAME!);

    formData.append(
      "message",
      JSON.stringify({
        type: "text",
        text: text,
      })
    );

    const response = await fetch(
      "https://api.gupshup.io/wa/api/v1/msg",
      {
        method: "POST",
        headers: {
          apikey: process.env.GUPSHUP_API_KEY!,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
      }
    );

    const data = await response.json();

    console.log("Gupshup response:", data);

    return NextResponse.json(data, {
      status: response.status,
    });
  } catch (error) {
    console.error("Gupshup error:", error);

    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}