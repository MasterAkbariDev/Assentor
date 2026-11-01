import { SECTIONS, type Route } from "./route.js";

export function SectionNav({ route }: { route: Route }) {
  return (
    <nav className="section-nav" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={`#/${s.id}`} aria-current={route === s.id ? "page" : undefined}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}

const EMPTY: Record<string, string> = {
  settings: "Settings: providers, models and budgets. Not built yet; for now edit the config file or use the TUI.",
};

export function EmptySection({ id, label }: { id: string; label: string }) {
  return (
    <section aria-label={label}>
      <h1 className="session-heading">{label}</h1>
      <p className="empty">{EMPTY[id]}</p>
    </section>
  );
}
