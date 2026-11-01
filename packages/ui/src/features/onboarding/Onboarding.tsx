import { useState, type ReactNode } from "react";
import { disabledReason, useCallableMethods } from "../settings/access.js";
import { CliCheck } from "../settings/Diagnostics.js";

/**
 * First-run guide (T04-13), shown when there are no runs. The dismissal is a per-browser
 * flag in localStorage: `settings.save` takes only settings fields, so it cannot hold it.
 */
export const ONBOARDING_KEY = "assentor.onboardingDone";

function readDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "1");
  } catch {
    // Not persisted: the guide shows again on the next visit.
  }
}

const STEPS = ["Detect CLIs", "Keys", "Pick a playbook", "Done"] as const;
const LAST = STEPS.length - 1;

export function Onboarding() {
  const methods = useCallableMethods();
  const [done, setDone] = useState(readDone);
  const [step, setStep] = useState(0);
  if (done) return null;

  const finish = () => {
    markDone();
    setDone(true);
  };

  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        <p>Detect the CLIs Assentor can run. Detection starts local processes, so it needs a write connection.</p>
        <CliCheck disabledReason={disabledReason(methods, "env.detectClis")} />
      </>
    );
  } else if (step === 1) {
    body = (
      <p>
        Keys are optional when a CLI is already logged in. Settings lists the stored keys, but the web UI cannot add one yet:
        run <code>assentor keys add --help</code> in a terminal.
      </p>
    );
  } else if (step === 2) {
    body = (
      <p>
        Playbooks are reusable run recipes. List them with <code>assentor playbooks</code>. The web UI cannot start a run yet;
        start one with <code>assentor run "your goal"</code>.
      </p>
    );
  } else {
    body = <p>You are set. Runs started from the terminal appear in the sidebar as they begin. Finish to hide this guide.</p>;
  }

  return (
    <section aria-labelledby="onboarding-title" className="onboarding">
      <h2 id="onboarding-title">Set up Assentor</h2>
      <ol className="onboarding-steps" aria-label="Setup steps">
        {STEPS.map((name, index) => (
          <li
            key={name}
            aria-current={index === step ? "step" : undefined}
            className={index < step ? "is-done" : index === step ? "is-current" : undefined}
          >
            {name}
          </li>
        ))}
      </ol>
      <div className="onboarding-body">{body}</div>
      <div className="onboarding-nav">
        <button type="button" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          Back
        </button>
        {step < LAST ? (
          <button type="button" onClick={() => setStep((s) => s + 1)}>
            Next
          </button>
        ) : (
          <button type="button" onClick={finish}>
            Finish
          </button>
        )}
        <button type="button" className="link-button" onClick={finish}>
          Skip setup
        </button>
      </div>
    </section>
  );
}
