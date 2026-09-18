export const WEB_APP_BASELINE_PRESET = "web-app-baseline";

export const WEB_APP_BASELINE_GOAL =
  "Assess the web application's public baseline: safe route reachability, page titles and primary headings, discovered navigation coverage, and form or authentication boundaries. Propose separate approval scopes for interaction journeys, authentication, form submission, accessibility, responsiveness, performance, and security checks.";

export type GoalPreset = typeof WEB_APP_BASELINE_PRESET;

export type ResolvedGoal = {
  preset?: GoalPreset;
  text: string;
};

export function resolveGoal(goal: string): ResolvedGoal {
  if (goal.trim().toLowerCase() === WEB_APP_BASELINE_PRESET) {
    return { preset: WEB_APP_BASELINE_PRESET, text: WEB_APP_BASELINE_GOAL };
  }

  return { text: goal };
}

export function isWebAppBaselineGoal(goal: string): boolean {
  return goal === WEB_APP_BASELINE_GOAL;
}
