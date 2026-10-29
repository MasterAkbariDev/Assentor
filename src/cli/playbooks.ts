import path from "node:path";
import { PlaybookLibrary, type PlaybookLibraryLoadOptions } from "../playbooks/library.js";

/**
 * `assentor playbooks` and `run --playbook <id>` (task T03-04). Running a
 * playbook needs a real SeatStepRunner and a seat-to-team binding, neither of
 * which exists yet, so `--playbook` only validates the id.
 */

export interface PlaybookCommandOptions {
  /** Project whose `.assentor/playbooks` is the project layer. */
  projectPath: string;
  /** Overrides the user layer directory (tests). */
  userDir?: string;
  /** Overrides the built-in layer directory (tests). */
  builtinDir?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function loadPlaybooks(options: PlaybookCommandOptions): Promise<PlaybookLibrary> {
  const load: PlaybookLibraryLoadOptions = {
    projectPath: options.projectPath,
    userDir: options.userDir,
    builtinDir: options.builtinDir,
  };
  return PlaybookLibrary.load(load);
}

export async function listPlaybooks(options: PlaybookCommandOptions): Promise<number> {
  const library = await loadPlaybooks(options);
  for (const error of library.errors) {
    options.err(`skipped ${error.file} (${error.layer}): ${error.message}`);
  }
  const playbooks = library.list();
  if (playbooks.length === 0) {
    options.out("No playbooks");
    return 0;
  }
  const width = Math.max(...playbooks.map((playbook) => playbook.id.length));
  options.out(`${"ID".padEnd(width)}  READ-ONLY  LAYER`);
  for (const playbook of playbooks) {
    const layer = playbook.overrides ? `${playbook.layer} (overrides ${playbook.overrides})` : playbook.layer;
    options.out(`${playbook.id.padEnd(width)}  ${(playbook.readOnly ? "yes" : "no").padEnd(9)}  ${layer}`);
    options.out(`${" ".repeat(width)}  ${playbook.title}: ${playbook.description}`.trimEnd());
  }
  return 0;
}

/** Exit code for `run --playbook <id>`: 1 for an unknown id, and 1 for a valid one (nothing runs yet). */
export async function checkPlaybookRun(options: PlaybookCommandOptions & { id: string }): Promise<number> {
  const library = await loadPlaybooks(options);
  if (library.has(options.id)) {
    options.err(
      `Playbook "${options.id}" is valid, but running playbooks is not wired yet: ` +
        "there is no seat step runner or team binding to run its stages.",
    );
    return 1;
  }
  for (const error of library.errors) {
    if (path.basename(error.file, ".yaml") === options.id) {
      options.err(`Playbook "${options.id}" failed to load: ${error.message}`);
    }
  }
  const ids = library.list().map((playbook) => playbook.id);
  options.err(`Unknown playbook "${options.id}". Available: ${ids.length > 0 ? ids.join(", ") : "(none)"}`);
  return 1;
}
