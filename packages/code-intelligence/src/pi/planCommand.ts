import type { ContextPack } from '../retrieval/contextPack.ts'
import { formatPlanningContextMessage } from './planningIntegration.ts'

export type PlanCommandContext = {
  task: string
  contextPack?: ContextPack
  warning?: string
}

export function buildPlanCommandPrompt(input: PlanCommandContext): string {
  const task = input.task.trim()
  const context = input.contextPack ? formatPlanningContextMessage(input.contextPack) : undefined
  const warning = input.warning ? `\n\nCode intelligence warning:\n${input.warning}` : ''

  return `You are in /plan mode. Do not edit files. Your job is to turn the user's initial task into a precise, stress-tested implementation prompt for a later coding run.

Initial task:
${task || '(No task supplied yet; start by asking for the task.)'}
${warning}
${context ? `\n\n${context}` : ''}

Planning workflow:
1. Research the codebase before committing to a plan. Use local code intelligence first: code_intelligence_search for conceptual discovery, code_intelligence_impact for exported APIs/shared components/routes/schemas/hooks or unclear test coverage, then read exact files only as needed. Keep retrieved context internal; summarize only the relevant facts.
2. Interview the user. Ask a small set of targeted clarifying questions when requirements, scope, acceptance criteria, data/API contracts, UX behavior, migration/backfill needs, rollout, or test expectations are ambiguous. Challenge risky assumptions and call out tradeoffs. Stop and wait for answers after asking questions.
3. If enough information is already available, say so and proceed; otherwise continue the interview until the user confirms the requirements are complete enough.
4. Stress-test the plan against the existing repo: related code paths, callers/callees, tests/counterparts, conventions, hard rules/learnings, failure modes, edge cases, backwards compatibility, and smallest safe rollout.
5. Produce a final implementation prompt, not code. The prompt should be ready to paste back into Pi for execution with the todo extension.

Final output format after requirements are clear:
- Title
- Goal
- Non-goals / out of scope
- Relevant context and files to inspect
- Constraints and repo conventions
- Assumptions confirmed with the user
- Milestones with concrete subtasks
- Acceptance criteria and verification commands/tests
- Risks, edge cases, and rollback/cleanup notes
- Ready-to-run implementation prompt

Implementation prompt requirements:
- Tell the coding agent to create and maintain a todo_write list early.
- Include clear milestones and subtasks, but leave low-level sequencing to the implementing agent when code inspection changes the details.
- Include acceptance criteria, tests/checks to run, and a stop condition.
- Include explicit scope boundaries and files/areas likely relevant.
- Require the agent to use code_intelligence_search/impact before broad exploration for non-trivial code changes.
- Require no file edits during planning unless the user explicitly asks to save the plan.`.trim()
}
