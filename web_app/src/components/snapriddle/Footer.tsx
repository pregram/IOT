export default function Footer() {
  return (
    <footer
      className="safe-bottom mt-auto w-full border-t px-4 py-3"
      style={{ borderColor: 'var(--sr-line)' }}
    >
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-1 text-[10px] font-medium text-sr-3 sm:flex-row">
        <span>SnapRiddle</span>
        <span className="tracking-wide">Built for living-room showdowns 🏆</span>
      </div>
    </footer>
  );
}
