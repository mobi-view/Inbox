import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    console.log("========== GUPSHUP WEBHOOK ==========");
    console.log(JSON.stringify(body, null, 2));
    console.log("=====================================");

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error("Gupshup webhook error:", error);

    return NextResponse.json(
      { error: "Invalid webhook request" },
      { status: 400 }
    );
  }
}