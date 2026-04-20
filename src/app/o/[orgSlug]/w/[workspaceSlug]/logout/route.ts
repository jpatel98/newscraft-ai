import { redirect } from "next/navigation";
import { clearSession } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await clearSession();
  redirect("/login");
}
