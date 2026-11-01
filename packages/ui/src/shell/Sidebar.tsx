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
  prompts: "Prompt library: browse and edit the prompts your seats use. Not built yet; for now they live in .assentor/prompts.",
  teams: "Teams: saved seat line-ups to start a run from. Not built yet; for now use the CLI.",
  playbooks: "Playbooks: reusable run recipes. Not built yet; for now use the CLI.",
};

export function EmptySection({ id, label }: { id: string; label: string }) {
  return (
    <section aria-label={label}>
      <h1 className="session-heading">{label}</h1>
      <p className="empty">{EMPTY[id]}</p>
    </section>
  );
}
