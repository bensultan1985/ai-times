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
        <header className=" bg-white pt-4 pl-4 pr-4 text-center">
          <h1 className="font-serif text-4xl">The AI Times</h1>
          <nav className="mt-2">
            <Link href="/">Home</Link> | <Link href="/about">About</Link>
          </nav>
          <div
            style={{
              textAlign: "center",
              background: "rgb(240, 240, 240)",
              padding: "4px 10px",
              marginTop: "12px",
              maxWidth: "992px",
              marginLeft: "auto",
              marginRight: "auto",
            }}
            className="rounded-md"
          >
            AI news, generated daily by AI.
          </div>
        </header>
        <main className="max-w-5xl mx-auto p-4">{children}</main>
        <footer className="border-t bg-white text-center p-2 text-xs">
          © The AI Times
        </footer>
      </body>
    </html>
  );
}
