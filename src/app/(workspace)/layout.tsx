export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Legacy route group kept for compatibility redirects.
  return <>{children}</>;
}
