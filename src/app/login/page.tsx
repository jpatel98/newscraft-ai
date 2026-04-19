import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAppContext } from "@/lib/server/app-context";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { membership } = await getCurrentAppContext();
  const { next } = await searchParams;
  const safeNext = safeRedirectTarget(next);

  if (membership) {
    redirect(safeNext);
  }

  const generalSigninHref = `/auth/general?next=${encodeURIComponent(safeNext)}`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-8">
      <section className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-md)]">
        <h1 className="text-xl font-semibold text-[var(--fg)]">Sign in</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          Continue to the newsroom workspace with the general account.
        </p>

        <Link
          href={generalSigninHref}
          className="mt-5 inline-flex w-full items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fg)] px-4 py-2 text-sm font-medium text-white"
        >
          Continue as newsroom user
        </Link>
      </section>
    </main>
  );
}

