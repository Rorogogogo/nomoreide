/** Probe: what the reference's own sanitizeProjectName does, for inputs the
 * Rust port is asserted against. */
import { sanitizeProjectName } from "../../src/core/repo-create.js";

const cases = [
  "my-app", "app_2.0", "my  app", "a/b\\c", "a???b", "../../etc/passwd",
  "/absolute/path", ".hidden", "--name--", "name.", "", "   ", "///", "...",
  "Demo App", "-.-x", "x-", "x.", ".-.", "a..b", "  spaced  ", "ÜNICODE",
  "a-b--c", "-", ".", "taken", "empty", "..hidden", "name..", "-lead",
];
for (const input of cases) {
  let answer: string;
  try {
    answer = JSON.stringify(sanitizeProjectName(input));
  } catch (error) {
    answer = `THROWS(${error instanceof Error ? error.message : String(error)})`;
  }
  console.log(`${JSON.stringify(input)} -> ${answer}`);
}
