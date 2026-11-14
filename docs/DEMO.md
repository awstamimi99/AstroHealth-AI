# AstroHealth AI — Demo guide

AstroHealth AI is a research and educational prototype. All health, crew,
mission and simulation data is synthetic. It is not a medical device, is not
clinically validated, and is not affiliated with or endorsed by NASA.

## Start

1. Run `npm ci`, then `npm run test:release`.
2. Run `npm run serve` and open <http://localhost:8080/login.html>.
3. Use a demo username shown on the sign-in page and password `demo`.
4. For the main presentation, sign in as `medofficer` (role
   `medical_officer`). Use `haddad` or `chen` to show the astronaut view.

## Recommended demonstration

1. Show the Medical Officer overview and Crew Monitor.
2. Open Simulation Center, choose AH-03 and run Low Oxygen.
3. Show the labelled simulated readings and the resulting explainable alert.
4. Open Alerts, inspect its rule, evidence, provenance and audit trail, then
   acknowledge and resolve it.
5. Switch to an astronaut account to show role isolation, personal physical
   health, wellbeing, history and a printable report.
6. Explain that IndexedDB is the primary store and that the app remains usable
   from its local cache after one successful online visit.

## Restore the deterministic demo

Sign in as the Medical Officer, open Settings → Demo data, choose **Reset
synthetic demo data**, and type `RESET DEMO` exactly. The operation atomically
replaces this browser's local records with fresh seed data and signs out every
open app tab. It does not delete personal display preferences. The operation
cannot be undone and affects only the current browser/device.

## Presentation boundaries

- Do not describe demonstration thresholds as clinical guidance.
- Do not claim diagnosis, treatment advice, fitness-for-duty decisions, NASA
  endorsement, machine-learning prediction or real patient/astronaut data.
- The References page intentionally lists no sources until they have been
  independently verified.
- If a browser, screen reader or print path was not tested, state that plainly.
