export const metadata = {
  title: "Ardiles AI Platform",
  description: "Ardiles AI Platform backend and control center",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body
        style={{
          fontFamily: "Arial, sans-serif",
          margin: 0,
          background: "#f6f7f5",
          color: "#1e2520",
        }}
      >
        {children}
      </body>
    </html>
  );
}
