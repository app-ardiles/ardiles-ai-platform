export default function Home() {
  const tools = [
    "/api/stock/search",
    "/api/stock/variants",
    "/api/stock/detail",
    "/api/stock/by-location",
    "/api/stock/by-accsys",
    "/api/stock/location-summary",
    "/api/stock/status",
  ];

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "64px 24px" }}>
      <p style={{ fontSize: 13, letterSpacing: 1.4, textTransform: "uppercase" }}>
        Ardiles Divisi A1
      </p>
      <h1 style={{ fontSize: 42, marginBottom: 12 }}>Ardiles AI Platform</h1>
      <p style={{ fontSize: 18, lineHeight: 1.6, maxWidth: 700 }}>
        Backend awal untuk Sekar dan fondasi web control center. Stock API membaca
        hanya batch stok yang berstatus PUBLISHED.
      </p>

      <section
        style={{
          marginTop: 40,
          background: "white",
          borderRadius: 14,
          padding: 24,
          boxShadow: "0 8px 24px rgba(0,0,0,.06)",
        }}
      >
        <h2>Stock tools API</h2>
        <ul style={{ lineHeight: 1.9 }}>
          {tools.map((tool) => (
            <li key={tool}>
              <code>{tool}</code>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
