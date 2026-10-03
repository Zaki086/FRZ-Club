// Print pages have no app chrome: just the receipt.
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="bg-white">{children}</div>;
}
