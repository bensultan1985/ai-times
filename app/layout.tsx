import "./globals.css";
import Link from "next/link";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body className="bg-zinc-100 text-zinc-900">
        <header className="border-b bg-white p-4 text-center">
          <h1 className="font-serif text-3xl">The Synthetic Chronicle</h1>
          <nav className="mt-2">
            <Link href="/">Home</Link> | <Link href="/about">About</Link>
          </nav>
        </header>
        <main className="max-w-5xl mx-auto p-4">{children}</main>
        <footer className="border-t bg-white text-center p-2 text-xs">
          © The Synthetic Chronicle
        </footer>
      </body>
    </html>
  );
}
