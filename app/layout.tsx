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
          <h1 className="font-serif text-4xl">New Waive</h1>
          <div
            style={{
              textAlign: "center",
              // background: "rgb(240, 240, 240)",
              padding: "0px 6px",
              marginTop: "6px",
              maxWidth: "992px",
              width: "fit-content",
              marginLeft: "auto",
              marginRight: "auto",
              color: "rgb(100, 100, 100)",
              // border: "1px solid rgb(200, 200, 200)",
            }}
            className="rounded-md"
          >
            Automated AI Media
          </div>
          <nav
            className="mt-2"
            style={{
              background: "rgb(240, 240, 240)",
              padding: "2px 10px",
              marginTop: "14px",
              maxWidth: "992px",
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            <Link href="/">Home</Link> | <Link href="/about">About</Link>
          </nav>
        </header>
        <main className="max-w-5xl mx-auto p-4">{children}</main>
        <footer className="border-t bg-white text-center p-2 text-xs">
          © The AI Times
        </footer>
      </body>
    </html>
  );
}
