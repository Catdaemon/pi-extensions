import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

export type SelectedScopeMode = 'git_changes' | 'branch_diff' | 'whole_directory'

export type SelectedScope = {
  mode: SelectedScopeMode
  repoRoot?: string
  branch?: string
  baseRef?: string
  warning?: string
  summary: string
  details: string
}

function formatBlock(title: string, content: string) {
  return `${title}:\n${content.trim() || '(none)'}`
}

function normalizeLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function truncateLines(text: string, maxLines: number) {
  const lines = normalizeLines(text)
  if (lines.length <= maxLines) {
    return lines.join('\n') || '(none)'
  }

  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
}

function normalizeFocus(extraFocus?: string) {
  const trimmed = extraFocus?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function renderScopeContext(scope: SelectedScope, extraFocus?: string) {
  const lines = ['Selected scope:', `- mode: ${scope.mode}`, `- summary: ${scope.summary}`]
  const focus = normalizeFocus(extraFocus)

  if (scope.repoRoot) {
    lines.push(`- repo root: ${scope.repoRoot}`)
  }

  if (scope.branch) {
    lines.push(`- branch: ${scope.branch}`)
  }

  if (scope.baseRef) {
    lines.push(`- base ref: ${scope.baseRef}`)
  }

  if (scope.warning) {
    lines.push('', 'Preflight warning:', `- ${scope.warning}`)
  }

  if (focus) {
    lines.push('', 'Additional user focus:', `- ${focus}`)
  }

  lines.push('', 'Preflight details:', scope.details)
  return lines.join('\n')
}

async function exec(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]) {
  return pi.exec('git', args, { cwd: ctx.cwd })
}

async function execText(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]) {
  const result = await exec(pi, ctx, args)
  return (result.stdout || result.stderr || '').trim()
}

async function isGitRepo(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const result = await exec(pi, ctx, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) {
    return null
  }

  return result.stdout.trim()
}

async function getBranch(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const branch = await execText(pi, ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return branch || 'HEAD'
}

async function getStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  return execText(pi, ctx, ['status', '--short', '--untracked-files=all', '--ignore-submodules=none'])
}

async function getDiffStat(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]) {
  const text = await execText(pi, ctx, ['diff', '--stat', ...args])
  return text || '(none)'
}

async function getNameOnly(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]) {
  const text = await execText(pi, ctx, ['diff', '--name-only', ...args])
  return text || '(none)'
}

async function hasDiff(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]) {
  const result = await exec(pi, ctx, ['diff', '--quiet', ...args])
  return result.code === 1
}

async function resolveBaseRef(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  for (const candidate of ['main', 'origin/main', 'master', 'origin/master']) {
    const result = await exec(pi, ctx, ['rev-parse', '--verify', candidate])
    if (result.code === 0) {
      return candidate
    }
  }

  return undefined
}

export async function resolveSelectedScope(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<SelectedScope> {
  const repoRoot = await isGitRepo(pi, ctx)
  if (!repoRoot) {
    return {
      mode: 'whole_directory',
      summary: 'Not in a git repository, so the review will cover the current working directory.',
      details: formatBlock('Working directory', ctx.cwd),
    }
  }

  const branch = await getBranch(pi, ctx)
  const status = await getStatus(pi, ctx)

  if (status) {
    const stagedStat = await getDiffStat(pi, ctx, ['--cached', '--'])
    const unstagedStat = await getDiffStat(pi, ctx, ['--'])

    return {
      mode: 'git_changes',
      repoRoot,
      branch,
      summary: 'Use the staged and unstaged git changes in the current worktree.',
      details: [
        formatBlock('Git status', truncateLines(status, 80)),
        formatBlock('Staged diff stat', stagedStat),
        formatBlock('Unstaged diff stat', unstagedStat),
      ].join('\n\n'),
    }
  }

  if (branch !== 'main' && branch !== 'master') {
    const baseRef = await resolveBaseRef(pi, ctx)
    if (baseRef) {
      const mergeBase = await execText(pi, ctx, ['merge-base', 'HEAD', baseRef])
      if (mergeBase && (await hasDiff(pi, ctx, [`${mergeBase}..HEAD`, '--']))) {
        const range = `${mergeBase}..HEAD`
        const diffStat = await getDiffStat(pi, ctx, [range, '--'])
        const changedFiles = await getNameOnly(pi, ctx, [range, '--'])

        return {
          mode: 'branch_diff',
          repoRoot,
          branch,
          baseRef,
          summary: `No local worktree changes were found, so use all changes on ${branch} since ${baseRef}.`,
          details: [
            formatBlock('Merge base range', range),
            formatBlock('Diff stat since base', diffStat),
            formatBlock('Changed files since base', truncateLines(changedFiles, 120)),
          ].join('\n\n'),
        }
      }
    }
  }

  return {
    mode: 'whole_directory',
    repoRoot,
    branch,
    warning:
      branch === 'main' || branch === 'master'
        ? `Git repo detected, but there are no staged or unstaged changes and you are on ${branch}. Proceeding with the whole directory.`
        : 'Git repo detected, but no diff against a usable main/master base was found. Proceeding with the whole directory.',
    summary:
      branch === 'main' || branch === 'master'
        ? `No local changes were found on ${branch}, so the review will cover the whole directory.`
        : 'No local changes were found and no branch diff against main/master was detected, so the review will cover the whole directory.',
    details: [
      formatBlock('Git branch', branch),
      formatBlock('Git status', '(clean)'),
      formatBlock('Working directory', ctx.cwd),
    ].join('\n\n'),
  }
}
