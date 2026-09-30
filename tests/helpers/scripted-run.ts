import { createScriptedModelClient } from "../../src/harness/scripted.ts";
import { capturing } from "./fake-model.ts";
import type { CapturedRequest } from "./fake-model.ts";
import { runScenario } from "./fixtures.ts";
import type { ConfigOverrides, DocSpec, ScenarioResult } from "./fixtures.ts";

/** A small corpus with real sentences, for scripted runs. */
export const SMALL_CORPUS: DocSpec[] = [
  {
    id: "01-survey",
    title: "Patron Survey",
    text: "# Patron Survey\n\nThe survey ran for four weeks in August. Most respondents asked for later hours on weekdays. Families with young children preferred Saturday mornings. Students wanted the study rooms open until ten.",
  },
  {
    id: "02-budget",
    title: "Budget Memo",
    text: "# Budget Memo\n\nEach extra evening costs about four hundred dollars in staff time. The reserve fund can cover a six-month trial. Utilities add a small amount in winter.",
  },
  {
    id: "03-staff",
    title: "Staff Notes",
    text: "# Staff Notes\n\nStaff are willing to rotate evening shifts. Two positions are currently vacant. The union contract requires two weeks' notice for schedule changes.",
  },
  {
    id: "04-letters",
    title: "Letters",
    text: "# Letters\n\nSeveral residents wrote in support of Thursday evenings. One letter raised concerns about parking after dark. A local business offered to sponsor a reading series.",
  },
  {
    id: "05-usage",
    title: "Usage Report",
    text: "# Usage Report\n\nGate counts peak between four and six in the afternoon. Computer use drops sharply after seven. Weekend visits have grown every year since 2022.",
  },
];

/** Runs the scripted model over SMALL_CORPUS (tick cap 20 unless overridden), capturing every request. */
export async function runScripted(
  names: string[],
  config: ConfigOverrides = {},
): Promise<ScenarioResult & { requests: CapturedRequest[] }> {
  const { client, requests } = capturing(createScriptedModelClient());
  const result = await runScenario({
    names,
    docs: SMALL_CORPUS,
    model: client,
    config: { ...config, run: { tick_cap: 20, ...config.run } },
    kickoff: "Check the board and introduce yourself before you start.",
  });
  return { ...result, requests };
}
