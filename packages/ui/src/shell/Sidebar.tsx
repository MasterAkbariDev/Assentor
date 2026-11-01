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
